import { Request, Response } from 'express'
import mongoose from 'mongoose'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import { buildPaginationMeta, getPagination } from '../utils/helpers.js'
import Notification, { NotificationType } from '../models/notification.model.js'

/**
 * Powers the notification dropdown/feed — newest first, paginated the same
 * way every other list endpoint in this codebase is.
 */
export const listNotifications = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const filter: Record<string, any> = { recipient: req.session.userId }

  if (req.query.unreadOnly === 'true') {
    filter.isRead = false
  }

  const [notifications, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ])

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Notifications fetched',
    body: { notifications, meta: buildPaginationMeta(page, limit, total) },
  })
})

/**
 * Powers the bell badge total AND the per-nav-item counts (e.g. an
 * "Events" row showing how many of its unread notifications relate to
 * events) — `total` for the bell, `byType` for anything that wants to
 * break it down by notification type.
 */
export const getUnreadNotificationCount = tryCatchWrapper(async (req: Request, res: Response) => {
  // aggregate() doesn't auto-cast query values like find()/findOne() do —
  // req.session.userId is a plain string, so it has to be cast to an
  // ObjectId by hand or the $match silently matches nothing.
  const recipientId = new mongoose.Types.ObjectId(req.session.userId)

  const rows = await Notification.aggregate([
    { $match: { recipient: recipientId, isRead: false } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ])

  const byType = rows.reduce(
    (acc, row) => ({ ...acc, [row._id as NotificationType]: row.count as number }),
    {} as Record<string, number>
  )
  const total = rows.reduce((sum, row) => sum + row.count, 0)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Unread notification count fetched',
    body: { total, byType },
  })
})

export const markNotificationAsRead = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const notification = await Notification.findOneAndUpdate(
    { _id: id, recipient: req.session.userId },
    { isRead: true },
    { new: true }
  )

  if (!notification) {
    return sendTsRestError(res, 404, 'Notification not found')
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Notification marked as read',
    body: notification.toObject(),
  })
})

export const markAllNotificationsAsRead = tryCatchWrapper(async (req: Request, res: Response) => {
  await Notification.updateMany({ recipient: req.session.userId, isRead: false }, { isRead: true })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'All notifications marked as read',
    body: null,
  })
})

export const deleteNotification = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const notification = await Notification.findOneAndDelete({ _id: id, recipient: req.session.userId })
  if (!notification) {
    return sendTsRestError(res, 404, 'Notification not found')
  }
  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Notification deleted',
  })
})

export const deleteAllNotifications = tryCatchWrapper(async (req: Request, res: Response) => {
  await Notification.deleteMany({ recipient: req.session.userId })
  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'All notifications deleted',
  })
})
