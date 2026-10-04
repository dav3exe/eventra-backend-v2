import mongoose, { Document, Schema } from 'mongoose'

// Powers the admin Overview page's "Recent activity" card. Every admin
// moderation action (approve/reject an event, verify an organizer,
// approve/reject a refund, flag/unflag an event or organizer, approve/reject a
// promotion) writes one entry here — see logAdminActivity in
// lib/adminActivity.ts, called from admin.controller.ts.
export type AdminActivityType =
  | 'event_approved'
  | 'event_rejected'
  | 'event_suspended'
  | 'event_unsuspended'
  | 'event_flagged'
  | 'event_unflagged'
  | 'organizer_approved'
  | 'organizer_rejected'
  | 'organizer_suspended'
  | 'organizer_unsuspended'
  | 'refund_approved'
  | 'refund_rejected'
  | 'promotion_approved'
  | 'promotion_rejected'
  | 'dispute_challenged'
  | 'dispute_accepted_loss'
  // Organizer flag/unflag (admin.controller.ts's flagOrganizer/
  // unflagOrganizer/dismissOrganizerFlag — mirrors event_flagged/
  // event_unflagged above, just scoped to an organizer's profile) and the
  // admin-invite + role-management feature (inviteAdmin/updateAdminRole).
  | 'organizer_flagged'
  | 'organizer_unflagged'
  | 'admin_invited'
  | 'admin_role_changed'
  // Owner deleted another admin's account (deleteAdmin, admin.controller.ts).
  | 'admin_removed'
  // Owner switched the platform's currency (updatePlatformSettings), which
  // converts every stored money field platform-wide using a live exchange
  // rate — see lib/exchangeRate.ts.
  | 'currency_converted'
  // Admin soft-deleted/restored an attendee or organizer account
  // (deleteUser/restoreUser, admin.controller.ts). Distinct from
  // admin_removed above, which is for removing another *admin* account.
  | 'user_deleted'
  | 'user_restored'
  // Owner changed the commission rate or payout hold on the Settings page
  // (updatePlatformSettings) — unlike currency_converted, these DO change
  // real behavior, but only for orders placed after the change; every
  // organizer also gets emailed/notified when either changes (see
  // NotificationService.notifyOrganizers there).
  | 'commission_rate_changed'
  | 'payout_hold_changed'

export interface IAdminActivityLog extends Document {
  _id: mongoose.Types.ObjectId
  actor: mongoose.Types.ObjectId
  type: AdminActivityType
  message: string
  relatedEvent?: mongoose.Types.ObjectId
  relatedOrganizer?: mongoose.Types.ObjectId
  relatedRefundRequest?: mongoose.Types.ObjectId
  relatedDispute?: mongoose.Types.ObjectId
  createdAt: Date
}

const AdminActivityLogSchema = new Schema<IAdminActivityLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: [
        'event_approved',
        'event_rejected',
        'event_suspended',
        'event_unsuspended',
        'event_flagged',
        'event_unflagged',
        'organizer_approved',
        'organizer_rejected',
        'organizer_suspended',
        'organizer_unsuspended',
        'refund_approved',
        'refund_rejected',
        'promotion_approved',
        'promotion_rejected',
        'dispute_challenged',
        'dispute_accepted_loss',
        'organizer_flagged',
        'organizer_unflagged',
        'admin_invited',
        'admin_role_changed',
        'admin_removed',
        'currency_converted',
        'user_deleted',
        'user_restored',
        'commission_rate_changed',
        'payout_hold_changed',
      ],
      required: true,
    },
    // Pre-rendered, human-readable summary (e.g. "Approved event \"Afrobeats
    // Night Market\" by Lagos Live Co.") — built once at write time from
    // real names, so the Overview page never needs to re-populate/re-derive
    // it from possibly-since-deleted related documents.
    message: { type: String, required: true, trim: true },
    relatedEvent: { type: Schema.Types.ObjectId, ref: 'Event' },
    relatedOrganizer: { type: Schema.Types.ObjectId, ref: 'User' },
    relatedRefundRequest: { type: Schema.Types.ObjectId, ref: 'RefundRequest' },
    relatedDispute: { type: Schema.Types.ObjectId, ref: 'PaymentDispute' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

AdminActivityLogSchema.index({ createdAt: -1 })

const AdminActivityLog =
  mongoose.models.AdminActivityLog ||
  mongoose.model<IAdminActivityLog>('AdminActivityLog', AdminActivityLogSchema, 'admin_activity_logs')

export default AdminActivityLog
