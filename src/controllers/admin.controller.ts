import crypto from 'crypto'
import { Request, Response } from 'express'
import mongoose from 'mongoose'
import { getPromotionPackage } from '../config/promotion-packages.js'
import logger from '../config/logger.js'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import { buildPaginationMeta, escapeRegExp, generateOTP, getPagination, sanitizeUser } from '../utils/helpers.js'
import { invalidateUserSessions } from '../services/session.service.js'
import { initiateOrderPayout } from '../jobs/payout.job.js'
import { logAdminActivity } from '../services/admin-activity.service.js'
import Event from '../models/event.model.js'
import Order from '../models/order.model.js'
import RefundRequest from '../models/refund-request.model.js'
import Report from '../models/report.model.js'
import Ticket from '../models/ticket.model.js'
import TicketType from '../models/ticket-type.model.js'
import User from '../models/user.model.js'
import AdminActivityLog, { type AdminActivityType } from '../models/admin-activity-log.model.js'
import PaymentDispute from '../models/payment-dispute.model.js'
import PlatformSettings, { getCurrentCommissionRate } from '../models/platform-settings.model.js'
import { EmailService } from '../services/email/email.service.js'
import { NotificationService } from '../services/notification.service.js'
import { PaystackService } from '../services/paystack.service.js'
import {
  applyRate,
  applyTicketTypeRate,
  EVENT_LEDGER_CURRENCY,
  getDisplayRate,
  resolveViewerCurrency,
  TICKET_TYPE_CURRENCY,
} from '../services/currency/viewer-currency.js'
import Enquiry from '../models/enquiry.model.js'

// Matches OTP_TTL_MS in auth.controller.ts — used for the admin-invite OTP
// sent to a brand-new admin account so they can set their own password.
const OTP_TTL_MS = 15 * 60 * 1000

export const listUsers = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)

  // Admin accounts never show up on this page — it's meant for the
  // attendee/organizer accounts an admin manages, not admin peers. This
  // holds regardless of the `role` query param (there's no "admin" option
  // in the UI's filter chips, but excluding it unconditionally here means
  // an admin account can never leak through even via a hand-crafted request).
  const filter: Record<string, any> = { role: { $ne: 'admin' } }
  if (req.query.role === 'attendee' || req.query.role === 'organizer') {
    filter.role = req.query.role
  }
  // Powers the All/Active/Suspended/Deleted filter chips on the admin
  // Users page. A soft-deleted account is excluded from every filter
  // except the explicit "deleted" one — same reasoning as admin accounts
  // above, this page is for accounts an admin actively manages, and a
  // deleted account showing back up under "All" would be confusing.
  if (req.query.status === 'active') {
    filter.isSuspended = false
    filter.isDeleted = { $ne: true }
  } else if (req.query.status === 'suspended') {
    filter.isSuspended = true
    filter.isDeleted = { $ne: true }
  } else if (req.query.status === 'deleted') {
    filter.isDeleted = true
  } else {
    filter.isDeleted = { $ne: true }
  }
  if (req.query.q && typeof req.query.q === 'string') {
    const term = new RegExp(escapeRegExp(req.query.q), 'i')
    filter.$or = [{ fullname: term }, { email: term }]
  }

  const [users, total] = await Promise.all([
    User.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ])

  // ORDERS / SPENT columns on the Users table — computed from this
  // account's paid orders as a buyer. Guest checkouts have no `buyer`, so
  // this is genuinely scoped to registered accounts, not raw ticket sales.
  // partially_refunded is included too (same convention as
  // getPlatformStats/organizer payouts elsewhere in this file) — "spent"
  // reflects what the order actually charged, not adjusted for a later
  // partial refund.
  const userIds = users.map(user => user._id)
  const orderStats = await Order.aggregate([
    { $match: { buyer: { $in: userIds }, status: { $in: ['paid', 'partially_refunded'] } } },
    { $group: { _id: '$buyer', ordersCount: { $sum: 1 }, totalSpent: { $sum: '$total' } } },
  ])
  const statsByUser = new Map(orderStats.map(stat => [stat._id.toString(), stat]))

  // totalSpent above is Order.total, an EVENT_LEDGER_CURRENCY (Naira)
  // ledger amount — display-only conversion to the viewer's currency,
  // same pattern as every other admin money endpoint in this file. See
  // lib/viewerCurrency.ts.
  const viewerCurrency = await resolveViewerCurrency(req)
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  const usersWithStats = users.map(user => ({
    ...user,
    ordersCount: statsByUser.get(user._id.toString())?.ordersCount ?? 0,
    totalSpent: applyRate(statsByUser.get(user._id.toString())?.totalSpent ?? 0, ledgerRate),
  }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Users fetched',
    body: { users: usersWithStats, meta: buildPaginationMeta(page, limit, total), currency: viewerCurrency },
  })
})

/**
 * Powers the admin's single-user detail page — the stat cards (orders,
 * total spent, status) and the order-history table. Same order-stats
 * approach as listUsers above, just scoped to one user and with the
 * per-order rows kept (not just the aggregate) for the history table.
 */
export const getUserDetail = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const user = await User.findById(id).select('-password').lean()
  // Same exclusion as listUsers — admin accounts aren't "users" this page
  // manages, so a direct hit on /admin/users/:id for one 404s exactly like
  // it would for an id that doesn't exist, instead of leaking the account.
  if (!user || user.role === 'admin') {
    return sendTsRestError(res, 404, 'User not found')
  }

  const orders = await Order.find({ buyer: id, status: { $in: ['paid', 'partially_refunded'] } })
    .populate('event', 'title')
    .sort({ createdAt: -1 })
    .lean()

  const ordersCount = orders.length
  const totalSpentRaw = orders.reduce((sum, order) => sum + order.total, 0)

  // order.total is an EVENT_LEDGER_CURRENCY (Naira) ledger amount —
  // display-only conversion to the viewer's currency, same pattern as
  // every other admin money endpoint in this file. See lib/viewerCurrency.ts.
  const viewerCurrency = await resolveViewerCurrency(req)
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  const totalSpent = applyRate(totalSpentRaw, ledgerRate)
  const orderHistory = orders.map(order => ({
    orderId: order._id,
    eventTitle: (order.event as any)?.title ?? 'Deleted event',
    amount: applyRate(order.total, ledgerRate),
    date: order.createdAt,
  }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'User detail fetched',
    body: { ...user, ordersCount, totalSpent, orderHistory, currency: viewerCurrency },
  })
})

export const suspendUser = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const user = await User.findById(id)
  if (!user) {
    return sendTsRestError(res, 404, 'User not found')
  }
  if (user.role === 'admin') {
    return sendTsRestError(res, 400, "Admin accounts can't be suspended")
  }

  user.isSuspended = true
  await user.save()

  // Kick them out immediately rather than waiting for their session to expire naturally.
  await invalidateUserSessions(user._id.toString())

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'User suspended',
    body: sanitizeUser(user.toObject()),
  })
})

export const unsuspendUser = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const user = await User.findById(id)
  if (!user) {
    return sendTsRestError(res, 404, 'User not found')
  }

  user.isSuspended = false
  await user.save()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'User unsuspended',
    body: sanitizeUser(user.toObject()),
  })
})

/**
 * Soft-deletes an attendee/organizer account from the admin Users page.
 * Deliberately NOT a hard delete — Order.buyer, Ticket, RefundRequest.
 * requestedBy, PaymentDispute, and (for an organizer) Event.organizer all
 * reference this _id, so removing the row outright would leave every past
 * order/ticket/refund/dispute/event pointing at nothing and break their
 * display in both the admin console and the account's own history.
 * Instead this just marks the account deleted (blocks login, same as
 * isSuspended — see login/googleAuth in auth.controller.ts) and kicks out
 * any active session immediately. No personal info is scrubbed: the
 * fullname/email stay intact so past records referencing this user keep
 * showing correctly, exactly as Chloe asked for.
 */
export const deleteUser = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const user = await User.findById(id)
  if (!user) {
    return sendTsRestError(res, 404, 'User not found')
  }
  if (user.role === 'admin') {
    return sendTsRestError(res, 400, "Admin accounts can't be deleted here")
  }
  if (user.isDeleted) {
    return sendTsRestError(res, 400, 'This account is already deleted')
  }

  user.isDeleted = true
  user.deletedAt = new Date()
  await user.save()

  // Kick them out immediately, same as suspendUser does.
  await invalidateUserSessions(user._id.toString())

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'user_deleted',
    message: `Deleted account ${user.fullname} (${user.email})`,
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'User deleted',
    body: sanitizeUser(user.toObject()),
  })
})

/**
 * Reverses deleteUser above — same non-destructive philosophy as the rest
 * of the admin console's moderation actions (nothing here is a one-way
 * door if it doesn't have to be). Does not touch isSuspended, so a
 * restored account comes back in whatever suspended state it was in
 * before it was deleted (deleteUser never changes isSuspended either).
 */
export const restoreUser = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const user = await User.findById(id)
  if (!user) {
    return sendTsRestError(res, 404, 'User not found')
  }
  if (!user.isDeleted) {
    return sendTsRestError(res, 400, 'This account is not deleted')
  }

  user.isDeleted = false
  user.deletedAt = undefined
  await user.save()

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'user_restored',
    message: `Restored account ${user.fullname} (${user.email})`,
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'User restored',
    body: sanitizeUser(user.toObject()),
  })
})

export const getPlatformStats = tryCatchWrapper(async (req: Request, res: Response) => {
  const [salesAgg, promotedEvents, activeEvents, totalUsers, totalOrganizers, pendingRefunds, viewerCurrency] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] } } },
      { $group: { _id: null, grossSales: { $sum: '$subtotal' }, commissionRevenue: { $sum: '$platformFee' } } },
    ]),
    Event.find({ 'promotion.status': 'approved' }).select('promotion.package').lean(),
    Event.countDocuments({ status: { $in: ['approved', 'postponed'] } }),
    User.countDocuments({ role: 'attendee' }),
    User.countDocuments({ role: 'organizer' }),
    RefundRequest.countDocuments({ status: 'pending' }),
    resolveViewerCurrency(req),
  ])

  const promotionRevenue = promotedEvents.reduce((sum, event) => {
    const pkg = getPromotionPackage(event.promotion?.package)
    return sum + (pkg?.priceNaira ?? 0)
  }, 0)

  // grossSales/commissionRevenue/promotionRevenue are all
  // EVENT_LEDGER_CURRENCY (Naira) — display-only conversion, same as every
  // other admin money page. See lib/viewerCurrency.ts.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Platform stats fetched',
    body: {
      grossTicketSales: applyRate(salesAgg[0]?.grossSales ?? 0, ledgerRate),
      commissionRevenue: applyRate(salesAgg[0]?.commissionRevenue ?? 0, ledgerRate),
      promotionRevenue: applyRate(promotionRevenue, ledgerRate),
      currency: viewerCurrency,
      activeEvents,
      totalAttendees: totalUsers,
      totalOrganizers,
      pendingRefundRequests: pendingRefunds,
    },
  })
})

export const listPendingOrganizers = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const filter = { role: 'organizer', 'organizerProfile.approvalStatus': 'pending' }

  const [organizers, total] = await Promise.all([
    User.find(filter).select('-password').sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ])

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Pending organizers fetched',
    body: { organizers, meta: buildPaginationMeta(page, limit, total) },
  })
})

export const approveOrganizer = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const organizer = await User.findOne({ _id: id, role: 'organizer' })
  if (!organizer || !organizer.organizerProfile) {
    return sendTsRestError(res, 404, 'Organizer not found')
  }

  const { accountName, accountNumber, bankCode, cacCertificateUrl, directorIdUrl, proofOfAddressUrl } =
    organizer.organizerProfile
  if (!accountName || !accountNumber || !bankCode) {
    return sendTsRestError(res, 400, 'This organizer has not completed their bank details yet')
  }
  if (!cacCertificateUrl || !directorIdUrl || !proofOfAddressUrl) {
    return sendTsRestError(
      res,
      400,
      'This organizer has not uploaded all required verification documents yet (CAC certificate, director ID, proof of address)'
    )
  }

  try {
    const recipient = await PaystackService.createTransferRecipient({
      name: accountName,
      accountNumber,
      bankCode,
    })
    organizer.organizerProfile.paystackRecipientCode = recipient.recipientCode
    organizer.organizerProfile.isPayoutReady = true
  } catch (error: any) {
    return sendTsRestError(res, 502, `Could not verify bank details with Paystack: ${error.message}`)
  }

  organizer.organizerProfile.approvalStatus = 'approved'
  await organizer.save()

  EmailService.sendOrganizerApprovedEmail(organizer).catch(error =>
    logger.error({ err: error }, `Organizer-approved email failed for ${organizer._id}`)
  )
  NotificationService.create({
    recipient: organizer._id,
    type: 'organizer_approved',
    title: "You're approved!",
    message: 'Your organizer account has been approved. You can now publish events.',
    link: '/dashboard/overview',
  }).catch(error => logger.error({ err: error }, `Organizer-approved notification failed for ${organizer._id}`))

  const businessName = organizer.organizerProfile?.businessName ?? organizer.fullname
  logAdminActivity({
    actorId: req.session.userId!,
    type: 'organizer_approved',
    message: `Verified organizer ${businessName}`,
    relatedOrganizer: organizer._id,
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Organizer approved',
    body: sanitizeUser(organizer.toObject()),
  })
})

export const rejectOrganizer = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const organizer = await User.findOne({ _id: id, role: 'organizer' })
  if (!organizer || !organizer.organizerProfile) {
    return sendTsRestError(res, 404, 'Organizer not found')
  }

  organizer.organizerProfile.approvalStatus = 'rejected'
  await organizer.save()

  EmailService.sendOrganizerRejectedEmail(organizer).catch(error =>
    logger.error({ err: error }, `Organizer-rejected email failed for ${organizer._id}`)
  )
  NotificationService.create({
    recipient: organizer._id,
    type: 'organizer_rejected',
    title: 'Organizer application rejected',
    message: 'Your organizer application was not approved. Check your email for details.',
    link: '/dashboard/settings',
  }).catch(error => logger.error({ err: error }, `Organizer-rejected notification failed for ${organizer._id}`))

  const rejectedBusinessName = organizer.organizerProfile?.businessName ?? organizer.fullname
  logAdminActivity({
    actorId: req.session.userId!,
    type: 'organizer_rejected',
    message: `Rejected organizer application from ${rejectedBusinessName}`,
    relatedOrganizer: organizer._id,
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Organizer rejected',
    body: sanitizeUser(organizer.toObject()),
  })
})
export const suspendOrganizer = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { reason } = req.body

  const user = await User.findById(id)
  if (!user || user.role !== 'organizer') {
    return sendTsRestError(res, 404, 'Organizer not found')
  }

  // Mutate root user field
  user.isSuspended = true
  await user.save()

  // 1. Trigger organizer-specific suspended email
  await EmailService.sendOrganizerSuspendedEmail(
    { email: user.email, fullname: user.fullname },
    reason
  )

  // 2. Trigger in-app notification with organizer_suspended type
  await NotificationService.create({
    recipient: user._id,
    type: 'organizer_suspended',
    title: 'Organizer Account Suspended',
    message: reason
      ? `Your organizer access has been suspended. Reason: ${reason}`
      : 'Your organizer access on Eventra has been suspended by an administrator.',
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Organizer suspended successfully',
    body: sanitizeUser(user.toObject()),
  })
})

export const unsuspendOrganizer = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const user = await User.findById(id)
  if (!user || user.role !== 'organizer') {
    return sendTsRestError(res, 404, 'Organizer not found')
  }

  // Mutate root user field
  user.isSuspended = false
  await user.save()

  // 1. Trigger organizer-specific unsuspended email
  await EmailService.sendOrganizerUnsuspendedEmail({
    email: user.email,
    fullname: user.fullname,
  })

  // 2. Trigger in-app notification with organizer_unsuspended type
  await NotificationService.create({
    recipient: user._id,
    type: 'organizer_unsuspended',
    title: 'Organizer Account Reinstated',
    message: 'Your organizer account suspension has been lifted. You can now resume managing your events.',
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Organizer unsuspended successfully',
    body: sanitizeUser(user.toObject()),
  })
})
export const listPendingEvents = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const filter = { status: 'pending_approval' }

  const [events, total] = await Promise.all([
    Event.find(filter)
      .populate('organizer', 'fullname email organizerProfile.businessName')
      .populate('category', 'name')
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Event.countDocuments(filter),
  ])

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Pending events fetched',
    body: { events, meta: buildPaginationMeta(page, limit, total) },
  })
})

export const approveEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const event = await Event.findOne({ _id: id, status: 'pending_approval' })
  if (!event) {
    return sendTsRestError(res, 404, 'No pending event found with this id')
  }

  event.status = 'approved'
  event.publishedAt = new Date()
  await event.save()

  User.findById(event.organizer)
    .then(organizer => {
      if (!organizer) return
      // Email is opt-in — defaults to off, see organizerNotificationPreferences
      // on the User model and the "Event approvals" toggle on Settings. The
      // in-app notification below is NOT gated by that same toggle — it only
      // ever controlled whether an email goes out.
      if (organizer.organizerNotificationPreferences?.eventApprovals) {
        EmailService.sendEventApprovedEmail(organizer, event.title).catch(error =>
          logger.error({ err: error }, `Event-approved email failed for event ${event._id}`)
        )
      }
      NotificationService.create({
        recipient: organizer._id,
        type: 'event_approved',
        title: 'Event approved',
        message: `"${event.title}" has been approved and is now live.`,
        link: `/dashboard/events`,
        relatedEvent: event._id,
      }).catch(error => logger.error({ err: error }, `Event-approved notification failed for event ${event._id}`))
    })
    .catch(error => logger.error({ err: error }, `Could not load organizer for event ${event._id}`))

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'event_approved',
    message: `Approved event "${event.title}"`,
    relatedEvent: event._id,
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event approved',
    body: event.toObject(),
  })
})

export const rejectEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { reason } = req.body

  const event = await Event.findOne({ _id: id, status: 'pending_approval' })
  if (!event) {
    return sendTsRestError(res, 404, 'No pending event found with this id')
  }

  event.status = 'rejected'
  event.rejectionReason = reason
  await event.save()

  User.findById(event.organizer)
    .then(organizer => {
      if (!organizer) return
      if (organizer.organizerNotificationPreferences?.eventApprovals) {
        EmailService.sendEventRejectedEmail(organizer, event.title, reason).catch(error =>
          logger.error({ err: error }, `Event-rejected email failed for event ${event._id}`)
        )
      }
      NotificationService.create({
        recipient: organizer._id,
        type: 'event_rejected',
        title: 'Event rejected',
        message: `"${event.title}" was not approved${reason ? `: ${reason}` : '.'}`,
        link: `/dashboard/events`,
        relatedEvent: event._id,
      }).catch(error => logger.error({ err: error }, `Event-rejected notification failed for event ${event._id}`))
    })
    .catch(error => logger.error({ err: error }, `Could not load organizer for event ${event._id}`))

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'event_rejected',
    message: `Rejected event "${event.title}"${reason ? `, reason: ${reason}` : ''}`,
    relatedEvent: event._id,
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event rejected',
    body: event.toObject(),
  })
})

export const approveEventPromotion = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const event = await Event.findById(id)
  if (!event || !event.promotion) {
    return sendTsRestError(res, 404, 'No promotion request found for this event')
  }
  if (!event.promotion.paidAt) {
    return sendTsRestError(res, 400, 'Promotion payment has not been confirmed yet')
  }

  const pkg = getPromotionPackage(event.promotion.package)
  const durationDays = pkg?.durationDays ?? 7
  const startsAt = new Date()
  const endsAt = new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000)

  event.promotion.status = 'approved'
  event.promotion.startsAt = startsAt
  event.promotion.endsAt = endsAt
  event.isPromoted = true
  await event.save()

  NotificationService.create({
    recipient: event.organizer,
    type: 'promotion_approved',
    title: 'Promotion approved',
    message: `Your promotion for "${event.title}" is now live.`,
    link: `/dashboard/promotion`,
    relatedEvent: event._id,
  }).catch(error => logger.error({ err: error }, `Promotion-approved notification failed for event ${event._id}`))

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'promotion_approved',
    message: `Approved promotion for "${event.title}"`,
    relatedEvent: event._id,
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Promotion approved',
    body: event.toObject(),
  })
})

export const rejectEventPromotion = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const event = await Event.findById(id)
  if (!event || !event.promotion) {
    return sendTsRestError(res, 404, 'No promotion request found for this event')
  }

  event.promotion.status = 'rejected'
  event.isPromoted = false
  await event.save()

  NotificationService.create({
    recipient: event.organizer,
    type: 'promotion_rejected',
    title: 'Promotion rejected',
    message: `Your promotion request for "${event.title}" was not approved.`,
    link: `/dashboard/promotion`,
    relatedEvent: event._id,
  }).catch(error => logger.error({ err: error }, `Promotion-rejected notification failed for event ${event._id}`))

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'promotion_rejected',
    message: `Rejected promotion request for "${event.title}"`,
    relatedEvent: event._id,
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Promotion rejected',
    body: event.toObject(),
  })
})

export const listRefundRequests = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending'
  const filter = { status }

  const [refundRequests, total, viewerCurrency] = await Promise.all([
    RefundRequest.find(filter)
      .populate('event', 'title slug')
      .populate('requestedBy', 'fullname email')
      // Added so the admin Refunds table can show who's asking without a
      // second round-trip per row — the frontend table reads
      // request.ticket.attendeeName straight off this response.
      .populate('ticket', 'attendeeName attendeeEmail')
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    RefundRequest.countDocuments(filter),
    resolveViewerCurrency(req),
  ])

  // RefundRequest.amount is EVENT_LEDGER_CURRENCY (Naira) — the real
  // amount that was actually (or will be) refunded via Paystack. This
  // display-only conversion never touches what's stored; see the ledger
  // doc comment in lib/viewerCurrency.ts.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)
  const convertedRefundRequests = refundRequests.map(r => ({ ...r, amount: applyRate(r.amount, ledgerRate) }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Refund requests fetched',
    body: { refundRequests: convertedRefundRequests, currency: viewerCurrency, meta: buildPaginationMeta(page, limit, total) },
  })
})

export const approveRefundRequest = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const refundRequest = await RefundRequest.findOne({ _id: id, status: 'pending' })
  if (!refundRequest) {
    return sendTsRestError(res, 404, 'No pending refund request found with this id')
  }

  const [ticket, order] = await Promise.all([
    Ticket.findById(refundRequest.ticket),
    Order.findById(refundRequest.order),
  ])
  if (!ticket || !order) {
    return sendTsRestError(res, 404, 'The ticket or order for this request no longer exists')
  }

  try {
    const refund = await PaystackService.refundTransaction({
      transactionReference: order.paystackReference,
      amountKobo: Math.round(refundRequest.amount * 100),
      reason: refundRequest.reason,
    })

    ticket.status = 'refunded'
    await ticket.save()

    order.refundAmount = (order.refundAmount ?? 0) + refundRequest.amount
    const remainingValidTickets = await Ticket.countDocuments({
      order: order._id,
      status: { $in: ['valid', 'checked_in'] },
    })
    order.status = remainingValidTickets > 0 ? 'partially_refunded' : 'refunded'
    if (!order.refundedAt) order.refundedAt = new Date()
    await order.save()

    refundRequest.status = 'processed'
    refundRequest.paystackRefundReference = refund.reference
    refundRequest.processedAt = new Date()
    await refundRequest.save()

    Promise.all([User.findById(refundRequest.requestedBy), Event.findById(refundRequest.event)])
      .then(([requester, event]) => {
        if (requester && event) {
          const amountLabel = `₦${refundRequest.amount.toLocaleString('en-NG')}`

          EmailService.sendRefundProcessedEmail(
            requester,
            event.title,
            amountLabel
          ).catch(error => logger.error({ err: error }, `Refund-processed email failed for request ${refundRequest._id}`))

           NotificationService.create({
            recipient: requester._id,
            type: 'refund_processed',
            title: 'Refund processed',
            message: `Your refund of ${amountLabel} for "${event.title}" has been processed.`,
            link: '/tickets',
            relatedEvent: event._id,
          }).catch(error => logger.error({ err: error }, `Refund-processed notification failed for request ${refundRequest._id}`))

          // The organizer's earnings for this event just went down by this
          // amount (order.organizerEarnings isn't separately adjusted here,
          // but the refund did come out of their share) — they should know,
          // not just find out when a payout is smaller than expected.
          User.findById(event.organizer)
            .then(organizer => {
              if (!organizer) return

              EmailService.sendRefundDeductedEmail(
                organizer,
                event.title,
                amountLabel
              ).catch(error => logger.error({ err: error }, `Refund-deducted email failed for request ${refundRequest._id}`))

              NotificationService.create({
                recipient: organizer._id,
                type: 'refund_deducted',
                title: 'Refund issued for your event',
                message: `A refund of ${amountLabel} was issued to an attendee of "${event.title}" and deducted from your earnings.`,
                link: '/dashboard/payouts',
                relatedEvent: event._id,
              }).catch(error => logger.error({ err: error }, `Refund-deducted notification failed for request ${refundRequest._id}`))
            })
            .catch(error => logger.error({ err: error }, `Could not load organizer for refund ${refundRequest._id}`))
        }
      })
      .catch(error => logger.error({ err: error }, `Could not load requester/event for refund ${refundRequest._id}`))

    Event.findById(refundRequest.event)
      .then(refundedEvent => {
        logAdminActivity({
          actorId: req.session.userId!,
          type: 'refund_approved',
          message: `Issued refund of ₦${refundRequest.amount.toLocaleString('en-NG')}${refundedEvent ? ` for "${refundedEvent.title}"` : ''}`,
          relatedEvent: refundRequest.event,
          relatedRefundRequest: refundRequest._id,
        })
      })
      .catch(error => logger.error({ err: error }, `Could not load event for refund activity log ${refundRequest._id}`))

    return sendTsRestSuccess(res, 200, {
      success: true,
      message: 'Refund processed',
      body: refundRequest.toObject(),
    })
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Refund failed with Paystack')
  }
})

export const rejectRefundRequest = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { reason } = req.body as { reason?: string }

  const refundRequest = await RefundRequest.findOne({ _id: id, status: 'pending' })
  if (!refundRequest) {
    return sendTsRestError(res, 404, 'No pending refund request found with this id')
  }

  refundRequest.status = 'rejected'
  refundRequest.rejectionReason = reason
  await refundRequest.save()

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'refund_rejected',
    message: `Rejected refund request of ₦${refundRequest.amount.toLocaleString('en-NG')}${reason ? `, reason: ${reason}` : ''}`,
    relatedEvent: refundRequest.event,
    relatedRefundRequest: refundRequest._id,
  })

    Promise.all([User.findById(refundRequest.requestedBy), Event.findById(refundRequest.event)])
    .then(([requester, event]) => {
   if (requester && event) {
        EmailService.sendRefundRejectedEmail(
          requester,
          event.title,
          `₦${refundRequest.amount.toLocaleString('en-NG')}`,
          reason
        ).catch(error => logger.error({ err: error }, `Refund-rejected email failed for request ${refundRequest._id}`))

        NotificationService.create({
          recipient: requester._id,
          type: 'refund_rejected',
          title: 'Refund request declined',
          message: `Your refund request of ₦${refundRequest.amount.toLocaleString('en-NG')} for "${event.title}" was declined${reason ? `: ${reason}` : '.'}`,
          link: '/tickets',
          relatedEvent: event._id,
        }).catch(error => logger.error({ err: error }, `Refund-rejected notification failed for request ${refundRequest._id}`))
      }
    })
    .catch(error => logger.error({ err: error }, `Could not load requester/event for refund ${refundRequest._id}`))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Refund request rejected',
    body: refundRequest.toObject(),
  })
})

/**
 * Lists real Paystack chargebacks for the admin Disputes tab — populated
 * entirely from PaymentDispute, which only ever gets written to by
 * handleDisputeWebhook (see payment.controller.ts). Defaults to
 * status=pending since this is a "needs action" queue, same convention as
 * listRefundRequests.
 */
export const listDisputes = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending'
  const filter = { status }

  const [disputes, total, viewerCurrency] = await Promise.all([
    PaymentDispute.find(filter)
      .populate('event', 'title slug')
      .populate({
        path: 'order',
        select: 'buyer guestName guestEmail',
        populate: { path: 'buyer', select: 'fullname email' },
      })
      .sort({ raisedAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PaymentDispute.countDocuments(filter),
    resolveViewerCurrency(req),
  ])

  // PaymentDispute.amount is EVENT_LEDGER_CURRENCY (Naira) — the real
  // amount Paystack is disputing. Display-only conversion, same pattern
  // as listRefundRequests/getRefundRequestDetail above — this was
  // previously the one admin money endpoint that never resolved viewer
  // currency at all, so the Disputes tab showed a static Naira figure
  // regardless of the admin's currency preference.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)
  const convertedDisputes = disputes.map(d => ({ ...d, amount: applyRate(d.amount, ledgerRate) }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Disputes fetched',
    body: { disputes: convertedDisputes, currency: viewerCurrency, meta: buildPaginationMeta(page, limit, total) },
  })
})

/**
 * Contests a dispute — submits evidence to Paystack, then declines the
 * dispute (i.e. "we're fighting this"). Requires a message explaining our
 * side, which doubles as the `service_details` Paystack's evidence
 * endpoint requires.
 */
export const challengeDispute = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { message } = req.body as { message?: string }

  if (!message || !message.trim()) {
    return sendTsRestError(res, 400, "A message explaining why you're contesting this dispute is required")
  }

  const dispute = await PaymentDispute.findOne({ _id: id, status: 'pending' })
  if (!dispute) {
    return sendTsRestError(res, 404, 'No pending dispute found with this id')
  }

  const order = dispute.order ? await Order.findById(dispute.order) : null
  if (!order) {
    return sendTsRestError(res, 404, 'The order behind this dispute no longer exists')
  }

  let customerName = order.guestName ?? ''
  let customerEmail = order.guestEmail ?? ''
  let customerPhone = order.guestPhone ?? ''

  if (order.buyer) {
    const buyer = await User.findById(order.buyer)
    if (buyer) {
      customerName = buyer.fullname
      customerEmail = buyer.email
      customerPhone = buyer.phone ?? ''
    }
  }

  try {
    const evidence = await PaystackService.submitDisputeEvidence(dispute.paystackDisputeId, {
      customerEmail,
      customerName,
      customerPhone,
      serviceDetails: message.trim(),
    })

    await PaystackService.resolveDispute(dispute.paystackDisputeId, {
      resolution: 'declined',
      message: message.trim(),
      evidenceId: evidence.evidenceId,
    })

    dispute.merchantResponseStatus = 'challenged'
    dispute.merchantResponseMessage = message.trim()
    dispute.merchantRespondedAt = new Date()
    await dispute.save()

    Event.findById(dispute.event)
      .then(disputedEvent => {
        logAdminActivity({
          actorId: req.session.userId!,
          type: 'dispute_challenged',
          message: `Challenged a ₦${dispute.amount.toLocaleString('en-NG')} dispute${disputedEvent ? ` for "${disputedEvent.title}"` : ''}`,
          relatedEvent: dispute.event,
          relatedDispute: dispute._id,
        })
      })
      .catch(error => logger.error({ err: error }, `Could not load event for dispute activity log ${dispute._id}`))

    return sendTsRestSuccess(res, 200, {
      success: true,
      message: 'Evidence submitted to Paystack',
      body: dispute.toObject(),
    })
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Could not submit this challenge to Paystack')
  }
})

/**
 * Concedes a dispute — tells Paystack we accept the chargeback, which
 * triggers the actual refund to the customer on their side.
 */
export const acceptDisputeLoss = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const dispute = await PaymentDispute.findOne({ _id: id, status: 'pending' })
  if (!dispute) {
    return sendTsRestError(res, 404, 'No pending dispute found with this id')
  }

  try {
    await PaystackService.resolveDispute(dispute.paystackDisputeId, {
      resolution: 'merchant-accepted',
      refundAmountKobo: Math.round(dispute.amount * 100),
    })

    dispute.merchantResponseStatus = 'accepted-loss'
    dispute.merchantRespondedAt = new Date()
    await dispute.save()

    Event.findById(dispute.event)
      .then(disputedEvent => {
        logAdminActivity({
          actorId: req.session.userId!,
          type: 'dispute_accepted_loss',
          message: `Accepted a ₦${dispute.amount.toLocaleString('en-NG')} dispute loss${disputedEvent ? ` for "${disputedEvent.title}"` : ''}`,
          relatedEvent: dispute.event,
          relatedDispute: dispute._id,
        })
      })
      .catch(error => logger.error({ err: error }, `Could not load event for dispute activity log ${dispute._id}`))

    return sendTsRestSuccess(res, 200, {
      success: true,
      message: 'Dispute loss accepted',
      body: dispute.toObject(),
    })
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Could not accept this loss with Paystack')
  }
})

/**
 * Powers the "Needs Action" badges on the admin sidebar (Approvals /
 * Refunds). Deliberately counts the actual live backlog — organizers and
 * events actually sitting in 'pending' — rather than unread notifications,
 * so the number stays accurate even after an admin has already opened the
 * notification bell (a badge that only reflected unread notifications
 * would empty out on its own the moment the bell is opened, even though
 * the approvals themselves are still sitting there unresolved).
 *
 * 'Reports' counts open Report rows — see models/report.ts.
 */
export const getAdminNavCounts = tryCatchWrapper(async (_req: Request, res: Response) => {
  const [pendingOrganizers, pendingEvents, pendingPromotions, pendingRefunds, openReports, unreadEnquiries] = await Promise.all([
    User.countDocuments({ role: { $ne: 'admin' }, 'organizerProfile.approvalStatus': 'pending' }),
    Event.countDocuments({ status: 'pending_approval' }),
    Event.countDocuments({ 'promotion.status': 'pending', 'promotion.paidAt': { $exists: true } }),
    RefundRequest.countDocuments({ status: 'pending' }),
    Report.countDocuments({ status: 'open' }),
    Enquiry.countDocuments({ status: 'unread' }),
  ])

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Nav counts fetched',
    body: {
      pendingApprovals: pendingOrganizers + pendingEvents + pendingPromotions,
      pendingRefunds,
      flaggedReports: openReports,
      unreadEnquiries,
    },
  })
})

/**
 * Powers the admin Events management page's detail view — the event
 * itself plus its ticket types, so the page doesn't need a second
 * round-trip to the organizer-facing ticket-type endpoints.
 */
export const getEventDetailForAdmin = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const [event, ticketTypes, viewerCurrency] = await Promise.all([
    Event.findById(id)
      .populate('organizer', 'fullname email organizerProfile.businessName organizerProfile.approvalStatus')
      .populate('category', 'name')
      .lean(),
    TicketType.find({ event: id }).sort({ price: 1 }).lean(),
    resolveViewerCurrency(req),
  ])

  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  // Display-only conversion for the admin's own currencyPreference — see
  // the big doc comment on updatePlatformSettings below and
  // lib/viewerCurrency.ts for what's actually stored vs. shown here.
  const [ledgerRate, ticketTypeRate] = await Promise.all([
    getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency),
    getDisplayRate(TICKET_TYPE_CURRENCY, viewerCurrency),
  ])
  const convertedEvent = {
    ...event,
    minPrice: typeof event.minPrice === 'number' ? applyRate(event.minPrice, ledgerRate) : event.minPrice,
    revenueTotal: typeof event.revenueTotal === 'number' ? applyRate(event.revenueTotal, ledgerRate) : event.revenueTotal,
  }
  const convertedTicketTypes = ticketTypes.map(tt => ({
    ...tt,
    price: applyTicketTypeRate(tt.price, ticketTypeRate, viewerCurrency),
  }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event fetched',
    body: { ...convertedEvent, ticketTypes: convertedTicketTypes, currency: viewerCurrency },
  })
})

/**
 * Powers the admin Organizers management page's detail view — profile,
 * lifetime sales/payout totals, and a recent-events strip.
 */
export const getOrganizerDetailForAdmin = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const organizer = await User.findOne({ _id: id, role: 'organizer' }).select('-password').lean()
  if (!organizer || !organizer.organizerProfile) {
    return sendTsRestError(res, 404, 'Organizer not found')
  }

  const [eventsRunCount, salesAgg, recentEvents, viewerCurrency] = await Promise.all([
    Event.countDocuments({ organizer: id, status: { $in: ['approved', 'postponed'] } }),
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] } } },
      { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'eventDoc' } },
      { $unwind: '$eventDoc' },
      { $match: { 'eventDoc.organizer': organizer._id } },
      {
        $group: {
          _id: null,
          ticketsSold: { $sum: { $sum: '$items.quantity' } },
          revenue: { $sum: '$subtotal' },
          paidOut: { $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$organizerEarnings', 0] } },
        },
      },
    ]),
    Event.find({ organizer: id }).select('title slug status ticketsSoldCount capacity').sort({ createdAt: -1 }).limit(5).lean(),
    resolveViewerCurrency(req),
  ])

  // revenue/paidOut are EVENT_LEDGER_CURRENCY (Naira) — display-only
  // conversion, same pattern as listOrganizersForAdmin below.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Organizer fetched',
    body: {
      ...sanitizeUser(organizer),
      eventsRunCount,
      ticketsSold: salesAgg[0]?.ticketsSold ?? 0,
      revenue: applyRate(salesAgg[0]?.revenue ?? 0, ledgerRate),
      paidOut: applyRate(salesAgg[0]?.paidOut ?? 0, ledgerRate),
      currency: viewerCurrency,
      recentEvents: recentEvents.map(e => ({ _id: e._id, title: e.title, slug: e.slug, status: e.status, sold: e.ticketsSoldCount, capacity: e.capacity })),
    },
  })
})

/**
 * Powers the standalone admin "Promotions" page (under Manage, alongside
 * Events/Organizers/Users) — every promotion ever requested, across every
 * status, with the same tab+search+pagination shape as listEventsForAdmin.
 * Unlike the Approvals page's Promotions tab (listPendingPromotions below),
 * a promotion doesn't disappear from here once it's approved or rejected —
 * this is the durable record ("who promoted what, and when does it end"),
 * not just the action queue.
 *
 * 'approved' here means "currently active" (status approved AND not past
 * its endsAt) — a promotion that ran out its duration moves to the
 * 'expired' tab on its own once endsAt passes, same computed distinction
 * listMyPromotions (promotion.controller.ts) makes for the organizer-facing
 * table. Search matches on event title only, same as listEventsForAdmin —
 * organizer name isn't indexed/searchable here without an aggregation
 * lookup, which felt like more machinery than this page needs yet.
 */
export const listPromotionsForAdmin = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const now = new Date()

  const filter: Record<string, any> = { promotion: { $exists: true }, 'promotion.paidAt': { $exists: true } }

  const tab = typeof req.query.tab === 'string' ? req.query.tab : 'all'
  if (tab === 'pending') filter['promotion.status'] = 'pending'
  else if (tab === 'approved') {
    filter['promotion.status'] = 'approved'
    filter.$or = [{ 'promotion.endsAt': { $exists: false } }, { 'promotion.endsAt': { $gte: now } }]
  } else if (tab === 'expired') {
    filter['promotion.status'] = 'approved'
    filter['promotion.endsAt'] = { $lt: now }
  } else if (tab === 'rejected') filter['promotion.status'] = 'rejected'

  if (req.query.q && typeof req.query.q === 'string') {
    filter.title = new RegExp(escapeRegExp(req.query.q), 'i')
  }

  const [events, total, viewerCurrency] = await Promise.all([
    Event.find(filter)
      .populate('organizer', 'fullname organizerProfile.businessName')
      .select('title slug coverImage promotion createdAt')
      .sort({ 'promotion.paidAt': -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Event.countDocuments(filter),
    resolveViewerCurrency(req),
  ])

  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  const promotions = events.map(event => {
    const promotion = event.promotion!
    const pkg = getPromotionPackage(promotion.package)
    const organizer = event.organizer as any
    const isExpired = promotion.status === 'approved' && !!promotion.endsAt && new Date(promotion.endsAt) < now
    const statusKey = isExpired ? 'expired' : promotion.status

    return {
      eventId: event._id,
      eventTitle: event.title ?? 'Untitled event',
      eventCoverImage: event.coverImage,
      organizerId: organizer?._id,
      organizerName: organizer?.organizerProfile?.businessName ?? organizer?.fullname ?? 'Unknown organizer',
      packageId: promotion.package,
      packageLabel: pkg?.label ?? promotion.package,
      placementLabel: pkg?.placementLabel,
      priceNaira: pkg ? applyRate(pkg.priceNaira, ledgerRate) : null,
      status: statusKey,
      startsAt: promotion.startsAt ?? null,
      endsAt: promotion.endsAt ?? null,
      paidAt: promotion.paidAt,
      paystackReference: promotion.paystackReference,
    }
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Promotions fetched',
    body: { promotions, meta: buildPaginationMeta(page, limit, total), currency: viewerCurrency },
  })
})

/**
 * Powers the Approvals page's Promotions tab — every event with a
 * promotion that's actually been paid for and is still awaiting admin
 * review. Same `promotion.status: 'pending'` + `promotion.paidAt` exists
 * filter as promotionsPendingCount in getAdminNavCounts, so this tab's
 * count and the sidebar "Needs Action" badge always agree — the badge was
 * previously counting a category (pending promotions) that had no tab to
 * show it on, which is why the badge total (4) didn't match Events+Organizers
 * (0+3=3) on this page.
 */
export const listPendingPromotions = tryCatchWrapper(async (req: Request, res: Response) => {
  const filter = { 'promotion.status': 'pending', 'promotion.paidAt': { $exists: true } }

  const [events, viewerCurrency] = await Promise.all([
    Event.find(filter)
      .populate('organizer', 'fullname organizerProfile.businessName')
      .select('title slug coverImage promotion createdAt')
      .sort({ 'promotion.paidAt': 1 })
      .lean(),
    resolveViewerCurrency(req),
  ])

  // Same display-only conversion as every other admin money endpoint —
  // pkg.priceNaira is the real Naira price the organizer actually paid via
  // Paystack (see requestPromotion, promotion.controller.ts), never
  // touched by this conversion itself.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  const promotions = events.map(event => {
    const promotion = event.promotion!
    const pkg = getPromotionPackage(promotion.package)
    const organizer = event.organizer as any
    return {
      eventId: event._id,
      eventTitle: event.title ?? 'Untitled event',
      eventCoverImage: event.coverImage,
      organizerId: organizer?._id,
      organizerName: organizer?.organizerProfile?.businessName ?? organizer?.fullname ?? 'Unknown organizer',
      packageId: promotion.package,
      packageLabel: pkg?.label ?? promotion.package,
      placementLabel: pkg?.placementLabel,
      priceNaira: pkg ? applyRate(pkg.priceNaira, ledgerRate) : null,
      durationDays: pkg?.durationDays,
      paidAt: promotion.paidAt,
      paystackReference: promotion.paystackReference,
    }
  })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Pending promotions fetched',
    body: { promotions, currency: viewerCurrency },
  })
})

/**
 * Powers the Promotions tab's detail view (clicking a row on the Approvals
 * page) — the event, its promotion request, and the package it's
 * requesting, all in one call so the approve/reject buttons there have
 * everything they need. Works for a promotion in any status, not just
 * pending — same as getEventDetailForAdmin allowing any event status, an
 * already-approved or -rejected promotion can still be reviewed after the
 * fact.
 */
export const getEventPromotionDetailForAdmin = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId } = req.params

  const [event, viewerCurrency] = await Promise.all([
    Event.findById(eventId)
      .populate('organizer', 'fullname email organizerProfile.businessName organizerProfile.approvalStatus')
      .populate('category', 'name')
      .select('title slug coverImage category startDate promotion createdAt')
      .lean(),
    resolveViewerCurrency(req),
  ])

  if (!event || !event.promotion) {
    return sendTsRestError(res, 404, 'No promotion request found for this event')
  }

  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)
  const promotion = event.promotion
  const pkg = getPromotionPackage(promotion.package)
  const organizer = event.organizer as any
  // Same computed "expired" override listPromotionsForAdmin/listMyPromotions
  // apply — promotion.status in the DB only ever holds 'pending' | 'approved'
  // | 'rejected' (there's no cron-driven status flip on expiry, just
  // isPromoted going false, see promotionExpiryCron.ts), so without this an
  // expired promotion opened from the Promotions list would show "ACTIVE"
  // here even though the list row correctly tagged it "EXPIRED".
  const isExpired = promotion.status === 'approved' && !!promotion.endsAt && new Date(promotion.endsAt) < new Date()
  const statusKey = isExpired ? 'expired' : promotion.status

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Promotion detail fetched',
    body: {
      eventId: event._id,
      eventTitle: event.title ?? 'Untitled event',
      eventSlug: event.slug,
      eventCoverImage: event.coverImage,
      eventCategory: (event.category as any)?.name,
      eventStartDate: event.startDate,
      organizer: {
        id: organizer?._id,
        name: organizer?.organizerProfile?.businessName ?? organizer?.fullname ?? 'Unknown organizer',
        email: organizer?.email,
        verified: organizer?.organizerProfile?.approvalStatus === 'approved',
      },
      packageId: promotion.package,
      packageLabel: pkg?.label ?? promotion.package,
      packageDescription: pkg?.description,
      placementLabel: pkg?.placementLabel,
      priceNaira: pkg ? applyRate(pkg.priceNaira, ledgerRate) : null,
      durationDays: pkg?.durationDays,
      status: statusKey,
      startsAt: promotion.startsAt,
      endsAt: promotion.endsAt,
      paidAt: promotion.paidAt,
      paystackReference: promotion.paystackReference,
      currency: viewerCurrency,
    },
  })
})

export const listOrganizersForAdmin = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const filter: Record<string, any> = { role: 'organizer', organizerProfile: { $exists: true } }

  const tab = typeof req.query.tab === 'string' ? req.query.tab : 'all'
  if (tab === 'verified') filter['organizerProfile.approvalStatus'] = 'approved'
  else if (tab === 'pending') filter['organizerProfile.approvalStatus'] = 'pending'
  else if (tab === 'suspended') filter.isSuspended = true

  if (req.query.q && typeof req.query.q === 'string') {
    const term = new RegExp(escapeRegExp(req.query.q), 'i')
    filter.$or = [{ fullname: term }, { 'organizerProfile.businessName': term }, { email: term }]
  }

  const [organizers, total, viewerCurrency] = await Promise.all([
    User.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
    resolveViewerCurrency(req),
  ])

  const organizerIds = organizers.map(o => o._id)
  const [statsAgg, eventCounts] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] } } },
      { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'eventDoc' } },
      { $unwind: '$eventDoc' },
      { $match: { 'eventDoc.organizer': { $in: organizerIds } } },
      { $group: { _id: '$eventDoc.organizer', revenue: { $sum: '$subtotal' } } },
    ]),
    Event.aggregate([
      { $match: { organizer: { $in: organizerIds }, status: { $in: ['approved', 'postponed'] } } },
      { $group: { _id: '$organizer', count: { $sum: 1 } } },
    ]),
  ])
  const revenueByOrganizer = new Map(statsAgg.map(s => [String(s._id), s.revenue]))
  const eventCountByOrganizer = new Map(eventCounts.map(s => [String(s._id), s.count]))

  // revenue is EVENT_LEDGER_CURRENCY (Naira, Order.subtotal) — display-only
  // conversion, same as every other admin money page. Was previously the
  // one admin list endpoint that never resolved viewer currency at all, so
  // the Organizers table's REVENUE column stayed static Naira regardless
  // of the admin's currency preference.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)
  const body = organizers.map(o => ({
    ...sanitizeUser(o),
    eventsCount: eventCountByOrganizer.get(String(o._id)) ?? 0,
    revenue: applyRate(revenueByOrganizer.get(String(o._id)) ?? 0, ledgerRate),
  }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Organizers fetched',
    body: { organizers: body, currency: viewerCurrency, meta: buildPaginationMeta(page, limit, total) },
  })
})

/**
 * Powers the admin Refunds page's detail view — the request plus enough
 * context (event, requester, ticket, order reference) to make a call on it
 * without bouncing to three other pages first.
 */
export const getRefundRequestDetail = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const refundRequest = await RefundRequest.findById(id)
    // startDate is included so the frontend can compute whether this
    // request falls inside the event's refund window (see
    // isWithinRefundWindow in refund-request-details.tsx) without a
    // second call.
    .populate('event', 'title slug startDate refundPolicy')
    .populate('requestedBy', 'fullname email')
    // Nested-populate ticketType so the detail page can show "VIP" /
    // "Early bird" instead of just a raw ObjectId.
    .populate({
      path: 'ticket',
      select: 'attendeeName attendeeEmail ticketId code price ticketType',
      populate: { path: 'ticketType', select: 'name' },
    })
    .populate('order', 'paystackReference')
    .lean()

  if (!refundRequest) {
    return sendTsRestError(res, 404, 'Refund request not found')
  }

  // RefundRequest.amount and the nested Ticket.price are both
  // EVENT_LEDGER_CURRENCY (Naira) — display-only conversion, same as
  // listRefundRequests above.
  const viewerCurrency = await resolveViewerCurrency(req)
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)
  const convertedTicket =
    refundRequest.ticket && typeof (refundRequest.ticket as any).price === 'number'
      ? { ...(refundRequest.ticket as any), price: applyRate((refundRequest.ticket as any).price, ledgerRate) }
      : refundRequest.ticket
  const convertedRefundRequest = {
    ...refundRequest,
    amount: applyRate(refundRequest.amount, ledgerRate),
    ticket: convertedTicket,
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Refund request fetched',
    body: { ...convertedRefundRequest, currency: viewerCurrency },
  })
})

/**
 * Powers the admin Events management page's list — every event (not just
 * ones pending approval, unlike listPendingEvents above), filterable by
 * the page's All/Pending/Live/Flagged/Past/Rejected tabs.
 */
export const listEventsForAdmin = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  // A draft is an organizer's own unpublished work-in-progress — it was
  // never submitted for review, so admin has no business seeing it here.
  // Every tab below either overwrites this with its own status filter
  // (which already excludes 'draft') or — 'all' and 'flagged' — has no
  // status filter of its own, in which case this baseline is what was
  // missing and drafts were leaking into both.
  const filter: Record<string, any> = { status: { $ne: 'draft' } }

  const tab = typeof req.query.tab === 'string' ? req.query.tab : 'all'
  if (tab === 'pending') filter.status = 'pending_approval'
  else if (tab === 'live') filter.status = { $in: ['approved', 'postponed'] }
  else if (tab === 'flagged') filter.flagged = true
  else if (tab === 'past') {
    filter.status = { $in: ['approved', 'postponed'] }
    filter.endDate = { $lt: new Date() }
  } else if (tab === 'rejected') filter.status = 'rejected'

  if (req.query.q && typeof req.query.q === 'string') {
    filter.title = new RegExp(escapeRegExp(req.query.q), 'i')
  }

  const [events, total] = await Promise.all([
    Event.find(filter)
      .populate('organizer', 'fullname organizerProfile.businessName')
      .select('title slug type status flagged ticketsSoldCount capacity startDate createdAt organizer')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Event.countDocuments(filter),
  ])

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Events fetched',
    body: { events, meta: buildPaginationMeta(page, limit, total) },
  })
})

/**
 * Flags an event for review without taking it down — it stays live and
 * bookable while an admin looks into it. See the `flagged` field's
 * comment on the Event model for why this is separate from `status`.
 */
export const flagEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { reason } = req.body as { reason?: string }

  const event = await Event.findByIdAndUpdate(id, { flagged: true, flagReason: reason }, { new: true })
  if (!event) return sendTsRestError(res, 404, 'Event not found')

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'event_flagged',
    message: `Flagged event "${event.title}"${reason ? `: ${reason}` : ''}`,
    relatedEvent: event._id,
  })

  return sendTsRestSuccess(res, 200, { success: true, message: 'Event flagged', body: event.toObject() })
})

export const unflagEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const event = await Event.findByIdAndUpdate(id, { flagged: false, $unset: { flagReason: 1 } }, { new: true })
  if (!event) return sendTsRestError(res, 404, 'Event not found')

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'event_unflagged',
    message: `Dismissed flag on event "${event.title}"`,
    relatedEvent: event._id,
  })

  return sendTsRestSuccess(res, 200, { success: true, message: 'Flag dismissed', body: event.toObject() })
})

/**
 * Manually flags an organizer's account for review — mirrors flagEvent
 * above, just scoped to organizerProfile.flagged/flagReason instead of an
 * event. Independent of whether any report exists against this organizer;
 * a report also sets these same fields automatically (see reportEvent in
 * event.controller.ts).
 */
export const flagOrganizer = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { reason } = req.body as { reason?: string }

  const organizer = await User.findOneAndUpdate(
    { _id: id, role: 'organizer' },
    { 'organizerProfile.flagged': true, 'organizerProfile.flagReason': reason },
    { new: true }
  )
  if (!organizer) return sendTsRestError(res, 404, 'Organizer not found')

  const businessName = organizer.organizerProfile?.businessName ?? organizer.fullname
  logAdminActivity({
    actorId: req.session.userId!,
    type: 'organizer_flagged',
    message: `Flagged organizer ${businessName}${reason ? `: ${reason}` : ''}`,
    relatedOrganizer: organizer._id,
  })

  return sendTsRestSuccess(res, 200, { success: true, message: 'Organizer flagged', body: sanitizeUser(organizer.toObject()) })
})

export const unflagOrganizer = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const organizer = await User.findOneAndUpdate(
    { _id: id, role: 'organizer' },
    { 'organizerProfile.flagged': false, $unset: { 'organizerProfile.flagReason': 1 } },
    { new: true }
  )
  if (!organizer) return sendTsRestError(res, 404, 'Organizer not found')

  const businessName = organizer.organizerProfile?.businessName ?? organizer.fullname
  logAdminActivity({
    actorId: req.session.userId!,
    type: 'organizer_unflagged',
    message: `Dismissed flag on organizer ${businessName}`,
    relatedOrganizer: organizer._id,
  })

  return sendTsRestSuccess(res, 200, { success: true, message: 'Flag dismissed', body: sanitizeUser(organizer.toObject()) })
})

/**
 * Powers the admin Reports/Flags queue. Merges two sources so nothing
 * flagged is invisible here: targets with an open Report (the normal case
 * — an attendee reported something, which auto-flagged it, see
 * reportEvent), AND targets an admin flagged by hand via
 * flagEvent/flagOrganizer with no report behind them at all. Deduplicated
 * by targetType:targetId so a report-backed flag never shows up twice.
 */
export const listFlags = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const targetType = req.query.targetType === 'event' || req.query.targetType === 'organizer' ? req.query.targetType : undefined

  const reportMatch: Record<string, any> = { status: 'open' }
  if (targetType) reportMatch.targetType = targetType

  const reportGroups = await Report.aggregate([
    { $match: reportMatch },
    {
      $group: {
        _id: { targetType: '$targetType', targetId: { $ifNull: ['$organizer', '$event'] } },
        reportsCount: { $sum: 1 },
        latestReportedAt: { $max: '$createdAt' },
        latestReason: { $last: '$reason' },
        event: { $first: '$event' },
        organizer: { $first: '$organizer' },
      },
    },
  ])

  const reportBackedKeys = new Set(reportGroups.map(g => `${g._id.targetType}:${g._id.targetId}`))

  const [eventIds, organizerIds] = [
    reportGroups.filter(g => g._id.targetType === 'event').map(g => g.event),
    reportGroups.filter(g => g._id.targetType === 'organizer').map(g => g.organizer),
  ]

  const [reportedEvents, reportedOrganizers, handFlaggedEvents, handFlaggedOrganizers] = await Promise.all([
    Event.find({ _id: { $in: eventIds } }).select('title flagged flagReason').lean(),
    User.find({ _id: { $in: organizerIds } }).select('fullname organizerProfile.businessName organizerProfile.flagged organizerProfile.flagReason').lean(),
    !targetType || targetType === 'event' ? Event.find({ flagged: true }).select('title flagReason').lean() : Promise.resolve([]),
    !targetType || targetType === 'organizer'
      ? User.find({ role: 'organizer', 'organizerProfile.flagged': true }).select('fullname organizerProfile.businessName organizerProfile.flagReason').lean()
      : Promise.resolve([]),
  ])

  const eventById = new Map(reportedEvents.map(e => [String(e._id), e]))
  const organizerById = new Map(reportedOrganizers.map(o => [String(o._id), o]))

  const reportBackedFlags = reportGroups.map(g => {
    const targetId = g._id.targetId
    const isEvent = g._id.targetType === 'event'
    const eventDoc = isEvent ? eventById.get(String(targetId)) : null
    const organizerDoc = !isEvent ? organizerById.get(String(targetId)) : null
    return {
      targetType: g._id.targetType,
      targetId,
      title: isEvent ? eventDoc?.title ?? 'Deleted event' : organizerDoc?.organizerProfile?.businessName ?? organizerDoc?.fullname ?? 'Deleted organizer',
      flagReason: isEvent ? eventDoc?.flagReason : organizerDoc?.organizerProfile?.flagReason,
      reportsCount: g.reportsCount,
      latestReportedAt: g.latestReportedAt,
      latestReason: g.latestReason,
      hasReports: true,
    }
  })

  const handFlaggedEventFlags = handFlaggedEvents
    .filter(e => !reportBackedKeys.has(`event:${e._id}`))
    .map(e => ({
      targetType: 'event' as const,
      targetId: e._id,
      title: e.title ?? 'Untitled event',
      flagReason: e.flagReason,
      reportsCount: 0,
      latestReportedAt: null,
      latestReason: null,
      hasReports: false,
    }))

  const handFlaggedOrganizerFlags = handFlaggedOrganizers
    .filter(o => !reportBackedKeys.has(`organizer:${o._id}`))
    .map(o => ({
      targetType: 'organizer' as const,
      targetId: o._id,
      title: o.organizerProfile?.businessName ?? o.fullname,
      flagReason: o.organizerProfile?.flagReason,
      reportsCount: 0,
      latestReportedAt: null,
      latestReason: null,
      hasReports: false,
    }))

  const allFlags = [...reportBackedFlags, ...handFlaggedEventFlags, ...handFlaggedOrganizerFlags].sort((a, b) => {
    const aTime = a.latestReportedAt ? new Date(a.latestReportedAt).getTime() : 0
    const bTime = b.latestReportedAt ? new Date(b.latestReportedAt).getTime() : 0
    return bTime - aTime
  })

  const total = allFlags.length
  const pageFlags = allFlags.slice(skip, skip + limit)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Flags fetched',
    body: { flags: pageFlags, meta: buildPaginationMeta(page, limit, total) },
  })
})

/**
 * Flag-detail page for an event target — the event itself plus every open
 * report filed against it, so an admin can read the actual reasons before
 * deciding whether to dismiss the flag or act on it.
 */
export const getEventFlagDetail = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const [event, reports, viewerCurrency] = await Promise.all([
    Event.findById(id)
      .select('title slug flagged flagReason status category startDate minPrice type isOnline venue onlinePlatform onlineJoinLink')
      .populate('category', 'name')
      .populate('organizer', 'fullname email organizerProfile.businessName')
      .lean(),
    Report.find({ targetType: 'event', event: id, status: 'open' })
      .sort({ createdAt: -1 })
      .populate('event', 'title')
      .lean(),
    resolveViewerCurrency(req),
  ])

  if (!event) return sendTsRestError(res, 404, 'Event not found')

  const venue = event.isOnline
    ? { name: event.onlinePlatform ?? 'Online', joinLink: event.onlineJoinLink ?? null }
    : event.venue
      ? { name: event.venue.name, address: event.venue.address, city: event.venue.city }
      : null

  const { isOnline, onlinePlatform, onlineJoinLink, venue: _rawVenue, ...eventFields } = event

  // event.minPrice is an EVENT_LEDGER_CURRENCY (Naira) ledger amount, same
  // as every other admin money field — display-only conversion so the
  // "Ticket price" line on the flag-detail page respects the admin's
  // chosen currency instead of always showing ₦ regardless of it. This
  // endpoint never resolved viewer currency at all before now.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Flag detail fetched',
    body: {
      event: { ...eventFields, minPrice: applyRate(eventFields.minPrice, ledgerRate), venue },
      reports,
      currency: viewerCurrency,
    },
  })
})

export const getOrganizerFlagDetail = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const [organizer, reports] = await Promise.all([
    User.findOne({ _id: id, role: 'organizer' })
      .select('fullname email organizerProfile.businessName organizerProfile.flagged organizerProfile.flagReason')
      .lean(),
    Report.find({ targetType: 'organizer', organizer: id, status: 'open' }).sort({ createdAt: -1 }).lean(),
  ])

  if (!organizer) return sendTsRestError(res, 404, 'Organizer not found')

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Flag detail fetched',
    body: { organizer, reports },
  })
})

/**
 * Dismisses an event's flag — closes out every open report against it AND
 * clears the flag itself, in one step. Under the auto-flag-on-report
 * design a flag and its reports are tightly coupled, so "the reports
 * weren't a real issue" and "the flag should come down" are the same
 * decision.
 */
export const dismissEventFlag = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const [event] = await Promise.all([
    Event.findByIdAndUpdate(id, { flagged: false, $unset: { flagReason: 1 } }, { new: true }),
    Report.updateMany({ targetType: 'event', event: id, status: 'open' }, { status: 'dismissed' }),
  ])
  if (!event) return sendTsRestError(res, 404, 'Event not found')

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'event_unflagged',
    message: `Dismissed the report(s) and flag on event "${event.title}"`,
    relatedEvent: event._id,
  })

  return sendTsRestSuccess(res, 200, { success: true, message: 'Flag dismissed', body: event.toObject() })
})

export const dismissOrganizerFlag = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const [organizer] = await Promise.all([
    User.findOneAndUpdate(
      { _id: id, role: 'organizer' },
      { 'organizerProfile.flagged': false, $unset: { 'organizerProfile.flagReason': 1 } },
      { new: true }
    ),
    Report.updateMany({ targetType: 'organizer', organizer: id, status: 'open' }, { status: 'dismissed' }),
  ])
  if (!organizer) return sendTsRestError(res, 404, 'Organizer not found')

  const businessName = organizer.organizerProfile?.businessName ?? organizer.fullname
  logAdminActivity({
    actorId: req.session.userId!,
    type: 'organizer_unflagged',
    message: `Dismissed the report(s) and flag on organizer ${businessName}`,
    relatedOrganizer: organizer._id,
  })

  return sendTsRestSuccess(res, 200, { success: true, message: 'Flag dismissed', body: sanitizeUser(organizer.toObject()) })
})

// Short, table-friendly verb phrase per activity type — feeds the audit
// log's ACTION column. Keep in sync with AdminActivityType in
// models/adminActivityLog.ts; an unrecognized type falls back to the raw
// type string rather than throwing, so a new type never breaks this page.
const AUDIT_ACTION_LABELS: Record<AdminActivityType, string> = {
  event_approved: 'Approved event',
  event_rejected: 'Rejected event',
  event_flagged: 'Flagged event',
  event_unflagged: 'Unflagged event',
  organizer_approved: 'Verified organizer',
  organizer_rejected: 'Rejected organizer',
  refund_approved: 'Issued refund',
  refund_rejected: 'Rejected refund',
  promotion_approved: 'Approved promotion',
  organizer_suspended: 'Organizer Suspended',
  organizer_unsuspended: 'Organizer Unsuspended',
  event_suspended: 'Event Suspended',
  event_unsuspended: 'Event Unsuspended',
  promotion_rejected: 'Rejected promotion',
  dispute_challenged: 'Challenged dispute',
  dispute_accepted_loss: 'Accepted dispute loss',
  organizer_flagged: 'Flagged organizer',
  organizer_unflagged: 'Unflagged organizer',
  admin_invited: 'Invited admin',
  admin_role_changed: 'Changed admin tier',
  admin_removed: 'Removed admin',
  currency_converted: 'Converted platform currency',
  user_deleted: 'Deleted user account',
  user_restored: 'Restored user account',
  commission_rate_changed: 'Changed commission rate',
  payout_hold_changed: 'Changed payout hold',
}

/**
 * Powers the admin Settings > Activity/Audit Log — the full history behind
 * the Overview page's "Recent activity" card (which only shows the latest
 * 5). Same AdminActivityLog collection, just paginated instead of capped.
 *
 * The table has four columns — ACTION / TARGET / ADMIN / WHEN — so this
 * populates every "related" ref and derives action/target/amount here
 * instead of asking the frontend to parse them back out of the single
 * pre-rendered `message` string (which stays on the response too, for
 * anything that still wants one line of text, e.g. the Overview page's
 * Recent Activity card via a separate endpoint).
 */
export const listAuditLog = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)

  const [logs, total] = await Promise.all([
    AdminActivityLog.find()
      .populate('actor', 'fullname')
      .populate('relatedEvent', 'title')
      .populate('relatedOrganizer', 'fullname organizerProfile.businessName')
      .populate('relatedRefundRequest', 'amount')
      .populate('relatedDispute', 'amount')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AdminActivityLog.countDocuments(),
  ])

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Audit log fetched',
    body: {
      logs: logs.map(entry => {
        const event = entry.relatedEvent as any
        const organizer = entry.relatedOrganizer as any
        const refundRequest = entry.relatedRefundRequest as any
        const dispute = entry.relatedDispute as any

        const target =
          event?.title ??
          (organizer ? organizer.organizerProfile?.businessName ?? organizer.fullname : undefined) ??
          '—'

        const amount = refundRequest
          ? `₦${refundRequest.amount.toLocaleString('en-NG')}`
          : dispute
            ? `₦${dispute.amount.toLocaleString('en-NG')}`
            : undefined

        return {
          id: entry._id.toString(),
          type: entry.type,
          action: AUDIT_ACTION_LABELS[entry.type as AdminActivityType] ?? entry.type,
          target,
          amount,
          message: entry.message,
          actorName: (entry.actor as any)?.fullname ?? 'An admin',
          createdAt: entry.createdAt,
        }
      }),
      meta: buildPaginationMeta(page, limit, total),
    },
  })
})

/**
 * Powers the admin Settings > Admins tab — lists every admin account so an
 * owner/admin tier can see who else has access and at what tier.
 */
export const listAdmins = tryCatchWrapper(async (req: Request, res: Response) => {
  const admins = await User.find({ role: 'admin' }).select('-password').sort({ createdAt: 1 }).lean()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Admins fetched',
    body: { admins: admins.map(sanitizeUser) },
  })
})

/**
 * Creates a new admin account at the given tier and emails them an OTP so
 * they can set their own password on first login — mirrors the normal
 * register/verifyEmail OTP flow rather than emailing a temporary password
 * in plaintext. Gated to owner-tier only (see admin.routes.ts).
 */
export const inviteAdmin = tryCatchWrapper(async (req: Request, res: Response) => {
  const { fullname, email, adminRole } = req.body as { fullname: string; email: string; adminRole: 'admin' | 'support' }

  const existing = await User.findOne({ email })
  if (existing) {
    return sendTsRestError(res, 409, 'An account with this email already exists')
  }

  const otp = generateOTP()
  const temporaryPassword = crypto.randomBytes(16).toString('hex')

  const admin = await User.create({
    fullname,
    email,
    password: temporaryPassword,
    role: 'admin',
    adminRole,
    isVerified: false,
    // Only an 'admin'-tier invite gets to set a real password — a
    // 'support'-tier invite stays on the random, never-shown password
    // (see mustSetPassword's comment on the User model) and is routed to
    // the plain login screen after verifying instead of a set-password
    // screen, per how Chloe wants support accounts to work: the invite
    // email still goes out, but a support account can't self-activate a
    // usable login this way. Cleared by setPassword (auth.controller.ts)
    // once an 'admin'-tier invitee actually picks their own.
    mustSetPassword: adminRole === 'admin',
    emailVerificationOTP: otp,
    emailVerificationOTPExpiry: new Date(Date.now() + OTP_TTL_MS),
  })

  EmailService.sendVerifyAccountEmail({
    user: admin,
    otp,
    link: `${process.env.CLIENT_URL ?? ''}/auth/verify-otp?email=${encodeURIComponent(email)}`,
  }).catch(error => logger.error({ err: error }, `Admin-invite email failed for ${admin._id}`))

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'admin_invited',
    message: `Invited ${fullname} as ${adminRole}`,
    relatedOrganizer: admin._id,
  })

  return sendTsRestSuccess(res, 201, {
    success: true,
    message: 'Admin invited — they will receive an email to verify their account and set a password',
    body: sanitizeUser(admin.toObject()),
  })
})

/**
 * Changes an existing admin's tier. Gated to owner-tier only (see
 * admin.routes.ts) — an 'admin'-tier account can't promote itself or
 * anyone else to 'owner'.
 */
export const updateAdminRole = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { adminRole } = req.body as { adminRole: 'owner' | 'admin' | 'support' }

  const admin = await User.findOneAndUpdate({ _id: id, role: 'admin' }, { adminRole }, { new: true })
  if (!admin) return sendTsRestError(res, 404, 'Admin not found')

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'admin_role_changed',
    message: `Changed ${admin.fullname}'s admin tier to ${adminRole}`,
    relatedOrganizer: admin._id,
  })

  return sendTsRestSuccess(res, 200, { success: true, message: 'Admin tier updated', body: sanitizeUser(admin.toObject()) })
})

/**
 * Removes an admin account outright. Gated to owner-tier only (see
 * admin.routes.ts) — same reasoning as inviteAdmin/updateAdminRole, this
 * is account-management, not day-to-day moderation. An owner account can
 * never be deleted this way (including one with adminRole unset, which
 * requireAdminTier's own default treats as owner-tier — see its comment),
 * and an owner can't delete their own account through this endpoint either,
 * so the settings page never ends up with zero admins able to manage it.
 */
export const deleteAdmin = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  if (id === req.session.userId) {
    return sendTsRestError(res, 400, "You can't remove your own admin account")
  }

  const admin = await User.findOne({ _id: id, role: 'admin' })
  if (!admin) {
    return sendTsRestError(res, 404, 'Admin not found')
  }
  if (!admin.adminRole || admin.adminRole === 'owner') {
    return sendTsRestError(res, 400, "Owner accounts can't be removed")
  }

  const removedName = admin.fullname
  const removedId = admin._id.toString()
  await admin.deleteOne()

  // Kick out any active session for the removed account immediately,
  // same as suspendUser does for a suspended attendee/organizer.
  await invalidateUserSessions(removedId)

  logAdminActivity({
    actorId: req.session.userId!,
    type: 'admin_removed',
    message: `Removed admin ${removedName}`,
  })

  return sendTsRestSuccess<undefined>(res, 200, { success: true, message: 'Admin removed' })
})

// PlatformSettings is a singleton — there's only ever one row, created on
// first read/write rather than seeded. Every caller (both endpoints below)
// goes through this instead of querying the model directly, so there's
// exactly one place that creates it.
async function getPlatformSettingsDoc() {
  const existing = await PlatformSettings.findOne()
  if (existing) return existing
  return PlatformSettings.create({})
}

/**
 * Powers the Settings page's Commission rate and Platform Configuration
 * cards (everything except Admin, Teams & Roles, which is User-backed).
 */
export const getPlatformSettings = tryCatchWrapper(async (_req: Request, res: Response) => {
  const settings = await getPlatformSettingsDoc()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Platform settings fetched',
    body: settings.toObject(),
  })
})

/**
 * Partial update — the Settings page saves each control independently
 * (the commission rate's own Save button, a currency Select's
 * onValueChange, a toggle's onCheckedChange), so this accepts and applies
 * whatever subset of fields the caller sends rather than requiring the
 * full object every time.
 *
 * IMPORTANT — currency behavior changed: this used to (per Chloe's original
 * request) actually convert every stored money field platform-wide the
 * moment `currency` changed — ticket prices, event revenue/minPrice, order
 * totals, refund amounts, all rewritten via a live exchange rate inside one
 * CAS-guarded transaction. That mechanism is exactly what caused the
 * currency-corruption incident this platform recovered from (see the
 * restore scripts under scripts/, and the CAS guard that was added to
 * updatePlatformSettings/settings/index.tsx afterward to at least stop it
 * from double-applying).
 *
 * It's retired now, on purpose, not by accident: `currency` here no longer
 * means "what everything is stored in" — TicketType.price is a fixed
 * TICKET_TYPE_CURRENCY (Dollars) and every settlement field (Event
 * revenue/minPrice, Order totals, Ticket price, RefundRequest amount) is a
 * fixed EVENT_LEDGER_CURRENCY (Naira, because that's what Paystack actually
 * charges/refunds) — see the big doc comment in lib/viewerCurrency.ts.
 * Changing `currency` here only changes the sitewide DEFAULT a viewer sees
 * when they haven't set their own currencyPreference (User model); it's a
 * plain, harmless field update, with no data conversion and nothing to
 * race-guard, because nothing stored ever moves.
 */
// Fans an email + in-app notification out to every organizer when the
// commission rate or payout hold changes — called fire-and-forget from
// updatePlatformSettings below (there could be many organizers; the
// admin's save shouldn't wait on emailing all of them). Both messages are
// explicit that this only affects tickets sold from now on — see the
// email templates (platformFeeChangedTemplate/payoutHoldChangedTemplate)
// for the same wording. Deliberately not gated behind any of the existing
// organizerNotificationPreferences toggles (none of them fit "a platform
// setting changed"), same as the attendee-side refund emails elsewhere in
// this file — this is important enough to always send.
async function notifyOrganizersOfPlatformSettingsChange(kind: 'commission' | 'payoutHold', oldValue: string | number, newValue: string | number): Promise<void> {
  try {
    const organizers = await User.find({ role: 'organizer' }).select('fullname email').lean()

    for (const organizer of organizers) {
      try {
        if (kind === 'commission') {
          await EmailService.sendPlatformFeeChangedEmail(organizer, oldValue as number, newValue as number)
          await NotificationService.create({
            recipient: organizer._id,
            type: 'platform_fee_changed',
            title: 'Commission rate is changing',
            message: `Eventra's commission is changing from ${oldValue}% to ${newValue}% — this only applies to tickets sold from now on, not orders already placed.`,
            link: '/dashboard/settings',
          })
        } else {
          await EmailService.sendPayoutHoldChangedEmail(organizer, String(oldValue), String(newValue))
          await NotificationService.create({
            recipient: organizer._id,
            type: 'payout_hold_changed',
            title: 'Payout timing is changing',
            message: `Eventra's payout hold is changing from ${oldValue} to ${newValue} after an event — this only applies to tickets sold from now on, not orders already placed.`,
            link: '/dashboard/payouts',
          })
        }
      } catch (error) {
        logger.error({ err: error, organizerId: organizer._id, kind }, 'Failed to notify organizer of platform settings change')
      }
    }
  } catch (error) {
    logger.error({ err: error, kind }, 'Failed to fan out platform settings change notice to organizers')
  }
}

export const updatePlatformSettings = tryCatchWrapper(async (req: Request, res: Response) => {
  const updates = req.body as Partial<{
    platformFeePercent: number
    currency: 'Naira' | 'Dollar' | 'Cedis' | 'Pound'
    payoutHold: '3 days' | '5 days' | '7 days'
    autoApproveEvents: boolean
    autoApprovePromotions: boolean
    maintenanceMode: boolean
  }>

  const settings = await getPlatformSettingsDoc()
  const previousCurrency = settings.currency
  const previousFeePercent = settings.platformFeePercent
  const previousPayoutHold = settings.payoutHold

  Object.assign(settings, updates)
  await settings.save()

  if (updates.currency && updates.currency !== previousCurrency) {
    logAdminActivity({
      actorId: req.session.userId!,
      type: 'currency_converted',
      message: `Changed the platform's default display currency from ${previousCurrency} to ${updates.currency} (display only — nothing stored was converted)`,
    })
  }

  // Both of these ARE live now (see getCurrentCommissionRate/
  // getCurrentPayoutDelayDays, platformSettings.ts) — they only ever
  // affect orders placed after this moment, never orders/tickets that
  // already exist, since the rate/delay an order uses is locked in at
  // checkout and never recomputed. Every organizer gets told so, both
  // times.
  if (updates.platformFeePercent !== undefined && updates.platformFeePercent !== previousFeePercent) {
    logAdminActivity({
      actorId: req.session.userId!,
      type: 'commission_rate_changed',
      message: `Changed the commission rate from ${previousFeePercent}% to ${updates.platformFeePercent}% (applies to tickets sold from now on only)`,
    })
    notifyOrganizersOfPlatformSettingsChange('commission', previousFeePercent, updates.platformFeePercent)
      .catch(error => logger.error({ err: error }, 'Commission-rate-change organizer notification failed'))
  }

  if (updates.payoutHold && updates.payoutHold !== previousPayoutHold) {
    logAdminActivity({
      actorId: req.session.userId!,
      type: 'payout_hold_changed',
      message: `Changed the payout hold from ${previousPayoutHold} to ${updates.payoutHold} (applies to tickets sold from now on only)`,
    })
    notifyOrganizersOfPlatformSettingsChange('payoutHold', previousPayoutHold, updates.payoutHold)
      .catch(error => logger.error({ err: error }, 'Payout-hold-change organizer notification failed'))
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Platform settings updated',
    body: settings.toObject(),
  })
})

// Distinct from an organizer cancelling their own event (status:
// 'cancelled', which still shows on the organizer's own dashboard as a
// cancelled event they own) — 'removed' is an admin takedown, unpublished
// site-wide the same way listPublicEvents already only ever matches
// status: 'approved'/'postponed'.
export const removeEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { reason } = req.body as { reason?: string }

  const event = await Event.findByIdAndUpdate(id, { status: 'removed', removedReason: reason, flagged: false }, { new: true })
  if (!event) return sendTsRestError(res, 404, 'Event not found')

  return sendTsRestSuccess(res, 200, { success: true, message: 'Event removed', body: event.toObject() })
})

// suspend event (sets status to 'suspended')
export const suspendEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { reason } = req.body as { reason?: string }

  const event = await Event.findByIdAndUpdate(
    id,
    { status: 'suspended', suspendReason: reason },
    { new: true }
  )
  if (!event) return sendTsRestError(res, 404, 'Event not found')

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event suspended',
    body: event.toObject(),
  })
})

// unsuspend event (restores status back to 'approved')
export const unsuspendEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  const event = await Event.findByIdAndUpdate(
    id,
    { status: 'approved', suspendReason: null },
    { new: true }
  )
  if (!event) return sendTsRestError(res, 404, 'Event not found')

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event unsuspended',
    body: event.toObject(),
  })
})
type AdminRevenuePeriod = '7d' | '30d' | '12m'

// null (not 0%) when there's no prior-period baseline to compare against —
// same reasoning as organizer.controller.ts's percentChange.
const percentChange = (current: number, previous: number): number | null =>
  previous > 0 ? Math.round(((current - previous) / previous) * 100) : null

/**
 * Buckets platform revenue (commission on paid orders + approved promotion
 * fees) for the Overview/Revenue charts. Daily buckets for 7d/30d — same
 * shape as organizer.controller.ts's buildRevenueSeries — but 12m buckets
 * by calendar month instead, since "week-of-month" buckets don't make
 * sense across a whole year.
 *
 * Promotion fees don't have their own dated ledger the way orders do (an
 * event only ever holds one `promotion` sub-document, not a payment
 * history), so an approved promotion's fee is attributed to
 * `promotion.paidAt` — the moment it was actually paid for.
 */
async function buildPlatformRevenueSeries(period: AdminRevenuePeriod): Promise<{ label: string; amount: number }[]> {
  const now = new Date()

  if (period === '12m') {
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1)
    const buckets = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
      return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('en-NG', { month: 'short' }), amount: 0 }
    })
    const bucketIndex = new Map(buckets.map((b, i) => [b.key, i]))

    const [orders, promotedEvents] = await Promise.all([
      Order.find({ status: { $in: ['paid', 'partially_refunded'] }, createdAt: { $gte: start } })
        .select('platformFee createdAt')
        .lean(),
      Event.find({ 'promotion.status': 'approved', 'promotion.paidAt': { $gte: start } })
        .select('promotion.package promotion.paidAt')
        .lean(),
    ])

    for (const order of orders) {
      const d = new Date(order.createdAt)
      const i = bucketIndex.get(`${d.getFullYear()}-${d.getMonth()}`)
      if (i !== undefined) buckets[i].amount += order.platformFee
    }
    for (const event of promotedEvents) {
      const paidAt = event.promotion?.paidAt
      if (!paidAt) continue
      const d = new Date(paidAt)
      const i = bucketIndex.get(`${d.getFullYear()}-${d.getMonth()}`)
      const pkg = getPromotionPackage(event.promotion?.package)
      if (i !== undefined && pkg) buckets[i].amount += pkg.priceNaira
    }

    return buckets.map(({ label, amount }) => ({ label, amount }))
  }

  const days = period === '7d' ? 7 : 30
  const start = new Date(now)
  start.setDate(start.getDate() - (days - 1))
  start.setHours(0, 0, 0, 0)

  const dayKey = (d: Date) => new Date(d).toISOString().slice(0, 10)
  const buckets = new Map<string, number>()
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    buckets.set(dayKey(d), 0)
  }

  const [orders, promotedEvents] = await Promise.all([
    Order.find({ status: { $in: ['paid', 'partially_refunded'] }, createdAt: { $gte: start } })
      .select('platformFee createdAt')
      .lean(),
    Event.find({ 'promotion.status': 'approved', 'promotion.paidAt': { $gte: start } })
      .select('promotion.package promotion.paidAt')
      .lean(),
  ])

  for (const order of orders) {
    const key = dayKey(order.createdAt)
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + order.platformFee)
  }
  for (const event of promotedEvents) {
    const paidAt = event.promotion?.paidAt
    if (!paidAt) continue
    const key = dayKey(paidAt)
    const pkg = getPromotionPackage(event.promotion?.package)
    if (buckets.has(key) && pkg) buckets.set(key, (buckets.get(key) ?? 0) + pkg.priceNaira)
  }

  return Array.from(buckets.entries()).map(([date, amount]) => ({ label: date, amount }))
}

/**
 * Powers the admin Revenue page — platform-wide totals, a top-earning
 * events table, and a 6-month commission+promotion breakdown.
 */
export const getAdminRevenue = tryCatchWrapper(async (req: Request, res: Response) => {
  const now = new Date()
  const monthsBack = 6
  const seriesStart = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)

  const [totalsAgg, promotedEvents, topEarningAgg, monthlyOrders, monthlyPromotedEvents, periodTotals, viewerCurrency, currentCommissionRate] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] } } },
      { $group: { _id: null, grossSales: { $sum: '$subtotal' }, commissionRevenue: { $sum: '$platformFee' } } },
    ]),
    Event.find({ 'promotion.status': 'approved' }).select('promotion.package').lean(),
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] } } },
      { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'eventDoc' } },
      { $unwind: '$eventDoc' },
      { $lookup: { from: 'users', localField: 'eventDoc.organizer', foreignField: '_id', as: 'organizerDoc' } },
      { $unwind: '$organizerDoc' },
      {
        $group: {
          _id: '$eventDoc._id',
          eventTitle: { $first: '$eventDoc.title' },
          organizerName: { $first: { $ifNull: ['$organizerDoc.organizerProfile.businessName', '$organizerDoc.fullname'] } },
          commission: { $sum: '$platformFee' },
        },
      },
      { $sort: { commission: -1 } },
      { $limit: 4 },
    ]),
    Order.find({ status: { $in: ['paid', 'partially_refunded'] }, createdAt: { $gte: seriesStart } })
      .select('subtotal platformFee createdAt')
      .lean(),
    Event.find({ 'promotion.status': 'approved', 'promotion.paidAt': { $gte: seriesStart } })
      .select('promotion.package promotion.paidAt')
      .lean(),
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] }, createdAt: { $gte: sixtyDaysAgo } } },
      {
        $group: {
          _id: { $cond: [{ $gte: ['$createdAt', thirtyDaysAgo] }, 'current', 'previous'] },
          platformFee: { $sum: '$platformFee' },
        },
      },
    ]),
    resolveViewerCurrency(req),
    getCurrentCommissionRate(),
  ])

  const grossTicketSales = totalsAgg[0]?.grossSales ?? 0
  const commissionRevenue = totalsAgg[0]?.commissionRevenue ?? 0
  const promotionRevenue = promotedEvents.reduce((sum, e) => sum + (getPromotionPackage(e.promotion?.package)?.priceNaira ?? 0), 0)
  const platformRevenue = commissionRevenue + promotionRevenue

  const currentPlatformFee = periodTotals.find(p => p._id === 'current')?.platformFee ?? 0
  const previousPlatformFee = periodTotals.find(p => p._id === 'previous')?.platformFee ?? 0
  const platformRevenueChangePct = previousPlatformFee > 0
    ? Math.round(((currentPlatformFee - previousPlatformFee) / previousPlatformFee) * 100)
    : null

  const months = Array.from({ length: monthsBack }, (_, i) => {
    const d = new Date(seriesStart.getFullYear(), seriesStart.getMonth() + i, 1)
    return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('en-NG', { month: 'short' }), grossSales: 0, commission: 0, promotion: 0 }
  })
  const monthIndex = new Map(months.map((m, i) => [m.key, i]))

  for (const order of monthlyOrders) {
    const d = new Date(order.createdAt)
    const i = monthIndex.get(`${d.getFullYear()}-${d.getMonth()}`)
    if (i !== undefined) {
      months[i].grossSales += order.subtotal
      months[i].commission += order.platformFee
    }
  }
  for (const event of monthlyPromotedEvents) {
    const paidAt = event.promotion?.paidAt
    if (!paidAt) continue
    const d = new Date(paidAt)
    const i = monthIndex.get(`${d.getFullYear()}-${d.getMonth()}`)
    const pkg = getPromotionPackage(event.promotion?.package)
    if (i !== undefined && pkg) months[i].promotion += pkg.priceNaira
  }

  const revenueBySource = platformRevenue > 0
    ? [
        { label: 'Promotions', amount: promotionRevenue, percent: Math.round((promotionRevenue / platformRevenue) * 100) },
        { label: 'Commission', amount: commissionRevenue, percent: Math.round((commissionRevenue / platformRevenue) * 100) },
      ]
    : []
  // Every figure on this page is derived from EVENT_LEDGER_CURRENCY
  // (Naira) fields (Order.subtotal/platformFee, promotion prices in
  // Naira) — display-only conversion to the admin's chosen currency, same
  // as everywhere else. See lib/viewerCurrency.ts.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Revenue fetched',
    body: {
      grossTicketSales: applyRate(grossTicketSales, ledgerRate),
      commissionRevenue: applyRate(commissionRevenue, ledgerRate),
      promotionRevenue: applyRate(promotionRevenue, ledgerRate),
      platformRevenue: applyRate(platformRevenue, ledgerRate),
      // A percentage, not a money amount — never run through the currency
      // rate (same treatment as getAdminOverview's platformRevenueChangePct).
      platformRevenueChangePct,
      // The live rate from PlatformSettings, not the PLATFORM_COMMISSION_RATE
      // constant — that constant is now only the fallback default (see
      // getCurrentCommissionRate, platformSettings.ts) for orders that
      // predate this field. Showing the constant here after an admin
      // changes the rate would make this card silently lie about what's
      // actually being charged on new orders.
      commissionRatePct: currentCommissionRate * 100,
      revenueBySource,
      currency: viewerCurrency,
      topEarningEvents: topEarningAgg.map(e => ({
        eventId: e._id,
        eventTitle: e.eventTitle,
        organizerName: e.organizerName,
        commission: applyRate(e.commission, ledgerRate),
      })),
      monthlyBreakdown: months.map(m => ({
        label: m.label,
        grossSales: applyRate(m.grossSales, ledgerRate),
        commission: applyRate(m.commission, ledgerRate),
        promotion: applyRate(m.promotion, ledgerRate),
        total: applyRate(m.commission + m.promotion, ledgerRate),
      })),
    },
  })
})

// Legacy fallback only, for orders created before Order.payoutDelayDays
// started being captured per-order at checkout (see getCurrentPayoutDelayDays,
// platformSettings.ts). Mirrors the same fallback in jobs/payoutCron.ts
// (kept as a separate constant here rather than importing it, since this
// file only needs it for display math, not to actually gate anything).
const PAYOUT_DELAY_DAYS = 3

/**
 * Powers the admin Payouts page's top stat cards — held in escrow, ready
 * to release, paid out all-time, and commission collected.
 */
export const getAdminPayoutsOverview = tryCatchWrapper(async (req: Request, res: Response) => {
  const now = new Date()

  const [heldAgg, readyAgg, paidAgg, commissionAgg, eventCount, viewerCurrency] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] }, payoutStatus: { $in: ['pending', 'processing'] } } },
      { $group: { _id: null, total: { $sum: '$organizerEarnings' } } },
    ]),
    Order.aggregate([
      { $match: { status: 'paid', payoutStatus: 'pending' } },
      { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'eventDoc' } },
      { $unwind: '$eventDoc' },
      // Each order's own payoutDelayDays (frozen at creation, see
      // Order.payoutDelayDays) decides its cutoff, falling back to the
      // legacy PAYOUT_DELAY_DAYS for orders that predate that field —
      // same $expr as jobs/payoutCron.ts, kept in sync deliberately so
      // this "ready to release" total always matches what the cron will
      // actually pay out next.
      {
        $match: {
          $expr: {
            $lte: [
              '$eventDoc.startDate',
              {
                $subtract: [
                  now,
                  { $multiply: [{ $ifNull: ['$payoutDelayDays', PAYOUT_DELAY_DAYS] }, 24 * 60 * 60 * 1000] },
                ],
              },
            ],
          },
        },
      },
      { $group: { _id: null, total: { $sum: '$organizerEarnings' } } },
    ]),
    Order.aggregate([
      { $match: { payoutStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: '$organizerEarnings' } } },
    ]),
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] } } },
      { $group: { _id: null, total: { $sum: '$platformFee' } } },
    ]),
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] }, payoutStatus: { $in: ['pending', 'processing'] } } },
      { $group: { _id: '$event' } },
      { $count: 'count' },
    ]),
    resolveViewerCurrency(req),
  ])


  // organizerEarnings/platformFee are EVENT_LEDGER_CURRENCY (Naira) —
  // display-only conversion, same as every other admin money page.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Payouts overview fetched',
    body: {
      heldInEscrow: applyRate(heldAgg[0]?.total ?? 0, ledgerRate),
      heldInEscrowEventsCount: eventCount[0]?.count ?? 0,
      readyToRelease: applyRate(readyAgg[0]?.total ?? 0, ledgerRate),
      paidOutAllTime: applyRate(paidAgg[0]?.total ?? 0, ledgerRate),
      commissionCollected: applyRate(commissionAgg[0]?.total ?? 0, ledgerRate),
      currency: viewerCurrency,
    },
  })
})

/**
 * Powers the "Awaiting payout" table — grouped by organizer+event so an
 * admin releases one event's payout at a time (releaseEventPayout below),
 * rather than per individual order.
 */
export const listAwaitingPayouts = tryCatchWrapper(async (req: Request, res: Response) => {
  const viewerCurrency = await resolveViewerCurrency(req)
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  const groups = await Order.aggregate([
    { $match: { status: 'paid', payoutStatus: { $in: ['pending', 'processing'] } } },
    { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'eventDoc' } },
    { $unwind: '$eventDoc' },
    { $lookup: { from: 'users', localField: 'eventDoc.organizer', foreignField: '_id', as: 'organizerDoc' } },
    { $unwind: '$organizerDoc' },
    {
      $group: {
        _id: { organizer: '$eventDoc.organizer', event: '$eventDoc._id' },
        organizerName: { $first: { $ifNull: ['$organizerDoc.organizerProfile.businessName', '$organizerDoc.fullname'] } },
        eventTitle: { $first: '$eventDoc.title' },
        eventStartDate: { $first: '$eventDoc.startDate' },
        amount: { $sum: '$organizerEarnings' },
        isProcessing: { $max: { $eq: ['$payoutStatus', 'processing'] } },
        // Orders in the same event can, in principle, carry different
        // payoutDelayDays if the admin setting changed between two
        // purchases for that event — $max picks the longest wait among
        // them so this group only ever reads "ready" once every order in
        // it genuinely is, same conservative call the cron effectively
        // makes by checking each order on its own.
        payoutDelayDays: { $max: { $ifNull: ['$payoutDelayDays', PAYOUT_DELAY_DAYS] } },
      },
    },
    { $sort: { eventStartDate: -1 } },
  ])

  const body = groups.map(g => {
    const releaseDate = g.eventStartDate ? new Date(new Date(g.eventStartDate).getTime() + g.payoutDelayDays * 24 * 60 * 60 * 1000) : null
    const status = g.isProcessing ? 'processing' : releaseDate && releaseDate <= new Date() ? 'ready' : 'held'
    return {
      organizerId: g._id.organizer,
      organizerName: g.organizerName,
      eventId: g._id.event,
      eventTitle: g.eventTitle,
      // organizerEarnings is EVENT_LEDGER_CURRENCY (Naira) — display-only
      // conversion, same as every other admin money page.
      amount: applyRate(g.amount, ledgerRate),
      releaseDate,
      status,
    }
  })

  return sendTsRestSuccess(res, 200, { success: true, message: 'Awaiting payouts fetched', body: { payouts: body, currency: viewerCurrency } })
})

export const listPayoutHistory = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const viewerCurrency = await resolveViewerCurrency(req)
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  const groups = await Order.aggregate([
    { $match: { payoutStatus: 'paid' } },
    { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'eventDoc' } },
    { $unwind: '$eventDoc' },
    { $lookup: { from: 'users', localField: 'eventDoc.organizer', foreignField: '_id', as: 'organizerDoc' } },
    { $unwind: '$organizerDoc' },
    {
      $group: {
        _id: { organizer: '$eventDoc.organizer', event: '$eventDoc._id' },
        organizerName: { $first: { $ifNull: ['$organizerDoc.organizerProfile.businessName', '$organizerDoc.fullname'] } },
        eventTitle: { $first: '$eventDoc.title' },
        amount: { $sum: '$organizerEarnings' },
        paidAt: { $max: '$updatedAt' },
      },
    },
    { $sort: { paidAt: -1 } },
    { $skip: skip },
    { $limit: limit },
  ])

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Payout history fetched',
    body: {
      // organizerEarnings is EVENT_LEDGER_CURRENCY (Naira) — display-only
      // conversion, same as every other admin money page.
      payouts: groups.map(g => ({ organizerName: g.organizerName, eventTitle: g.eventTitle, amount: applyRate(g.amount, ledgerRate), paidAt: g.paidAt })),
      currency: viewerCurrency,
      meta: buildPaginationMeta(page, limit, groups.length),
    },
  })
})

/**
 * Manually releases payout early for one organizer+event pair, bypassing
 * the cron's PAYOUT_DELAY_DAYS wait — an admin override for cases like a
 * trusted organizer needing funds before the standard hold clears. Reuses
 * initiateOrderPayout (jobs/payoutCron.ts) so this can never diverge from
 * what the cron itself does per order; once payoutStatus flips to
 * 'processing' here the cron's own `payoutStatus: 'pending'` filter just
 * skips these orders on its next run, so there's no double-payment risk.
 */
export const releaseEventPayout = tryCatchWrapper(async (req: Request, res: Response) => {
  const organizerId = String(req.params.organizerId)
  const eventId = String(req.params.eventId)

  const orders = await Order.aggregate([
    { $match: { event: new mongoose.Types.ObjectId(eventId), status: 'paid', payoutStatus: 'pending' } },
    { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'eventDoc' } },
    { $unwind: '$eventDoc' },
    { $match: { 'eventDoc.organizer': new mongoose.Types.ObjectId(organizerId) } },
  ])

  if (orders.length === 0) {
    return sendTsRestError(res, 404, 'No orders awaiting payout for this organizer/event')
  }

  let released = 0
  let failed = 0
  for (const order of orders) {
    const result = await initiateOrderPayout(order)
    if (result.ok) released++
    else failed++
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: `Released ${released} payout${released === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`,
    body: { released, failed },
  })
})

/**
 * The Admin Console's Overview screen — everything above the fold: the
 * "needs your attention" counts, the four top stat cards, the platform
 * revenue chart, and the Top Organizers ranking. All computed live from
 * Event/User/Order/RefundRequest — nothing here is cached or pre-aggregated.
 *
 * A couple of things the Figma shows have no backing data model yet
 * (payment disputes, a distinct refund "investigate" queue, and any kind
 * of admin-action audit trail) — those come back as `null`/empty here
 * rather than a made-up number, and the client should render an honest
 * "not tracked yet" state for them instead of a fake stat. Flagged events
 * DO have a real count now (via Event.flagged), unlike those.
 */
export const getAdminOverview = tryCatchWrapper(async (req: Request, res: Response) => {
  const period: AdminRevenuePeriod = req.query.period === '7d' || req.query.period === '12m' ? req.query.period : '30d'

  const now = new Date()
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)

  const [
    pendingEventsCount,
    organizersToVerifyCount,
    promotionsPendingCount,
    pendingRefundsCount,
    flaggedEventsCount,
    salesAgg,
    approvedPromotedEvents,
    activeEventsCount,
    organizersWithActiveEvent,
    escrowAgg,
    periodTotals,
    grossLast30d,
    refundedLast30d,
    newOrganizersToday,
    topOrganizersAgg,
    revenueSeries,
    openPaymentDisputesCount,
    recentActivityLogs,
    viewerCurrency,
    currentCommissionRate,
  ] = await Promise.all([
    Event.countDocuments({ status: 'pending_approval' }),
    User.countDocuments({ role: 'organizer', 'organizerProfile.approvalStatus': 'pending' }),
    Event.countDocuments({ 'promotion.status': 'pending', 'promotion.paidAt': { $exists: true } }),
    RefundRequest.countDocuments({ status: 'pending' }),
    Event.countDocuments({ flagged: true }),
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] } } },
      { $group: { _id: null, grossSales: { $sum: '$subtotal' }, commissionRevenue: { $sum: '$platformFee' } } },
    ]),
    Event.find({ 'promotion.status': 'approved' }).select('promotion.package').lean(),
    Event.countDocuments({ status: { $in: ['approved', 'postponed'] } }),
    Event.distinct('organizer', { status: { $in: ['approved', 'postponed'] } }),
    Order.aggregate([
      {
        $match: {
          status: { $in: ['paid', 'partially_refunded'] },
          payoutStatus: { $in: ['not_due', 'pending', 'processing'] },
        },
      },
      { $group: { _id: null, held: { $sum: '$organizerEarnings' } } },
    ]),
    // "vs last month" on the Platform Revenue stat card — commission only,
    // same as the chart series (promotion fees are folded in separately
    // below since they're not on the Order model).
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] }, createdAt: { $gte: sixtyDaysAgo } } },
      {
        $group: {
          _id: { $cond: [{ $gte: ['$createdAt', thirtyDaysAgo] }, 'current', 'previous'] },
          platformFee: { $sum: '$platformFee' },
        },
      },
    ]),
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded', 'refunded'] }, createdAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: null, gross: { $sum: '$subtotal' } } },
    ]),
    Order.aggregate([
      { $match: { refundedAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: null, refunded: { $sum: '$refundAmount' } } },
    ]),
    User.countDocuments({ role: 'organizer', createdAt: { $gte: startOfToday } }),
    Order.aggregate([
      { $match: { status: { $in: ['paid', 'partially_refunded'] } } },
      { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'eventDoc' } },
      { $unwind: '$eventDoc' },
      { $group: { _id: '$eventDoc.organizer', grossSales: { $sum: '$subtotal' } } },
      { $sort: { grossSales: -1 } },
      { $limit: 4 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'organizer' } },
      { $unwind: '$organizer' },
      {
        $project: {
          _id: 0,
          organizerId: '$organizer._id',
          businessName: { $ifNull: ['$organizer.organizerProfile.businessName', '$organizer.fullname'] },
          grossSales: 1,
        },
      },
    ]),
    buildPlatformRevenueSeries(period),
    PaymentDispute.countDocuments({ status: 'pending' }),
    AdminActivityLog.find()
      .populate('actor', 'fullname')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    resolveViewerCurrency(req),
    getCurrentCommissionRate(),
  ])

  const grossTicketSales = salesAgg[0]?.grossSales ?? 0
  const commissionRevenue = salesAgg[0]?.commissionRevenue ?? 0
  const promotionRevenue = approvedPromotedEvents.reduce((sum, event) => {
    const pkg = getPromotionPackage(event.promotion?.package)
    return sum + (pkg?.priceNaira ?? 0)
  }, 0)
  const platformRevenue = commissionRevenue + promotionRevenue
  const heldInEscrow = escrowAgg[0]?.held ?? 0

  const currentPlatformFee = periodTotals.find(p => p._id === 'current')?.platformFee ?? 0
  const previousPlatformFee = periodTotals.find(p => p._id === 'previous')?.platformFee ?? 0

  const gross30d = grossLast30d[0]?.gross ?? 0
  const refunded30d = refundedLast30d[0]?.refunded ?? 0
  const refundRate30d = gross30d > 0 ? Math.round((refunded30d / gross30d) * 1000) / 10 : 0

  // Every money figure here (subtotal/platformFee/organizerEarnings, plus
  // promotion prices) is EVENT_LEDGER_CURRENCY (Naira) — display-only
  // conversion to the admin's chosen currency, same as every other admin
  // money page. See lib/viewerCurrency.ts.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Admin overview fetched',
    body: {
      currency: viewerCurrency,
      needsAction: {
        pendingEventsCount,
        organizersToVerifyCount,
        promotionsPendingCount,
        pendingRefundsCount,
        // No distinction in the data model between a routine refund
        // request and one that needs escalation — `null`, not a
        // fabricated count. See the doc comment above.
        refundsToInvestigateCount: null,
      },
      stats: {
        grossTicketSales: applyRate(grossTicketSales, ledgerRate),
        platformRevenue: applyRate(platformRevenue, ledgerRate),
        // Commission-only comparison — promotion revenue isn't dated
        // finely enough (see buildPlatformRevenueSeries) to include in a
        // clean period-over-period delta. A percentage, so it doesn't need
        // conversion either way.
        platformRevenueChangePct: percentChange(currentPlatformFee, previousPlatformFee),
        heldInEscrow: applyRate(heldInEscrow, ledgerRate),
        activeEventsCount,
        activeOrganizersCount: organizersWithActiveEvent.length,
        // The live rate from PlatformSettings — same field/reasoning as
        // getAdminRevenue's commissionRatePct below. The Overview page's
        // Platform Revenue card used to hardcode "Commission (5%) +
        // promotion fees" as static caption text; this is what lets that
        // caption follow whatever commission % is actually set instead of
        // silently going stale the moment an admin changes it in Settings.
        commissionRatePct: currentCommissionRate * 100,
      },
      revenueSeries: revenueSeries.map(point => ({ ...point, amount: applyRate(point.amount, ledgerRate) })),
      trustAndSafety: {
        flaggedEventsCount,
        // Real Paystack chargebacks — see PaymentDispute and
        // handleDisputeWebhook in payment.controller.ts. Was `null` before
        // any dispute tracking existed; now a genuine count.
        openPaymentDisputesCount,
        refundRate30d,
        newOrganizersToday,
      },
      topOrganizers: topOrganizersAgg.map(o => ({ ...o, grossSales: applyRate(o.grossSales, ledgerRate) })),
      // Real admin-action audit trail — see AdminActivityLog and
      // logAdminActivity, called from every approve/reject/flag action
      // above. Raw log entries, not pre-rendered display segments — the
      // frontend maps `type` to an icon/tone and `message` to display text.
      recentActivity: recentActivityLogs.map(entry => ({
        id: entry._id.toString(),
        type: entry.type,
        message: entry.message,
        actorName: (entry.actor as any)?.fullname ?? 'An admin',
        createdAt: entry.createdAt,
      })),
    },
  })
})
