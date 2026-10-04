import type { NextFunction, Request, Response } from 'express'
import { sendTsRestError } from '../utils/response-handler.js'

export type AdminTier = 'owner' | 'admin' | 'support'

/**
 * A second, finer-grained gate on top of requireAdmin — for the handful of
 * admin actions (inviting another admin, changing an admin's tier) that
 * shouldn't be open to every admin account, only higher-tier ones.
 *
 * Deliberately defaults a MISSING adminRole to 'owner', not 'admin' — every
 * admin account that existed before this field was added has no adminRole
 * set at all, and treating that as the lowest tier would lock every one of
 * them out of admin management the moment this ships. Only accounts
 * created going forward through inviteAdmin get an explicit, lower tier
 * ('admin' or 'support') that this default no longer applies to.
 *
 * Usage: requireAdminTier('owner') / requireAdminTier('owner', 'admin')
 */
export const requireAdminTier = (...allowed: AdminTier[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tier: AdminTier = req.session.adminRole ?? 'owner'
    if (!allowed.includes(tier)) {
      sendTsRestError(res, 403, `Forbidden: requires one of the following admin tiers: ${allowed.join(', ')}`)
      return
    }
    next()
  }
}
