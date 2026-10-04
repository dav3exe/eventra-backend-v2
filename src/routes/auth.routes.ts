import { Router } from 'express'
import { forgotPassword, googleAuth, login, logout, me, register, resendOtp, resetPassword, setPassword, verifyEmail, verifyResetOtp } from '../controllers/auth.controller.js'
import { verifySession } from '../middlewares/auth.middleware.js'
import { customRateLimiter, strictLimiter } from '../middlewares/rate-limit.middleware.js'
import { validateFormData } from '../middlewares/schema.middleware.js'
import { forgotPasswordSchema, googleAuthSchema, loginSchema, registerSchema, resendOtpSchema, resetPasswordSchema, setPasswordSchema, verifyEmailSchema, verifyResetOtpSchema } from '../validators/schema-validation.js'

const router = Router()

router.post('/register', customRateLimiter(5), validateFormData(registerSchema), register)

router.post('/verify-email', customRateLimiter(10), validateFormData(verifyEmailSchema), verifyEmail)

router.post('/resend-otp', strictLimiter, validateFormData(resendOtpSchema), resendOtp)

router.post('/login', strictLimiter, validateFormData(loginSchema), login)

// Google sign-in gets its own, higher limit: it was sharing the 5-per-15-minutes
// strictLimiter with login and password reset, so people on a shared IP
// (campus, office, mobile network) were blocked after a few sign-ins.
router.post('/google', customRateLimiter(30), validateFormData(googleAuthSchema), googleAuth)

router.post('/forgot-password', strictLimiter, validateFormData(forgotPasswordSchema), forgotPassword)

router.post('/verify-reset-otp', strictLimiter, validateFormData(verifyResetOtpSchema), verifyResetOtp)

router.post('/reset-password', strictLimiter, validateFormData(resetPasswordSchema), resetPassword)

router.post('/set-password', strictLimiter, validateFormData(setPasswordSchema), setPassword)

router.post('/logout', verifySession, logout)

router.get('/me', verifySession, me)

export default router
