import logger from '../config/logger.js'
import Event from '../models/event.model.js'
import User from '../models/user.model.js'
import { EmailService } from '../services/email/email.service.js'

const PICKS_COUNT = 5
const LOOKAHEAD_DAYS = 14

/**
 * Weekly digest — finds the top N upcoming events (by tickets sold) in the
 * next LOOKAHEAD_DAYS, and emails them to every attendee who has the
 * "Weekly picks" toggle on. Not location-personalized (attendees have no
 * stored location yet) — everyone currently gets the same platform-wide
 * picks.
 */
export const sendWeeklyPicks = async (): Promise<{ picksFound: number; emailsSent: number }> => {
  const now = new Date()
  const lookaheadEnd = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000)

  const topEvents = await Event.find({
    status: { $in: ['approved', 'postponed'] },
    startDate: { $gte: now, $lte: lookaheadEnd },
  })
    .sort({ ticketsSoldCount: -1 })
    .limit(PICKS_COUNT)
    .select('title startDate slug ticketsSoldCount')
    .lean()

  if (topEvents.length === 0) {
    logger.info('Weekly picks cron: no upcoming events to feature')
    return { picksFound: 0, emailsSent: 0 }
  }

  // Only attendees who opted in — weeklyPicks defaults to true in the
  // schema, so this is genuinely "everyone except explicit opt-outs."
  const recipients = await User.find({
    role: 'attendee',
    'notificationPreferences.weeklyPicks': { $ne: false },
  })
    .select('fullname email')
    .lean()

  let emailsSent = 0

  for (const recipient of recipients) {
    try {
      await EmailService.sendWeeklyPicksEmail(recipient, topEvents)
      emailsSent++
    } catch (error) {
      logger.error({ err: error }, `Weekly picks email failed for ${recipient.email}`)
    }
  }

  logger.info({ picksFound: topEvents.length, emailsSent }, 'Weekly picks cron: batch complete')
  return { picksFound: topEvents.length, emailsSent }
}