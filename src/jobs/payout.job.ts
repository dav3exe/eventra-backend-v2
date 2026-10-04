import logger from '../config/logger.js'
import Order from '../models/order.model.js'
import User from '../models/user.model.js'
import { PaystackService } from '../services/paystack.service.js'

// Legacy fallback only — used for orders created before payoutDelayDays
// started being captured per-order (see Order.payoutDelayDays, set at
// creation from PlatformSettings.payoutHold via getCurrentPayoutDelayDays
// in platformSettings.ts). Never used for a new order: a new order always
// carries its own payoutDelayDays, frozen at whatever the admin setting
// was the moment it was placed, so changing that setting later can only
// ever affect orders placed after the change.
const PAYOUT_DELAY_DAYS = 3

/**
 * Initiates the actual Paystack transfer for one paid order and flips it to
 * 'processing' (payment.controller.ts's webhook is what moves it to 'paid'
 * once Paystack confirms with a transfer.success event). Pulled out of
 * processDuePayouts so admin.controller.ts's manual "Release" action can
 * run the exact same transfer path instead of a second, possibly-diverging
 * copy of this logic — the only difference between the cron and a manual
 * release is which orders get selected, not what happens to each one.
 */
export async function initiateOrderPayout(order: {
  _id: any
  organizerEarnings: number
  eventDoc: { _id: any; organizer: any; title?: string }
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const organizer = await User.findById(order.eventDoc.organizer)
  const recipientCode = organizer?.organizerProfile?.paystackRecipientCode

  if (!organizer || !recipientCode) {
    return { ok: false, reason: 'Organizer has no Paystack recipient on file' }
  }

  try {
    await PaystackService.initiateTransfer({
      amountKobo: Math.round(order.organizerEarnings * 100),
      recipientCode,
      reason: `Eventra payout — ${order.eventDoc.title ?? 'event'}`,
      reference: `PAYOUT-${order._id}`,
    })

    await Order.updateOne({ _id: order._id }, { $set: { payoutStatus: 'processing' } })
    return { ok: true }
  } catch (error: any) {
    return { ok: false, reason: error.message || 'Transfer failed' }
  }
}

/**
 * Finds paid orders for events that happened at least PAYOUT_DELAY_DAYS ago
 * and initiates a Paystack transfer to the organizer for each.
 * Called by a scheduled cron job, same pattern as the email cron.
 */
export const processDuePayouts = async (): Promise<{ processed: number; initiated: number; skipped: number }> => {
  let initiated = 0
  let skipped = 0

  const now = new Date()

  const dueOrders = await Order.aggregate([
    { $match: { status: 'paid', payoutStatus: 'pending' } },
    { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'eventDoc' } },
    { $unwind: '$eventDoc' },
    // Each order's own payoutDelayDays (frozen at creation) decides its
    // cutoff — not a single global one — so an order predating this field
    // still uses the legacy PAYOUT_DELAY_DAYS wait untouched.
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
    { $limit: 25 },
  ])

  if (dueOrders.length === 0) {
    logger.info('Payout cron: no payouts due')
    return { processed: 0, initiated: 0, skipped: 0 }
  }

  for (const order of dueOrders) {
    const result = await initiateOrderPayout(order)
    if (result.ok) {
      initiated++
    } else {
      logger.error(`Payout cron: ${result.reason} — skipping order ${order._id}`)
      skipped++
    }
  }

  logger.info({ initiated, skipped }, 'Payout cron: batch complete')
  return { processed: dueOrders.length, initiated, skipped }
}
