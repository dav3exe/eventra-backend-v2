import { Request, Response } from 'express'
import { sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import PlatformSettings from '../models/platform-settings.model.js'

// Same find-or-create singleton pattern as getPlatformSettingsDoc in
// admin.controller.ts, duplicated here (rather than imported) since that
// one is a local, unexported helper and this route deliberately lives
// outside the admin-gated surface — see the route registration for why.
async function getPlatformSettingsDoc() {
  const existing = await PlatformSettings.findOne()
  if (existing) return existing
  return PlatformSettings.create({})
}

/**
 * The ONLY platform-currency read that isn't owner-tier gated
 * (getPlatformSettings in admin.controller.ts requires requireAdminTier
 * ('owner') — see admin.routes.ts). Every page on the site that displays a
 * money amount — attendee checkout/tickets, organizer dashboard, and
 * non-owner admin tiers — needs to know the current currency symbol, so
 * this exposes just that one field, unauthenticated, with nothing else
 * from PlatformSettings attached.
 */
export const getPublicPlatformCurrency = tryCatchWrapper(async (_req: Request, res: Response) => {
  const settings = await getPlatformSettingsDoc()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Platform currency fetched',
    body: { currency: settings.currency },
  })
})
