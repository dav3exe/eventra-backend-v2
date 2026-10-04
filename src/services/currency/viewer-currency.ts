import { Request } from 'express'
import User from '../../models/user.model.js'
import { getExchangeRate } from './exchange-rate.js'

export type Currency = 'Naira' | 'Dollar' | 'Cedis' | 'Pound'

// ---------------------------------------------------------------------
// The two fixed "ledger" currencies — what a stored amount actually IS,
// not what anyone chooses to look at. Neither of these is admin-editable
// or ever changes for an existing record; they describe real, settled
// facts:
//
//   EVENT_LEDGER_CURRENCY (Naira) — Event.minPrice/revenueTotal,
//   Order.subtotal/platformFee/organizerEarnings/total/refundAmount,
//   Ticket.price, RefundRequest.amount. These are what actually moved
//   through Paystack — Paystack only charges/refunds this account in NGN
//   (see PaystackService), so every one of these fields is a real Naira
//   amount and always will be, regardless of what currency anyone is
//   looking at it in.
//
//   TICKET_TYPE_CURRENCY (Dollar) — TicketType.price. This is the
//   organizer's master/list price for a ticket, kept in a currency that
//   doesn't drift with Naira's exchange rate over time. An organizer can
//   type a price in any of the three currencies when creating/editing a
//   ticket type (see ticketType.controller.ts) — whatever they type is
//   converted to Dollars once, at save time, and that's what's stored.
//   Everything downstream (checkout, Event.minPrice, revenue) is derived
//   FROM this by converting to Naira at the moment it's needed, since
//   that's the currency that actually gets charged and paid out.
//
// Changing PlatformSettings.currency does NOT touch either of these
// anymore — it only picks the sitewide DEFAULT for what a viewer with no
// personal currencyPreference sees. See updatePlatformSettings
// (admin.controller.ts) for the previous, since-retired behavior where a
// currency change actually rewrote every stored amount — that's exactly
// the mechanism that caused the corruption fixed earlier, and is no
// longer needed now that the ledger currencies above are fixed constants
// instead of following an admin setting.
// ---------------------------------------------------------------------
export const EVENT_LEDGER_CURRENCY: Currency = 'Naira'
export const TICKET_TYPE_CURRENCY: Currency = 'Dollar'

// The fixed fallback for any viewer with no personal currencyPreference
// (signed out, or signed in but never set one) — always Naira, never a
// mutable setting. This used to fall back to PlatformSettings.currency,
// but that field can be left sitting on whatever it was last set to
// (e.g. from earlier testing of the now-retired Platform Configuration
// currency control), so a logged-out visitor could see prices in
// whatever currency an admin happened to leave that in — reported as
// "why is the default in Cedis, not Naira." Per Chloe's explicit
// instruction, this default no longer depends on PlatformSettings.currency
// at all — it's always Naira. PlatformSettings.currency itself is left
// alone on the model/schema (additive-only), it's just no longer read here.
const DEFAULT_VIEWER_CURRENCY: Currency = 'Naira'

/**
 * Resolves the currency a viewer should see amounts in: their own
 * currencyPreference if they're signed in and have set one, otherwise the
 * fixed platform default (always Naira — see DEFAULT_VIEWER_CURRENCY above).
 *
 * Works for both authenticated and anonymous requests — several callers
 * (listPublicEvents, getSpotlightEvents, getEventBySlug) are fully public
 * routes with no verifySession middleware, so req.session?.userId is read
 * optionally here, never required.
 */
export async function resolveViewerCurrency(req: Request): Promise<Currency> {
  const userId = req.session?.userId
  if (userId) {
    const user = await User.findById(userId).select('currencyPreference')
    if (user?.currencyPreference) return user.currencyPreference
  }
  return DEFAULT_VIEWER_CURRENCY
}

/**
 * A live conversion rate from one currency to another, for DISPLAY only —
 * never used to touch stored data. 1 when the two currencies are the same
 * (skips the network call entirely, which is the common case: most
 * viewers never change their currency preference away from the default).
 */
export async function getDisplayRate(from: Currency, to: Currency): Promise<number> {
  if (from === to) return 1
  return getExchangeRate(from, to)
}

/** Applies an already-resolved display rate to a single amount, rounded to 2dp. */
export function applyRate(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100
}

/**
 * Same as applyRate, but snaps the result to the nearest ₦1,000 instead
 * of the nearest kobo. TicketType.price is stored in Dollars
 * (TICKET_TYPE_CURRENCY) while the vast majority of viewers see Naira by
 * default — converting Dollars back to Naira on a live, moving exchange
 * rate almost never lands on the clean round figure an organizer actually
 * priced their ticket at (₦10,000 comes back as ₦9,996.09-ish, and drifts
 * a little more every time the rate moves), so this snap removes that
 * noise. Every ticket type on this platform is priced in round thousands,
 * so nothing meaningful is lost.
 *
 * Only ever used on a TicketType.price → Naira conversion (see the call
 * sites in ticketType.controller.ts, event.controller.ts,
 * admin.controller.ts, ticket.controller.ts). Never used on an
 * already-Naira ledger figure (Order/Ticket/RefundRequest/
 * Event.revenueTotal) — those are exact, real settled amounts and must
 * never be rounded away from what actually happened.
 */
export function applyRateToNaira(amount: number, rate: number): number {
  return Math.round((amount * rate) / 1000) * 1000
}

/**
 * Picks applyRateToNaira when the viewer is looking at Naira (the common
 * case, and the one that needs the snap), applyRate (plain 2dp) for
 * anyone who's chosen Dollar/Cedis/Pound instead — those are naturally
 * small numbers where a ₦1,000-sized snap would make no sense.
 */
export function applyTicketTypeRate(amount: number, rate: number, targetCurrency: Currency): number {
  return targetCurrency === 'Naira' ? applyRateToNaira(amount, rate) : applyRate(amount, rate)
}
