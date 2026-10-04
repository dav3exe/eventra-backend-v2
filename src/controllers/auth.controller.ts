import { Request, Response } from 'express'
import { env } from '../config/keys.js'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import { generateOTP, sanitizeUser } from '../utils/helpers.js'
import User from '../models/user.model.js'
import { EmailService } from '../services/email/email.service.js'
import { GoogleAuthService } from '../services/google-auth.service.js'

const OTP_TTL_MS = 15 * 60 * 1000 // 15 minutes, matches the email copy

// Organizer auth lives under its own branded route tree (/auth/organizer/*)
// rather than the attendee one (/auth/*) — same account system, different
// shell (see authPath in the client). Points at the real verify-otp page —
// this used to point at /organizer/auth/verify-email and /auth/verify-email,
// neither of which is an actual route, so clicking "Verify & Join" in the
// email led nowhere. The email query param is a fallback for VerifyOtp
// (see its email = location.state?.email ?? searchParams.get('email')),
// since a fresh page load from an email client has no router state to read.
function verifyEmailLink(email: string, role: 'attendee' | 'organizer') {
  const path = role === 'organizer' ? '/auth/organizer/verify-otp' : '/auth/verify-otp'
  return `${env.CLIENT_URL}${path}?email=${encodeURIComponent(email)}`
}

export const register = tryCatchWrapper(async (req: Request, res: Response) => {
  const { fullname, email, password, phone, role } = req.body
  const resolvedRole = role === 'organizer' ? 'organizer' : 'attendee'

  const existingUser = await User.findOne({ email })
  if (existingUser) {
    if (existingUser.isVerified) {
      return sendTsRestError(res, 409, 'An account with this email already exists')
    }

    // Signed up before but never came back to verify — the old behavior
    // dead-ended here with just "email already exists" and no way back to
    // the OTP screen. Treat this the same as a fresh registration instead:
    // send a new code and let the client's normal onSuccess handler route
    // them to verify-otp, exactly like first-time signup does.
    const freshOtp = generateOTP()
    existingUser.emailVerificationOTP = freshOtp
    existingUser.emailVerificationOTPExpiry = new Date(Date.now() + OTP_TTL_MS)
    await existingUser.save()

    await EmailService.sendVerifyAccountEmail({
      user: existingUser,
      otp: freshOtp,
      link: verifyEmailLink(email, existingUser.role === 'organizer' ? 'organizer' : 'attendee'),
    })

    return sendTsRestSuccess(res, 200, {
      success: true,
      message: 'This email is already registered but not verified yet. Check your email for a fresh code.',
      body: { email: existingUser.email },
    })
  }

  const otp = generateOTP()

  const user = await User.create({
    fullname,
    email,
    password,
    phone,
    role: resolvedRole,
    emailVerificationOTP: otp,
    emailVerificationOTPExpiry: new Date(Date.now() + OTP_TTL_MS),
  })

  await EmailService.sendVerifyAccountEmail({
    user,
    otp,
    link: verifyEmailLink(email, resolvedRole),
  })

  return sendTsRestSuccess(res, 201, {
    success: true,
    message: 'Account created. Check your email for a verification code.',
    body: { email: user.email },
  })
})

export const verifyEmail = tryCatchWrapper(async (req: Request, res: Response) => {
  const { email, otp } = req.body

  const user = await User.findOne({ email }).select('+emailVerificationOTP +emailVerificationOTPExpiry')
  if (!user) {
    return sendTsRestError(res, 404, 'No account found with this email')
  }

  if (user.isVerified) {
    return sendTsRestError(res, 400, 'This account is already verified')
  }

  if (!user.emailVerificationOTP || !user.emailVerificationOTPExpiry) {
    return sendTsRestError(res, 400, 'No verification code was requested for this account')
  }

  if (user.emailVerificationOTPExpiry.getTime() < Date.now()) {
    return sendTsRestError(res, 400, 'Verification code has expired. Please request a new one')
  }

  if (user.emailVerificationOTP !== otp) {
    return sendTsRestError(res, 400, 'Invalid verification code')
  }

  user.isVerified = true
  user.emailVerificationOTP = undefined
  user.emailVerificationOTPExpiry = undefined
  await user.save()

  req.session.userId = user._id.toString()
  req.session.role = user.role
  // Only meaningful for an admin account (mirrors login's own comment) —
  // without this, an admin who verifies via an inviteAdmin email lands in
  // a session with adminRole unset, which requireAdminTier defaults to the
  // HIGHEST tier ('owner'), not the lowest. That would briefly hand a
  // freshly-invited 'admin'/'support' account owner-level access to
  // owner-only routes until their next real login re-sets it correctly.
  req.session.adminRole = user.adminRole

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Email verified successfully',
    body: sanitizeUser(user.toObject()),
  })
})

export const resendOtp = tryCatchWrapper(async (req: Request, res: Response) => {
  const { email } = req.body

  const user = await User.findOne({ email })
  if (!user) {
    return sendTsRestError(res, 404, 'No account found with this email')
  }

  if (user.isVerified) {
    return sendTsRestError(res, 400, 'This account is already verified')
  }

  const otp = generateOTP()
  user.emailVerificationOTP = otp
  user.emailVerificationOTPExpiry = new Date(Date.now() + OTP_TTL_MS)
  await user.save()

  await EmailService.sendVerifyAccountEmail({
    user,
    otp,
    link: verifyEmailLink(email, user.role === 'organizer' ? 'organizer' : 'attendee'),
  })

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'A new verification code has been sent to your email',
  })
})

export const googleAuth = tryCatchWrapper(async (req: Request, res: Response) => {
  const { accessToken, role } = req.body

  let profile
  try {
    profile = await GoogleAuthService.verifyAccessToken(accessToken)
  } catch (error: any) {
    return sendTsRestError(res, 401, error.message || 'Google sign-in failed')
  }

  if (!profile.emailVerified) {
    return sendTsRestError(res, 401, "Your Google account's email isn't verified")
  }

  let user = await User.findOne({ googleId: profile.sub })

  if (!user) {
    // Someone who registered normally with this email, now trying Google
    // for the first time — link it to the existing account rather than
    // creating a second, disconnected one with the same email address.
    user = await User.findOne({ email: profile.email })
    if (user) {
      user.googleId = profile.sub
      if (!user.avatarUrl && profile.picture) user.avatarUrl = profile.picture
      await user.save()
    }
  }

  if (!user) {
    user = await User.create({
      fullname: profile.name,
      email: profile.email,
      googleId: profile.sub,
      avatarUrl: profile.picture,
      // Only matters for a brand-new account — if this email already
      // exists (linked above) we keep whatever role it already has.
      // "Sign up with Google" on the organizer register page sends
      // role: 'organizer' here so it doesn't silently create an
      // attendee account instead.
      role: role === 'organizer' ? 'organizer' : 'attendee',
      // Google already verified this email address — our own OTP flow
      // would be redundant friction, not extra security.
      isVerified: true,
    })
  }

  if (user.isDeleted) {
    return sendTsRestError(res, 403, 'This account has been deleted. Contact support for help')
  }

  if (user.isSuspended) {
    return sendTsRestError(res, 403, 'This account has been suspended. Contact support for help')
  }

  req.session.userId = user._id.toString()
  req.session.role = user.role

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Signed in with Google',
    body: sanitizeUser(user.toObject()),
  })
})

export const login = tryCatchWrapper(async (req: Request, res: Response) => {
  const { email, password } = req.body

  const user = await User.findOne({ email }).select('+password')
  if (!user) {
    return sendTsRestError(res, 401, 'Invalid email or password')
  }

  if (user.isDeleted) {
    return sendTsRestError(res, 403, 'This account has been deleted. Contact support for help')
  }

  if (user.isSuspended) {
    return sendTsRestError(res, 403, 'This account has been suspended. Contact support for help')
  }

  if (!user.password) {
    return sendTsRestError(res, 401, 'This account uses Google Sign-In. Continue with Google instead.')
  }

  const passwordMatches = await user.matchPassword(password)
  if (!passwordMatches) {
    return sendTsRestError(res, 401, 'Invalid email or password')
  }

  if (!user.isVerified) {
    return sendTsRestError(res, 403, 'Please verify your email before logging in')
  }

  req.session.userId = user._id.toString()
  req.session.role = user.role
  // Only meaningful for an admin account — undefined for everyone else,
  // which is exactly what requireAdminTier expects (see its own comment
  // on why a missing value there defaults to the highest tier, not the
  // lowest).
  req.session.adminRole = user.adminRole

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Logged in successfully',
    body: sanitizeUser(user.toObject()),
  })
})

export const logout = tryCatchWrapper(async (req: Request, res: Response) => {
  req.session.destroy(err => {
    if (err) {
      return sendTsRestError(res, 500, 'Could not log out, please try again')
    }
    res.clearCookie('_evtSessionId')
    return sendTsRestSuccess<undefined>(res, 200, {
      success: true,
      message: 'Logged out successfully',
    })
  })
})

export const me = tryCatchWrapper(async (req: Request, res: Response) => {
  const user = await User.findById(req.session.userId).lean()
  if (!user) {
    return sendTsRestError(res, 404, 'User not found')
  }
   res.set('Cache-Control', 'no-store')

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Current user fetched',
    body: sanitizeUser(user),
  })
})

export const forgotPassword = tryCatchWrapper(async (req: Request, res: Response) => {
  const { email } = req.body

  const user = await User.findOne({ email })

  // Same response whether or not the account exists — avoids leaking which emails are registered.
  const genericResponse = () =>
    sendTsRestSuccess<undefined>(res, 200, {
      success: true,
      message: 'If an account exists for this email, a reset code has been sent',
    })

  if (!user) {
    return genericResponse()
  }

  const otp = generateOTP()
  user.passwordResetOTP = otp
  user.passwordResetOTPExpiry = new Date(Date.now() + OTP_TTL_MS)
  await user.save()

  await EmailService.sendPasswordResetEmail({ user, otp })

  return genericResponse()
})

export const resetPassword = tryCatchWrapper(async (req: Request, res: Response) => {
  const { email, otp, newPassword } = req.body

  const user = await User.findOne({ email }).select('+passwordResetOTP +passwordResetOTPExpiry')
  if (!user) {
    return sendTsRestError(res, 404, 'No account found with this email')
  }

  if (!user.passwordResetOTP || !user.passwordResetOTPExpiry) {
    return sendTsRestError(res, 400, 'No password reset was requested for this account')
  }
  if (user.passwordResetOTPExpiry.getTime() < Date.now()) {
    return sendTsRestError(res, 400, 'Reset code has expired. Please request a new one')
  }
  if (user.passwordResetOTP !== otp) {
    return sendTsRestError(res, 400, 'Invalid reset code')
  }

  user.password = newPassword
  user.passwordResetOTP = undefined
  user.passwordResetOTPExpiry = undefined
  await user.save()

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Password reset successfully. You can now log in',
  })
})

// Checks a password-reset OTP on its own, before the frontend shows the
// new-password screen. Deliberately does NOT clear passwordResetOTP/Expiry
// on success — that only happens once resetPassword actually consumes it,
// so the same code the user just verified here still works on the final
// submit instead of being invalidated a step early.
export const verifyResetOtp = tryCatchWrapper(async (req: Request, res: Response) => {
  const { email, otp } = req.body

  const user = await User.findOne({ email }).select('+passwordResetOTP +passwordResetOTPExpiry')
  if (!user) {
    return sendTsRestError(res, 404, 'No account found with this email')
  }

  if (!user.passwordResetOTP || !user.passwordResetOTPExpiry) {
    return sendTsRestError(res, 400, 'No password reset was requested for this account')
  }
  if (user.passwordResetOTPExpiry.getTime() < Date.now()) {
    return sendTsRestError(res, 400, 'Reset code has expired. Please request a new one')
  }
  if (user.passwordResetOTP !== otp) {
    return sendTsRestError(res, 400, 'Invalid reset code')
  }

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Code verified',
  })
})

/**
 * Lets a logged-in user who was created with mustSetPassword (currently
 * only inviteAdmin — see its doc comment) actually pick their own
 * password. Session-gated rather than OTP-gated: verifyEmail already
 * established their session, so re-asking for a code here would just be
 * friction, not real security — this endpoint only ever touches the
 * account already attached to the caller's own session.
 */
export const setPassword = tryCatchWrapper(async (req: Request, res: Response) => {
  const { newPassword } = req.body as { newPassword: string }

  const user = await User.findById(req.session.userId)
  if (!user) {
    return sendTsRestError(res, 404, 'User not found')
  }

  user.password = newPassword
  user.mustSetPassword = false
  await user.save()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Password set successfully',
    body: sanitizeUser(user.toObject()),
  })
})
