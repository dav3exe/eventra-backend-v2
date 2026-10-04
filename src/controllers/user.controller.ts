import { Request, Response } from 'express'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import { sanitizeUser } from '../utils/helpers.js'
import Order from '../models/order.model.js'
import User from '../models/user.model.js'
import { CloudinaryService } from '../services/cloudinary.service.js'

export const uploadAvatar = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!req.file) {
    return sendTsRestError(res, 400, 'No image file provided (expected field name "image")')
  }

  const user = await User.findById(req.session.userId).select('+avatarPublicId')
  if (!user) {
    return sendTsRestError(res, 404, 'User not found')
  }

  const previousPublicId = user.avatarPublicId

  let uploaded
  try {
    uploaded = await CloudinaryService.uploadAvatar(req.file.buffer)
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Avatar upload failed')
  }

  user.avatarUrl = uploaded.url
  user.avatarPublicId = uploaded.publicId
  await user.save()

  // Best-effort — the new avatar is already saved either way, so a failed
  // cleanup here shouldn't turn into a failed request for the user.
  if (previousPublicId) {
    CloudinaryService.deleteImage(previousPublicId)
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Avatar updated',
    body: sanitizeUser(user.toObject()),
  })
})

export const updateProfile = tryCatchWrapper(async (req: Request, res: Response) => {
  const { fullname, phone, city, notificationPreferences,adminNotificationPreferences, currencyPreference, currentPassword, newPassword } =
    req.body as {
      fullname?: string
      phone?: string
      city?: string
      notificationPreferences?: Partial<{ eventReminders: boolean; weeklyPicks: boolean; organizerUpdates: boolean }>
      adminNotificationPreferences?: Partial<{ approvals: boolean; refunds: boolean; reports: boolean }>
      currencyPreference?: 'Naira' | 'Dollar' | 'Cedis' | 'Pound'
      currentPassword?: string
      newPassword?: string
    }

  const user = await User.findById(req.session.userId).select('+password')
  if (!user) {
    return sendTsRestError(res, 404, 'User not found')
  }

  if (fullname) user.fullname = fullname
  if (phone) user.phone = phone
  if (city) user.city = city
  // Partial merge, not overwrite — a toggle for one preference shouldn't
  // reset the other two to their schema defaults.
  if (notificationPreferences) {
    user.notificationPreferences = { ...user.notificationPreferences, ...notificationPreferences }
  }
  if (adminNotificationPreferences) {
    user.adminNotificationPreferences = { ...user.adminNotificationPreferences, ...adminNotificationPreferences }
  }
  // Display-only preference, available to every role — never converts or
  // rewrites any stored price, just remembers which currency to render
  // this viewer's prices in (see resolveViewerCurrency, lib/viewerCurrency.ts).
  if (currencyPreference) user.currencyPreference = currencyPreference

  if (newPassword) {
    if (!currentPassword) {
      return sendTsRestError(res, 400, 'currentPassword is required to set a new password')
    }
    const matches = await user.matchPassword(currentPassword)
    if (!matches) {
      return sendTsRestError(res, 401, 'Current password is incorrect')
    }
    user.password = newPassword
  }

  await user.save()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Profile updated',
    body: sanitizeUser(user.toObject()),
  })
})

export const saveEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId } = req.params
  await User.updateOne({ _id: req.session.userId }, { $addToSet: { savedEvents: eventId } })

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Event saved',
  })
})

export const unsaveEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId } = req.params
  await User.updateOne({ _id: req.session.userId }, { $pull: { savedEvents: eventId } })

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Event removed from saved events',
  })
})

export const followOrganizer = tryCatchWrapper(async (req: Request, res: Response) => {
  const { organizerId } = req.params

  const organizer = await User.findOne({ _id: organizerId, role: 'organizer' })
  if (!organizer) {
    return sendTsRestError(res, 404, 'Organizer not found')
  }

  await User.findByIdAndUpdate(req.session.userId, { $addToSet: { following: organizerId } })

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Now following this organizer',
  })
})

export const unfollowOrganizer = tryCatchWrapper(async (req: Request, res: Response) => {
  const { organizerId } = req.params

  await User.findByIdAndUpdate(req.session.userId, { $pull: { following: organizerId } })

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Unfollowed this organizer',
  })
})

export const listSavedEvents = tryCatchWrapper(async (req: Request, res: Response) => {
  const user = await User.findById(req.session.userId)
    .populate({
      path: 'savedEvents',
      match: { status: { $in: ['approved', 'postponed'] } },
      select: 'title slug startDate venue coverImage type category minPrice isPromoted',
      populate: { path: 'category', select: 'name slug' },
    })
    .lean()

  if (!user) {
    return sendTsRestError(res, 404, 'User not found')
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Saved events fetched',
    body: user.savedEvents,
  })
})

export const listOrderHistory = tryCatchWrapper(async (req: Request, res: Response) => {
  const orders = await Order.find({ buyer: req.session.userId })
    .populate('event', 'title slug startDate coverImage')
    .sort({ createdAt: -1 })
    .lean()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Order history fetched',
    body: orders,
  })
})
