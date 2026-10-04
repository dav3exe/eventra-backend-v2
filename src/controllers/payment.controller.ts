import crypto from 'crypto'
import { Request, Response } from 'express'
import { env } from '../config/keys.js'
import logger from '../config/logger.js'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import Event from '../models/event.model.js'
import Order from '../models/order.model.js'
import PaymentDispute from '../models/payment-dispute.model.js'
import User from '../models/user.model.js'
import { PaystackService } from '../services/paystack.service.js'
import { TicketService } from '../services/ticket.service.js'
import { EmailService } from '../services/email/email.service.js'
import { NotificationService } from '../services/notification.service.js'
import type { AttendeeInfo } from '../services/attendee.service.js'
import PlatformSettings from '../models/platform-settings.model.js'
import { getPromotionPackage } from '../config/promotion-packages.js'

/**
 * Verifies the `x-paystack-signature` header against the raw request body.
 * Paystack docs: HMAC SHA512 of the raw payload, keyed with the secret key.
 */
const isValidPaystackSignature = (req: Request): boolean => {
  const signature = req.headers['x-paystack-signature']
  if (!signature || !req.rawBody) return false

  const hash = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(req.rawBody).digest('hex')

  return hash === signature
}

/**
 * Re-verifies a ticket-order payment directly against Paystack and, if
 * confirmed, issues tickets — idempotent (safe to call repeatedly for the
 * same reference). This is the single source of truth for "did this order
 * get paid", used by both:
 *  - the Paystack webhook (paystackWebhook below), which is how this is
 *    *supposed* to fire — near-instant, server-to-server
 *  - getOrderByReference (ticket.controller.ts), as a fallback — webhooks
 *    require Paystack's servers to be able to reach ours, which fails
 *    silently in local dev (localhost isn't publicly reachable) or if the
 *    webhook URL in the Paystack dashboard is stale/unset. Without a
 *    fallback, the order just sits 'pending' forever even though Paystack
 *    already confirmed the charge — which is exactly what polling the
 *    checkout-callback page against a never-updating order looks like.
 */
export const handleTicketOrderPayment = async (reference: string): Promise<void> => {
  const order = await Order.findOne({ paystackReference: reference })
  if (!order) {
    logger.error(`Paystack webhook: no order found for reference ${reference}`)
    return
  }

  // Idempotency: webhooks can be delivered more than once. If we've already
  // issued tickets for this order, do nothing further.
  if (order.status === 'paid') return

  // Never trust the webhook body alone — re-verify directly against Paystack.
  const verification = await PaystackService.verifyTransaction(reference)

  const expectedKobo = Math.round(order.total * 100)
  if (verification.status !== 'success' || verification.amountKobo !== expectedKobo) {
    order.status = 'failed'
    await order.save()
    logger.error(`Paystack webhook: verification mismatch for reference ${reference}`)
    return
  }

  let attendee: AttendeeInfo
  if (order.buyer) {
    const buyer = await User.findById(order.buyer)
    if (!buyer) {
      logger.error(`Paystack webhook: buyer not found for order ${order._id}`)
      return
    }
    attendee = { userId: buyer._id.toString(), fullname: buyer.fullname, email: buyer.email, phone: buyer.phone }
  } else if (order.guestEmail && order.guestName) {
    attendee = { fullname: order.guestName, email: order.guestEmail, phone: order.guestPhone }
  } else {
    logger.error(`Paystack webhook: order ${order._id} has neither a buyer nor guest contact details`)
    return
  }

  try {
    await TicketService.issueTicketsForPaidOrder(order, attendee)
  } catch (error: any) {
    // Stock ran out between checkout and payment confirmation — mark for a refund,
    // an admin/organizer must resolve this manually per the PRD's refund process.
    order.status = 'failed'
    await order.save()
    logger.error(`Paystack webhook: ticket issuance failed for order ${order._id}: ${error.message}`)
  }
}

export const handlePromotionPayment = async (reference: string): Promise<void> => {
  const event = await Event.findOne({ 'promotion.paystackReference': reference })
  if (!event || !event.promotion) {
    logger.error(`Paystack webhook: no event found for promotion reference ${reference}`)
    return
  }
  if (event.promotion.paidAt) return // already confirmed

  const verification = await PaystackService.verifyTransaction(reference)
  if (verification.status !== 'success') {
    logger.error(`Paystack webhook: promotion payment verification failed for ${reference}`)
    return
  }

  // Payment confirmed, but it still awaits admin approval before going live.
   // Payment confirmed. If auto-approve is on, skip the review queue entirely
  // and activate the promotion right away — same status/dates/isPromoted
  // fields approveEventPromotion (admin.controller.ts) sets by hand.
  event.promotion.paidAt = new Date()

  const platformSettings = await PlatformSettings.findOne()

  if (platformSettings?.autoApprovePromotions) {
    const pkg = getPromotionPackage(event.promotion.package)
    const durationDays = pkg?.durationDays ?? 7
    const startsAt = new Date()
    const endsAt = new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000)

    event.promotion.status = 'approved'
    event.promotion.startsAt = startsAt
    event.promotion.endsAt = endsAt
    event.isPromoted = true
    await event.save()
    return
  }

  await event.save()
  NotificationService.notifyAdmins({
    type: 'promotion_requested',
    title: 'New promotion awaiting review',
    message: `Payment confirmed for "${event.title}"'s promotion — it's ready for approval.`,
    link: '/admin/events',
    relatedEvent: event._id,
  }).catch(error => logger.error({ err: error }, `Promotion-requested notification failed for event ${event._id}`))
}

const handleTransferOutcome = async (event: string, reference: string): Promise<void> => {
  // Our payout references are formatted PAYOUT-<orderId>
  const orderId = reference.replace(/^PAYOUT-/, '')
  const order = await Order.findById(orderId)
  if (!order) {
    logger.error(`Paystack webhook: no order found for payout reference ${reference}`)
    return
  }

  if (event === 'transfer.success') {
    order.payoutStatus = 'paid'
    order.payoutAt = new Date()
    await order.save()

    const eventDoc = await Event.findById(order.event).select('title organizer')
    if (eventDoc) {
      const organizer = await User.findById(eventDoc.organizer)
      // Opt-in — defaults to off, see organizerNotificationPreferences on
      // the User model and the "Payout confirmations" toggle on Settings.
      if (organizer && organizer.organizerNotificationPreferences?.payoutConfirmations) {
        EmailService.sendPayoutConfirmationEmail(organizer, eventDoc.title, `₦${order.organizerEarnings.toLocaleString('en-NG')}`).catch(
          error => logger.error({ err: error }, `Payout-confirmation email failed for order ${order._id}`)
        )
      }
    }
  } else {
    // transfer.failed / transfer.reversed — leave it for the next payout cron run to retry.
    order.payoutStatus = 'pending'
    await order.save()
    logger.error(`Paystack webhook: transfer ${event} for order ${order._id}`)
  }
}

/**
 * Handles Paystack's dispute (chargeback) webhooks — a customer disputed a
 * charge directly with their bank/card issuer, separate from an in-app
 * RefundRequest. Populates PaymentDispute, which is what "Open payment
 * disputes" on the admin Overview page counts.
 *
 * NOTE: Paystack's dispute payload shape below (transaction reference
 * location, status/resolution field names) is written from their
 * documented webhook format, but hasn't been exercised against a real
 * dispute yet — there's no way to generate one outside of an actual
 * chargeback. Treat this as a solid first pass; if a real dispute webhook
 * ever fails to parse as expected, log the raw payload and adjust the
 * field lookups below to match what Paystack actually sent.
 */
const handleDisputeWebhook = async (event: string, data: any): Promise<void> => {
  const disputeId = data?.id ? String(data.id) : undefined
  if (!disputeId) {
    logger.error(`Paystack webhook: ${event} had no dispute id in payload`)
    return
  }

  const reference: string | undefined = data?.transaction?.reference ?? data?.transaction_reference
  const amountKobo = Number(data?.refund_amount ?? data?.amount ?? 0)
  const amount = amountKobo > 0 ? amountKobo / 100 : 0

  let order = reference ? await Order.findOne({ paystackReference: reference }) : null

  if (event === 'charge.dispute.resolve') {
    // "resolution" is Paystack's own outcome field on a resolved dispute —
    // treat anything that reads as the merchant losing as 'lost', anything
    // else (merchant-accepted in our favor, declined against the customer,
    // etc.) as 'resolved'. Falls back to 'resolved' when ambiguous, since
    // that's the safer default for what an admin sees in "open disputes".
    const resolution = String(data?.resolution ?? data?.status ?? '').toLowerCase()
    const lost = resolution.includes('lost') || resolution.includes('merchant-declined')

    await PaymentDispute.findOneAndUpdate(
      { paystackDisputeId: disputeId },
      {
        paystackDisputeId: disputeId,
        paystackReference: reference ?? '',
        order: order?._id,
        event: order?.event,
        amount,
        reason: data?.category ?? data?.reason,
        status: lost ? 'lost' : 'resolved',
        raisedAt: data?.createdAt ? new Date(data.createdAt) : new Date(),
        resolvedAt: new Date(),
      },
      { upsert: true }
    )
    return
  }

  // charge.dispute.create / charge.dispute.remind — record or refresh as
  // still pending. Upserted on paystackDisputeId so a "remind" webhook for
  // a dispute we already recorded doesn't create a duplicate.
  await PaymentDispute.findOneAndUpdate(
    { paystackDisputeId: disputeId },
    {
      paystackDisputeId: disputeId,
      paystackReference: reference ?? '',
      order: order?._id,
      event: order?.event,
      amount,
      reason: data?.category ?? data?.reason,
      status: 'pending',
      raisedAt: data?.createdAt ? new Date(data.createdAt) : new Date(),
    },
    { upsert: true, setDefaultsOnInsert: true }
  )
}

export const paystackWebhook = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!isValidPaystackSignature(req)) {
    logger.warn('Rejected Paystack webhook with invalid signature')
    return sendTsRestError(res, 401, 'Invalid signature')
  }

  const { event, data } = req.body
  const reference: string | undefined = data?.reference

  if (event === 'charge.success' && reference?.startsWith('PROMO-')) {
    await handlePromotionPayment(reference)
  } else if (event === 'charge.success' && reference) {
    await handleTicketOrderPayment(reference)
  } else if ((event === 'transfer.success' || event === 'transfer.failed' || event === 'transfer.reversed') && reference) {
    await handleTransferOutcome(event, reference)
  } else if (
    event === 'charge.dispute.create' ||
    event === 'charge.dispute.remind' ||
    event === 'charge.dispute.resolve'
  ) {
    await handleDisputeWebhook(event, data)
  }
  // Anything else is acknowledged and ignored, so Paystack doesn't retry forever.

  return sendTsRestSuccess<undefined>(res, 200, { success: true, message: 'Webhook processed' })
})
