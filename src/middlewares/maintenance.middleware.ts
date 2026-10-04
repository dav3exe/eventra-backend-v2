import { Request, Response, NextFunction } from 'express'
import { sendTsRestError } from '../utils/response-handler.js'
import PlatformSettings from '../models/platform-settings.model.js'

// Blocks everyone except an authenticated admin when maintenance mode is
// on — checked on every request (cheap: PlatformSettings is a single-row
// collection), so a toggle flip takes effect immediately without needing
// a server restart. Health checks and admin-facing routes stay reachable
// so an admin can always get back in to turn it off again.
export const checkMaintenanceMode = async (req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health') return next()
  if (req.path.startsWith('/api/v1/auth')) return next()
  if (req.session?.role === 'admin') return next()

  try {
    const settings = await PlatformSettings.findOne()
    if (settings?.maintenanceMode) {
      return sendTsRestError(res, 503, "Eventra is currently undergoing maintenance. Please check back shortly.")
    }
  } catch (error) {
    // fail open
  }

  next()
}