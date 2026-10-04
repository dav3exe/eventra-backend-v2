import { Router } from 'express'
import {
  uploadEventCoverImage,
  uploadGalleryPhoto,
  uploadLineupPhoto,
  uploadRefundEvidence,
  uploadReportEvidence,
  uploadVerificationDocument,
} from '../controllers/upload.controller.js'
import { requireRole, verifySession } from '../middlewares/auth.middleware.js'
import { documentUpload, imageUpload } from '../middlewares/upload.middleware.js'
import { customRateLimiter } from '../middlewares/rate-limit.middleware.js'

const router = Router()

router.post(
  '/event-cover',
  verifySession,
  requireRole('organizer'),
  customRateLimiter(10),
  imageUpload.single('image'),
  uploadEventCoverImage
)

router.post(
  '/lineup-photo',
  verifySession,
  requireRole('organizer'),
  customRateLimiter(10),
  imageUpload.single('image'),
  uploadLineupPhoto
)

router.post(
  '/gallery-photo',
  verifySession,
  requireRole('organizer'),
  customRateLimiter(10),
  imageUpload.single('image'),
  uploadGalleryPhoto
)

// No verifySession/requireRole here, unlike every other upload route above
// — the refund form (and the /tickets/:ticketId/refund-request it feeds
// into) already works for both a logged-in attendee AND an unauthenticated
// guest ticket-holder (see ticket.routes.ts's own comment on that route),
// so this can't be gated behind an organizer session or it would 403 for
// the vast majority of people who'd actually use it. Rate-limited instead,
// same trust model as the other session-free ticket endpoints (rsvp,
// checkout).
router.post(
  '/refund-evidence',
  customRateLimiter(10),
  imageUpload.single('image'),
  uploadRefundEvidence
)

router.post(
  '/report-evidence',
  verifySession,
  customRateLimiter(10),
  imageUpload.single('image'),
  uploadReportEvidence
)

router.post(
  '/verification-document',
  verifySession,
  requireRole('organizer'),
  customRateLimiter(10),
  documentUpload.single('document'),
  uploadVerificationDocument
)

export default router
