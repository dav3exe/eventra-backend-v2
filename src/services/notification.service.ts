import mongoose from 'mongoose'
import logger from '../config/logger.js'
import Notification, { NotificationType } from '../models/notification.model.js'
import User from '../models/user.model.js'
import type { IAdminNotificationPreferences } from '../models/user.model.js'

interface CreateNotificationInput {
 recipient: mongoose.Types.ObjectId | string | undefined
  type: NotificationType
  title: string
  message: string
  link?: string
  relatedEvent?: mongoose.Types.ObjectId | string
}

type NotifyAdminsInput = Omit<CreateNotificationInput, 'recipient'>

// Maps each admin-facing NotificationType to the toggle category that
// gates it on the admin Settings page — see IAdminNotificationPreferences
// on the User model. A type with no entry here is never filtered (every
// admin gets it regardless of preferences).
const ADMIN_NOTIFICATION_CATEGORY: Partial<Record<NotificationType, keyof IAdminNotificationPreferences>> = {
  event_pending_review: 'approvals',
  organizer_pending_review: 'approvals',
  promotion_requested: 'approvals',
  report_submitted: 'reports',
  refund_requested: 'refunds',
  new_enquiry: 'enquiries',
}

/**
 * Single write path for in-app notifications. Deliberately separate from
 * EmailService — a notification here should always be created regardless
 * of the recipient's email-preference toggles (organizerNotificationPreferences),
 * since those only ever controlled whether an EMAIL goes out. The bell
 * should reflect what actually happened, not what the organizer opted into
 * being emailed about.
 *
 * Fire-and-forget by design: every call site wraps this in .catch(...) (or
 * calls it from a place that already tolerates a failure), the same way
 * EmailService sends are handled elsewhere in this codebase. A notification
 * failing to write should never block the request that triggered it.
 */
export class NotificationService {
  static async create(input: CreateNotificationInput): Promise<void> {
    if (!input.recipient) return

    try {
      await Notification.create({
        recipient: input.recipient,
        type: input.type,
        title: input.title,
        message: input.message,
        link: input.link,
        relatedEvent: input.relatedEvent,
      })
    } catch (error) {
      logger.error({ err: error, type: input.type, recipient: input.recipient }, 'Failed to create notification')
    }
  }

  /**
   * Fans the same notification out to every admin account — used for the
   * four things that first land in an admin's queue (organizer submitted
   * for review, event submitted for approval, refund requested, promotion
   * payment confirmed). There's usually only a handful of admin accounts,
   * so one write per admin is simple and fine; this is not a hot path.
   */
   static async notifyAdmins(input: NotifyAdminsInput): Promise<void> {
    try {
      const category = ADMIN_NOTIFICATION_CATEGORY[input.type]
      const filter: Record<string, any> = { role: 'admin' }
      if (category) {
        filter[`adminNotificationPreferences.${category}`] = { $ne: false }
      }

      const admins = await User.find(filter).select('_id').lean()
      await Promise.all(
        admins.map(admin =>
          NotificationService.create({
            ...input,
            recipient: admin._id,
          })
        )
         )
    } catch (error) {
      logger.error({ err: error, type: input.type }, 'Failed to fan out admin notification')
    }
  }

  /**
   * Fans the same notification out to every organizer account — used for
   * platform-wide settings that affect every organizer's future earnings
   * (commission rate, payout hold — see updatePlatformSettings,
   * admin.controller.ts). Same one-write-per-recipient approach as
   * notifyAdmins; there can be many more organizers than admins, but this
   * is still called from a rare admin action, not a hot path.
   */
  static async notifyOrganizers(input: NotifyAdminsInput): Promise<void> {
    try {
      const organizers = await User.find({ role: 'organizer' }).select('_id').lean()
      await Promise.all(
        organizers.map(organizer =>
          NotificationService.create({
            ...input,
            recipient: organizer._id,
          })
        )
      )
    } catch (error) {
      logger.error({ err: error, type: input.type }, 'Failed to fan out organizer notification')
    }
  }
}
