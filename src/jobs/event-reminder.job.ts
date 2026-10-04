import logger from '../config/logger.js'
import Event from '../models/event.model.js'
import Ticket from '../models/ticket.model.js'
import { EmailService } from '../services/email/email.service.js'
import { formatEventDateLabel } from '../services/ticket.service.js'

// Reminds attendees the day before an event they're attending. Runs once
// daily (see vercel.json), so "tomorrow" is computed as a 24-hour window
// starting ~24h from now — wide enough to always catch an event whose
// startDate falls on tomorrow's calendar date, regardless of exactly what
// time today's cron run happens to fire.
const REMINDER_WINDOW_START_HOURS = 20
const REMINDER_WINDOW_END_HOURS = 28

export const sendEventReminders = async (): Promise<{ eventsChecked: number; remindersSent: number }> => {
  const now = new Date()
  const windowStart = new Date(now.getTime() + REMINDER_WINDOW_START_HOURS * 60 * 60 * 1000)
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_END_HOURS * 60 * 60 * 1000)

  const upcomingEvents = await Event.find({
    status: { $in: ['approved', 'postponed'] },
    startDate: { $gte: windowStart, $lte: windowEnd },
  })
    .select('title startDate venue isOnline onlinePlatform')
    .lean()

  if (upcomingEvents.length === 0) {
    logger.info('Event reminder cron: no events starting tomorrow')
    return { eventsChecked: 0, remindersSent: 0 }
  }

  let remindersSent = 0

  for (const event of upcomingEvents) {
    const tickets = await Ticket.find({ event: event._id, status: { $in: ['valid', 'checked_in'] } })
      .populate('attendee', 'fullname email notificationPreferences')
      .select('attendee attendeeName attendeeEmail')
      .lean()

    // Only registered attendees who opted in — a guest checkout (no
    // `attendee` ref) has no preferences to check and is skipped entirely,
    // same reasoning as the in-app notification hook points.
    const uniqueRecipients = new Map<string, { fullname: string; email: string }>()
    for (const ticket of tickets) {
      const attendee = ticket.attendee as any
      if (!attendee || attendee.notificationPreferences?.eventReminders === false) continue
      if (!uniqueRecipients.has(attendee.email)) {
        uniqueRecipients.set(attendee.email, { fullname: attendee.fullname, email: attendee.email })
      }
    }

    const dateLabel = formatEventDateLabel(event.startDate)

    for (const recipient of uniqueRecipients.values()) {
      try {
        await EmailService.sendEventReminderEmail(recipient, event.title, dateLabel)
        remindersSent++
      } catch (error) {
        logger.error({ err: error }, `Event reminder email failed for ${recipient.email}`)
      }
    }
  }

  logger.info({ eventsChecked: upcomingEvents.length, remindersSent }, 'Event reminder cron: batch complete')
  return { eventsChecked: upcomingEvents.length, remindersSent }
}