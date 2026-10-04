import { Request, Response } from 'express'
import { env } from '../config/keys.js'
import { sendDailySalesSummaries } from '../jobs/daily-sales-summary.job.js'
import { processDuePayouts } from '../jobs/payout.job.js'
import { expirePromotions } from '../jobs/promotion-expiry.job.js'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import { sendEventReminders } from '../jobs/event-reminder.job.js'
import { sendWeeklyPicks } from '../jobs/weekly-picks.job.js'

const isAuthorizedCronCall = (req: Request): boolean => req.headers['x-cron-secret'] === env.CRON_SECRET

export const checkPayoutCron = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!isAuthorizedCronCall(req)) {
    return sendTsRestError(res, 401, 'Unauthorized: invalid or missing CRON_SECRET')
  }

  const result = await processDuePayouts()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Payout cron job completed',
    body: result,
  })
})

export const checkEventReminderCron = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!isAuthorizedCronCall(req)) {
    return sendTsRestError(res, 401, 'Unauthorized: invalid or missing CRON_SECRET')
  }

  const result = await sendEventReminders()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event reminder cron job completed',
    body: result,
  })
})

export const checkWeeklyPicksCron = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!isAuthorizedCronCall(req)) {
    return sendTsRestError(res, 401, 'Unauthorized: invalid or missing CRON_SECRET')
  }

  const result = await sendWeeklyPicks()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Weekly picks cron job completed',
    body: result,
  })
})

export const checkPromotionExpiryCron = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!isAuthorizedCronCall(req)) {
    return sendTsRestError(res, 401, 'Unauthorized: invalid or missing CRON_SECRET')
  }

  const result = await expirePromotions()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Promotion expiry cron job completed',
    body: result,
  })
})

export const checkDailySalesSummaryCron = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!isAuthorizedCronCall(req)) {
    return sendTsRestError(res, 401, 'Unauthorized: invalid or missing CRON_SECRET')
  }

  const result = await sendDailySalesSummaries()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Daily sales summary cron job completed',
    body: result,
  })
})
