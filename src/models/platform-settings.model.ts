import mongoose, { Document, Schema } from 'mongoose'

// A singleton document — there is exactly one PlatformSettings row ever,
// found/created via getPlatformSettingsDoc in admin.controller.ts rather
// than looked up by any particular id. Powers the admin Settings page's
// Commission rate / Platform Configuration cards (everything on that page
// except the Admin, Teams & Roles card, which reads/writes User directly).
export interface IPlatformSettings extends Document {
  _id: mongoose.Types.ObjectId
  // Percentage points (e.g. 3 means 3%), matches the NumberStepper on the
  // Commission rate card directly — no unit conversion either side.
  platformFeePercent: number
  // Kept as the exact display strings the Settings page's <Select> already
  // uses as option values ("Naira" / "Dollar" / "Cedis" / "Pound", "3 days"
  // / "5 days" / "7 days") rather than normalized codes/numbers, so the
  // frontend needs zero translation layer between what it sends and what
  // it renders back.
  //
  // Purely a DISPLAY default now — the currency shown to a viewer who
  // hasn't set a personal currencyPreference (see models/user.ts and
  // lib/viewerCurrency.ts). It no longer converts anything when changed;
  // see updatePlatformSettings (admin.controller.ts) for why.
  currency: 'Naira' | 'Dollar' | 'Cedis' | 'Pound'
  payoutHold: '3 days' | '5 days' | '7 days'
  autoApproveEvents: boolean
  autoApprovePromotions: boolean
  maintenanceMode: boolean
  updatedAt: Date
  createdAt: Date
}

const PlatformSettingsSchema = new Schema<IPlatformSettings>(
  {
    platformFeePercent: { type: Number, required: true, min: 0, max: 100, default: 3 },
    currency: { type: String, enum: ['Naira', 'Dollar', 'Cedis', 'Pound'], default: 'Naira' },
    payoutHold: { type: String, enum: ['3 days', '5 days', '7 days'], default: '3 days' },
    autoApproveEvents: { type: Boolean, default: false },
    autoApprovePromotions: { type: Boolean, default: false },
    maintenanceMode: { type: Boolean, default: false },
  },
  { timestamps: true }
)

const PlatformSettings =
  mongoose.models.PlatformSettings ||
  mongoose.model<IPlatformSettings>('PlatformSettings', PlatformSettingsSchema, 'platform_settings')

export default PlatformSettings

// These two used to be dead ends: platformFeePercent/payoutHold saved to
// the database fine but nothing ever read them back — the real commission
// calculation (order.ts's PLATFORM_COMMISSION_RATE) and the real payout
// wait (payoutCron.ts / admin.controller.ts's PAYOUT_DELAY_DAYS) were both
// hardcoded constants. These two helpers are what actually wires them up.
//
// Both are read once, at the moment a NEW order is created (see
// calculateOrderTotals's rate param in order.ts, and the payoutDelayDays
// field captured on Order at creation in ticket.controller.ts) — never
// re-read later to recompute something already stored. That's deliberate:
// an admin changing these settings must only affect orders placed after
// the change, never rewrite the commission or payout timing an
// already-existing order already locked in. Same reasoning as the
// currency-conversion incident documented on updatePlatformSettings above
// — nothing already stored ever moves.
const DEFAULT_PLATFORM_FEE_PERCENT = 3 // mirrors the schema default above
const DEFAULT_PAYOUT_HOLD: IPlatformSettings['payoutHold'] = '3 days' // mirrors the schema default above

const PAYOUT_HOLD_TO_DAYS: Record<IPlatformSettings['payoutHold'], number> = {
  '3 days': 3,
  '5 days': 5,
  '7 days': 7,
}

/** The commission rate to charge right now, as a fraction (e.g. 0.03 for 3%). */
export async function getCurrentCommissionRate(): Promise<number> {
  const settings = await PlatformSettings.findOne().select('platformFeePercent').lean()
  const percent = settings?.platformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT
  return percent / 100
}

/** The number of days to hold funds after an event before payout is due, right now. */
export async function getCurrentPayoutDelayDays(): Promise<number> {
  const settings = await PlatformSettings.findOne().select('payoutHold').lean()
  const holdLabel: IPlatformSettings['payoutHold'] = settings?.payoutHold ?? DEFAULT_PAYOUT_HOLD
  return PAYOUT_HOLD_TO_DAYS[holdLabel] ?? PAYOUT_HOLD_TO_DAYS[DEFAULT_PAYOUT_HOLD]
}
