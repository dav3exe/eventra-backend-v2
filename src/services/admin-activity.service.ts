import AdminActivityLog, { type AdminActivityType } from '../models/admin-activity-log.model.js'
import logger from '../config/logger.js'
import type mongoose from 'mongoose'

type LogAdminActivityInput = {
  actorId: mongoose.Types.ObjectId | string
  type: AdminActivityType
  message: string
  relatedEvent?: mongoose.Types.ObjectId | string
  relatedOrganizer?: mongoose.Types.ObjectId | string
  relatedRefundRequest?: mongoose.Types.ObjectId | string
  relatedDispute?: mongoose.Types.ObjectId | string
}

/**
 * Records one entry in the admin Overview page's "Recent activity" feed.
 * Fire-and-forget on purpose — same pattern as NotificationService calls
 * elsewhere in the admin controllers: a logging failure should never fail
 * the actual approve/reject/flag action it's describing.
 */
export async function logAdminActivity(input: LogAdminActivityInput): Promise<void> {
  try {
    await AdminActivityLog.create({
      actor: input.actorId,
      type: input.type,
      message: input.message,
      relatedEvent: input.relatedEvent,
      relatedOrganizer: input.relatedOrganizer,
      relatedRefundRequest: input.relatedRefundRequest,
      relatedDispute: input.relatedDispute,
    })
  } catch (error: any) {
    logger.error({ err: error }, `logAdminActivity failed for type ${input.type}`)
  }
}
