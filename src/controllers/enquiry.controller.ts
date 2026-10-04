import { Request, Response } from 'express'
import Enquiry, { IEnquiry } from '../models/enquiry.model.js'
import sendEmailWithOptions from '../services/email/send-email.js'
import { NotificationService } from '../services/notification.service.js'
import { sendTsRestSuccess, sendTsRestError } from '../utils/response-handler.js'
import logger, { logError } from '../config/logger.js'
import { buildPaginationMeta, getPagination, isValidObjectId } from '../utils/helpers.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import mongoose from 'mongoose'

export const createEnquiry = tryCatchWrapper(async (req: Request, res: Response) => {
  const { fullName, email, subject, message } = req.body

  const enquiry = await Enquiry.create({ fullName, email, subject, message })

  // Joins the admin-queue notification family (organizer_pending_review,
  // event_pending_review, refund_requested, promotion_requested,
  // report_submitted) — see NotificationType's doc comment and
  // NotificationService.notifyAdmins. Fire-and-forget: the enquiry is
  // already saved regardless of whether this or the email below succeeds.
  NotificationService.notifyAdmins({
    type: 'new_enquiry',
    title: 'New enquiry received',
    message: `${fullName} sent a message: "${subject}"`,
    link: `/admin/enquiries/${enquiry._id}`,
  }).catch(error => logger.error({ err: error }, `Enquiry notification failed for enquiry ${enquiry._id}`))

  const adminEmails = (process.env.ADMIN_NOTIFICATION_EMAILS || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean)

  if (adminEmails.length) {
    sendEmailWithOptions({
      email: adminEmails,
      subject: `New enquiry: ${subject}`,
      message: `
        <h2>New contact form enquiry</h2>
        <p><strong>From:</strong> ${fullName} (${email})</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, '<br/>')}</p>
      `,
    }).catch(err => logError(err, 'Enquiry notification email failed'))
  }

  return sendTsRestSuccess(res, 201, {
    success: true,
    message: 'Enquiry received.',
    body: enquiry.toObject(),
  })
})

/**
 * Powers the admin Enquiries list — matches the pagination shape every
 * other admin list endpoint in this file uses (listUsers, listEventsForAdmin,
 * etc.), rather than returning every enquiry unbounded.
 */
export const getEnquiries = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)

  const [enquiries, total, unreadCount] = await Promise.all([
    Enquiry.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('fullName email subject status createdAt')
      .lean(),
    Enquiry.countDocuments(),
    Enquiry.countDocuments({ status: 'unread' }),
  ])

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Enquiries fetched',
    body: { enquiries, unreadCount, meta: buildPaginationMeta(page, limit, total) },
  })
})

export const getEnquiryById = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params

  if (!isValidObjectId(id)) {
    return sendTsRestError(res, 400, 'Invalid enquiry id')
  }

  const enquiry = await Enquiry.findById(id)
  if (!enquiry) {
    return sendTsRestError(res, 404, 'Enquiry not found.')
  }

  if (enquiry.status === 'unread') {
    enquiry.status = 'read'
    if (req.session?.userId) {
      enquiry.readBy = new mongoose.Types.ObjectId(req.session.userId)
    }
    enquiry.readAt = new Date()
    await enquiry.save()
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Enquiry fetched',
    body: enquiry.toObject(),
  })
})

/**
 * Bulk-marks every currently-unread enquiry as read, for the admin list's
 * "Mark all as read" action. Mirrors the single-enquiry read logic in
 * getEnquiryById (same readBy/readAt fields) but as one bulk update rather
 * than looping — this can run over an unbounded number of enquiries, not
 * just the current page.
 */
export const markAllEnquiriesRead = tryCatchWrapper(async (req: Request, res: Response) => {
  const update: Partial<IEnquiry> = { status: 'read', readAt: new Date() }
  if (req.session?.userId) {
    update.readBy = new mongoose.Types.ObjectId(req.session.userId)
  }

  const result = await Enquiry.updateMany({ status: 'unread' }, update)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: `${result.modifiedCount} enquir${result.modifiedCount === 1 ? 'y' : 'ies'} marked as read.`,
    body: { modifiedCount: result.modifiedCount },
  })
})

/**
 * Bulk-deletes enquiries by id, for the admin list's checkbox-select +
 * delete action. Every id is validated before anything is deleted — a
 * request with even one malformed id is rejected outright rather than
 * silently deleting only the valid ones, so the admin isn't left guessing
 * which of their selected rows actually went through.
 */
export const deleteEnquiries = tryCatchWrapper(async (req: Request, res: Response) => {
  const { ids } = req.body as { ids?: unknown }

  if (!Array.isArray(ids) || ids.length === 0) {
    return sendTsRestError(res, 400, 'Provide a non-empty array of enquiry ids to delete.')
  }

  if (!ids.every(isValidObjectId)) {
    return sendTsRestError(res, 400, 'One or more enquiry ids are invalid.')
  }

  const result = await Enquiry.deleteMany({ _id: { $in: ids } })

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: `${result.deletedCount} enquir${result.deletedCount === 1 ? 'y' : 'ies'} deleted.`,
    body: { deletedCount: result.deletedCount },
  })
})
