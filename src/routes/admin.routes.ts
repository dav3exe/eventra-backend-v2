import { Router } from 'express'
import {
  acceptDisputeLoss,
  approveEvent,
  approveEventPromotion,
  approveOrganizer,
  approveRefundRequest,
  challengeDispute,
  dismissEventFlag,
  dismissOrganizerFlag,
  flagEvent,
  flagOrganizer,
  getAdminNavCounts,
  getAdminOverview,
  getAdminPayoutsOverview,
  getAdminRevenue,
  getEventDetailForAdmin,
  getEventFlagDetail,
  getEventPromotionDetailForAdmin,
  deleteAdmin,
  deleteUser,
  restoreUser,
  getOrganizerDetailForAdmin,
  getOrganizerFlagDetail,
  getPlatformSettings,
  getPlatformStats,
  getRefundRequestDetail,
  getUserDetail,
  inviteAdmin,
  listAdmins,
  listAuditLog,
  listAwaitingPayouts,
  listDisputes,
  listEventsForAdmin,
  listFlags,
  listOrganizersForAdmin,
  listPayoutHistory,
  listPendingEvents,
  listPendingOrganizers,
  listPendingPromotions,
  listPromotionsForAdmin,
  listRefundRequests,
  listUsers,
  rejectEvent,
  rejectEventPromotion,
  rejectOrganizer,
  rejectRefundRequest,
  releaseEventPayout,
  removeEvent,
  suspendUser,
  unflagEvent,
  unflagOrganizer,
  unsuspendUser,
  updateAdminRole,
  updatePlatformSettings,
  suspendEvent,
  unsuspendEvent,
  suspendOrganizer,
  unsuspendOrganizer,
 
} from '../controllers/admin.controller.js'
import { createCategory, listAllCategories, updateCategory } from '../controllers/category.controller.js'
import { requireAdmin, verifySession } from '../middlewares/auth.middleware.js'
import { requireAdminTier } from '../middlewares/admin-permission.middleware.js'
import { validateFormData } from '../middlewares/schema.middleware.js'
import {
  createCategorySchema,
  inviteAdminSchema,
  rejectEventSchema,
  updateAdminRoleSchema,
  updateCategorySchema,
  updatePlatformSettingsSchema,
} from '../validators/schema-validation.js'

const router = Router()

router.use(verifySession, requireAdmin)

// Platform stats
router.get('/stats', getPlatformStats)

// Admin Console Overview page — needs-action counts, stat cards, revenue
// chart, top organizers.
router.get('/overview', getAdminOverview)

// Sidebar "Needs Action" badge counts
router.get('/nav-counts', getAdminNavCounts)

// User management — kept as "users" (not renamed to "attendees") to match
// the existing admin Users list/detail pages and routes.
router.get('/users', listUsers)
router.get('/users/:id', getUserDetail)
router.patch('/users/:id/suspend', suspendUser)
router.patch('/users/:id/unsuspend', unsuspendUser)
router.patch('/users/:id/delete', deleteUser)
router.patch('/users/:id/restore', restoreUser)

// Organizer approval + management. /pending stays above /:id so a request
// for the pending-queue path is never swallowed by the :id param route.
router.get('/organizers/pending', listPendingOrganizers)
router.get('/organizers', listOrganizersForAdmin)
router.get('/organizers/:id', getOrganizerDetailForAdmin)
router.patch('/organizers/:id/approve', approveOrganizer)
router.patch('/organizers/:id/reject', rejectOrganizer)
router.patch('/organizers/:id/suspend', suspendOrganizer);
router.patch('/organizers/:id/unsuspend', unsuspendOrganizer);

// Event approval + management. Same ordering reasoning as organizers above
// — /pending is registered before /:id.
router.get('/events/pending', listPendingEvents)
router.get('/events', listEventsForAdmin)
router.get('/events/:id', getEventDetailForAdmin)
router.patch('/events/:id/approve', approveEvent)
router.patch('/events/:id/reject', validateFormData(rejectEventSchema), rejectEvent)
router.patch('/events/:id/flag', flagEvent)
router.patch('/events/:id/unflag', unflagEvent)
router.patch('/events/:id/remove', removeEvent)
router.patch('/events/:id/suspend', suspendEvent)
router.patch('/events/:id/unsuspend', unsuspendEvent)
router.patch('/organizers/:id/flag', flagOrganizer)
router.patch('/organizers/:id/unflag', unflagOrganizer)

// Promotion approval. /pending and the plain list both stay above
// /:eventId, same ordering reasoning as organizers/events above. Approve/
// reject stay on their original /events/:id/promotion/... paths
// (unchanged) since that's what the event-detail flows already call —
// these are additive: /pending backs the Approvals page's Promotions tab,
// the plain /promotions list backs the standalone admin Promotions page
// under Manage (every promotion, any status), and both share the same
// /:eventId detail view.
router.get('/promotions/pending', listPendingPromotions)
router.get('/promotions', listPromotionsForAdmin)
router.get('/promotions/:eventId', getEventPromotionDetailForAdmin)
router.patch('/events/:id/promotion/approve', approveEventPromotion)
router.patch('/events/:id/promotion/reject', rejectEventPromotion)

// Refund requests
router.get('/refund-requests', listRefundRequests)
router.get('/refund-requests/:id', getRefundRequestDetail)
router.patch('/refund-requests/:id/approve', approveRefundRequest)
router.patch('/refund-requests/:id/reject', rejectRefundRequest)

// Disputes — real Paystack chargebacks (see PaymentDispute /
// handleDisputeWebhook), separate from in-app refund requests above.
router.get('/disputes', listDisputes)
router.patch('/disputes/:id/challenge', challengeDispute)
router.patch('/disputes/:id/accept-loss', acceptDisputeLoss)

// Revenue (Platform > Revenue)
router.get('/revenue', getAdminRevenue)

// Payouts (Platform > Payouts)
router.get('/payouts/overview', getAdminPayoutsOverview)
router.get('/payouts/awaiting', listAwaitingPayouts)
router.get('/payouts/history', listPayoutHistory)
router.post('/payouts/:organizerId/:eventId/release', releaseEventPayout)

// Categories
router.get('/categories', listAllCategories)
router.post('/categories', validateFormData(createCategorySchema), createCategory)
router.patch('/categories/:id', validateFormData(updateCategorySchema), updateCategory)

// Reports / Flags queue — see Report model and reportEvent
// (event.controller.ts) for how a target ends up here.
router.get('/reports/flags', listFlags)
router.get('/reports/flags/events/:id', getEventFlagDetail)
router.get('/reports/flags/organizers/:id', getOrganizerFlagDetail)
router.patch('/reports/flags/events/:id/dismiss', dismissEventFlag)
router.patch('/reports/flags/organizers/:id/dismiss', dismissOrganizerFlag)
router.get('/reports/audit-log', listAuditLog)

// Settings > Admins — owner-tier only, see requireAdminTier. The whole
// Settings page is owner-only (Chloe: "only the owner will have access to
// the settings page"), so every route under /settings is gated here, not
// just the mutating ones.
router.get('/settings/admins', requireAdminTier('owner'), listAdmins)
router.post('/settings/admins/invite', requireAdminTier('owner'), validateFormData(inviteAdminSchema), inviteAdmin)
router.patch('/settings/admins/:id/role', requireAdminTier('owner'), validateFormData(updateAdminRoleSchema), updateAdminRole)
router.delete('/settings/admins/:id', requireAdminTier('owner'), deleteAdmin)

// Settings > Commission rate / Platform Configuration — owner-tier only,
// same as the Admins routes above (see the Settings-page-is-owner-only
// note there). Previously the GET was open to any admin; narrowed to match
// since the whole page is now meant to be unreachable below owner tier.
router.get('/settings/platform', requireAdminTier('owner'), getPlatformSettings)
router.patch('/settings/platform', requireAdminTier('owner'), validateFormData(updatePlatformSettingsSchema), updatePlatformSettings)

export default router
