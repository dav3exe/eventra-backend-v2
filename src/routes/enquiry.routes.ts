import { Router } from 'express'
import {
    createEnquiry,
    getEnquiries,
    getEnquiryById,
    markAllEnquiriesRead,
    deleteEnquiries,
} from '../controllers/enquiry.controller.js'
import { verifySession, requireRole } from '../middlewares/auth.middleware.js'
import { requireAdminTier } from '../middlewares/admin-permission.middleware.js'
import { validateFormData } from '../middlewares/schema.middleware.js'
import { strictLimiter } from '../middlewares/rate-limit.middleware.js'
import { cacheMiddleware, clearCache } from '../middlewares/cache.middleware.js'
import { enquirySchema } from '../validators/schema-validation.js'

const router = Router()

router.post('/',strictLimiter,
    validateFormData(enquirySchema),
    clearCache('enquiries'),
    createEnquiry
)

router.get(
    '/',
    verifySession,
    requireRole('admin'),
    requireAdminTier('owner', 'admin', 'support'),
    cacheMiddleware(30),
    getEnquiries
)

// Same tiers as the list/read endpoints — marking read is no more
// sensitive than viewing an individual enquiry already is (getEnquiryById
// marks that one read as a side effect of fetching it), just applied in
// bulk.
router.patch(
    '/read-all',
    verifySession,
    requireRole('admin'),
    requireAdminTier('owner', 'admin', 'support'),
    clearCache('enquiries'),
    markAllEnquiriesRead
)

// Deletion is destructive and irreversible, so it's scoped tighter than
// the read/mark-read endpoints above — 'support' tier can view and
// triage enquiries but not permanently delete them.
router.delete(
    '/',
    verifySession,
    requireRole('admin'),
    requireAdminTier('owner', 'admin'),
    clearCache('enquiries'),
    deleteEnquiries
)

router.get(
    '/:id',
    verifySession,
    requireRole('admin'),
    requireAdminTier('owner', 'admin', 'support'),
    getEnquiryById
)

export default router
