import mongoose, { Document, Schema } from 'mongoose'

// Organizer-facing types reuse the same pipe as the admin decisions that
// already email the organizer today (see admin.controller.ts /
// ticket.service.ts). The four `_pending_review`/`_requested` types below
// are admin-facing instead — recipient is every admin account (see
// NotificationService.notifyAdmins), fired at the point something first
// lands in an admin's queue (organizer submits for review, an event goes
// to pending_approval, a refund is requested, a promotion payment clears)
// so the bell has something real behind it instead of always being empty.
export type NotificationType =
  | 'new_sale'
  | 'event_approved'
  | 'event_rejected'
  | 'promotion_approved'
  | 'promotion_rejected'
  | 'organizer_approved'
  | 'organizer_rejected'
  | 'organizer_suspended'
  | 'organizer_unsuspended'
  | 'organizer_pending_review'
  | 'event_pending_review'
  | 'refund_requested'
  | 'promotion_requested'
  | 'report_submitted'
  | 'new_enquiry'
  // Attendee-facing: fired when something changes on an event/ticket
  // they hold — see postponeEvent/updateEvent/cancelEvent/
  // approveRefundRequest/rejectRefundRequest.
  | 'event_postponed'
  | 'event_updated'
  | 'event_cancelled'
  | 'refund_processed'
  | 'refund_rejected'
  // Organizer-facing: fired when an admin approves a refund on one of
  // their events (money coming out of their earnings — see
  // approveRefundRequest) or changes a platform-wide money setting that
  // affects them going forward (see updatePlatformSettings).
  | 'refund_deducted'
  | 'platform_fee_changed'
  | 'payout_hold_changed'

export interface INotification extends Document {
  _id: mongoose.Types.ObjectId
  recipient: mongoose.Types.ObjectId
  type: NotificationType
  title: string
  message: string
  // Optional deep link the frontend can navigate to on click — e.g. the
  // event's dashboard page for a "new_sale" notification.
  link?: string
  relatedEvent?: mongoose.Types.ObjectId
  isRead: boolean
  createdAt: Date
  updatedAt: Date
}

const NotificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
          enum: [
        'new_sale',
        'event_approved',
        'event_rejected',
        'promotion_approved',
        'promotion_rejected',
        'organizer_approved',
        'organizer_rejected',
        'organizer_suspended',
        'organizer_unsuspended',
        'organizer_pending_review',
        'event_pending_review',
        'refund_requested',
        'promotion_requested',
        'report_submitted',
        'event_postponed',
        'event_updated',
        'event_cancelled',
        'refund_processed',
        'refund_rejected',
        'refund_deducted',
        'platform_fee_changed',
        'payout_hold_changed',
        'new_enquiry',
      ],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    link: { type: String, trim: true },
    relatedEvent: { type: Schema.Types.ObjectId, ref: 'Event' },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
)

// Powers the bell/nav badge counts — "how many unread notifications does
// this recipient have, broken down by type" is the hottest query against
// this collection, run on close to every authenticated organizer page load.
NotificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 })
NotificationSchema.index({ recipient: 1, type: 1, isRead: 1 })

const Notification =
  mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema, 'notifications')

export default Notification
