import sendEmail from './send-email.js'
import {
  dailySalesSummaryTemplate,
  eventApprovedTemplate,
  eventCancelledTemplate,
  eventPostponedTemplate,
  eventRejectedTemplate,
  eventUpdatedTemplate,
  guestTicketAccessTemplate,
  newSaleNotificationTemplate,
  organizerApprovedTemplate,
  organizerRejectedTemplate,
  payoutConfirmationTemplate,
  payoutHoldChangedTemplate,
  platformFeeChangedTemplate,
  refundDeductedTemplate,
  refundProcessedTemplate,
  refundRejectedTemplate,
  resetPasswordTemplate,
  ticketConfirmationTemplate,
  newsletterWelcomeTemplate,
  verifyAccountTemplate,
  eventReminderTemplate,
  weeklyPicksTemplate,
  organizerUpdateTemplate,
} from './email-templates.js'
import { generateQrCodeBuffer } from '../../utils/qrcode.js'
import EmailQueue from '../../models/email-queue.model.js'

export interface EmailUser {
  email: string
  fullname: string
}

export class EmailService {
  /**
   * Helper method to handle queueing failed emails consistently across methods.
   */
  private static async queueEmail({
    to,
    subject,
    html,
    priority = 'normal',
    attachments,
  }: {
    to: string
    subject: string
    html: string
    priority?: 'high' | 'normal' | 'low'
    attachments?: Array<{ filename: string; content: Buffer }>
  }): Promise<void> {
    try {
      await EmailQueue.create({
        to,
        subject,
        html,
        attachments,
        priority,
        status: 'queued',
        retryCount: 0,
        nextRetryAt: new Date(Date.now() + 5 * 60 * 1000), // First retry in 5 minutes
      })
    } catch (error) {
      console.error(`[EmailService] Failed to queue email to ${to}:`, error)
    }
  }

  static async sendVerifyAccountEmail({
    user,
    otp,
    link,
  }: {
    user: EmailUser
    otp: string
    link: string
  }): Promise<{ success: boolean; queued: boolean }> {
    const htmlBody = verifyAccountTemplate(user.fullname, otp, link)
    const subject = 'Verify your account - Eventra'

    try {
      const result = await sendEmail({
        email: user.email,
        subject,
        message: htmlBody,
      })
      if (result?.success) return { success: true, queued: false }
    } catch (error) {
      console.error('[EmailService] sendVerifyAccountEmail direct send failed:', error)
    }

    await this.queueEmail({ to: user.email, subject, html: htmlBody, priority: 'high' })
    return { success: false, queued: true }
  }

  static async sendPasswordResetEmail({
    user,
    otp,
  }: {
    user: EmailUser
    otp: string
  }): Promise<{ success: boolean; queued: boolean }> {
    const htmlBody = resetPasswordTemplate(user.fullname, otp)
    const subject = 'Reset your password - Eventra'

    try {
      const result = await sendEmail({
        email: user.email,
        subject,
        message: htmlBody,
      })
      if (result?.success) return { success: true, queued: false }
    } catch (error) {
      console.error('[EmailService] sendPasswordResetEmail direct send failed:', error)
    }

    await this.queueEmail({ to: user.email, subject, html: htmlBody, priority: 'high' })
    return { success: false, queued: true }
  }

  static async sendGuestTicketAccessEmail({
    email,
    otp,
  }: {
    email: string
    otp: string
  }): Promise<{ success: boolean; queued: boolean }> {
    const htmlBody = guestTicketAccessTemplate(otp)
    const subject = 'Access your Eventra tickets'

    try {
      const result = await sendEmail({
        email,
        subject,
        message: htmlBody,
      })
      if (result?.success) return { success: true, queued: false }
    } catch (error) {
      console.error('[EmailService] sendGuestTicketAccessEmail direct send failed:', error)
    }

    await this.queueEmail({ to: email, subject, html: htmlBody, priority: 'high' })
    return { success: false, queued: true }
  }

  static async sendTicketConfirmationEmail({
    user,
    eventTitle,
    eventDateLabel,
    venueLabel,
    tickets,
  }: {
    user: EmailUser
    eventTitle: string
    eventDateLabel: string
    venueLabel: string
    tickets: { code: string; qrCodeUrl?: string }[]
  }): Promise<{ success: boolean; queued: boolean }> {
    const htmlBody = ticketConfirmationTemplate(user.fullname, eventTitle, eventDateLabel, venueLabel, tickets)
    const subject = `Your ticket${tickets.length > 1 ? 's' : ''} for ${eventTitle}`

    try {
      const attachments = await Promise.all(
        tickets.map(async ({ code }, index) => ({
          filename: `ticket-${index + 1}.png`,
          content: await generateQrCodeBuffer(code),
        }))
      )

      const result = await sendEmail({
        email: user.email,
        subject,
        message: htmlBody,
        attachments,
      })

      if (result?.success) return { success: true, queued: false }

      // Queue on failure so tickets are retried automatically
      await this.queueEmail({ to: user.email, subject, html: htmlBody, priority: 'high', attachments })
      return { success: false, queued: true }
    } catch (error) {
      console.error('[EmailService] sendTicketConfirmationEmail failed:', error)
      return { success: false, queued: false }
    }
  }

  static async sendOrganizerApprovedEmail(user: EmailUser): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: "You're approved to organize on Eventra",
        message: organizerApprovedTemplate(user.fullname),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendOrganizerRejectedEmail(user: EmailUser): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: 'Update on your organizer application',
        message: organizerRejectedTemplate(user.fullname),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }
static async sendOrganizerSuspendedEmail(user: any, reason?: string): Promise<{ success: boolean }> {
    const reasonText = reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''
    const htmlBody = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Organizer Account Suspended</h2>
        <p>Hello ${user.fullname},</p>
        <p>Your organizer status on Eventra has been suspended by an administrator.</p>
        ${reasonText}
        <p>If you believe this is an error or would like to appeal, please contact support.</p>
      </div>
    `
    const result = await sendEmail({
      email: user.email,
      subject: 'Your organizer account has been suspended',
      message: htmlBody,
    })
    return { success: result.success }
  }

  static async sendOrganizerUnsuspendedEmail(user: any): Promise<{ success: boolean }> {
    const htmlBody = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Organizer Account Reinstated</h2>
        <p>Hello ${user.fullname},</p>
        <p>Great news! Your organizer account suspension has been lifted, and your account is active again.</p>
        <p>You can now continue hosting and managing your events on Eventra.</p>
      </div>
    `
    const result = await sendEmail({
      email: user.email,
      subject: 'Your organizer account has been reinstated',
      message: htmlBody,
    })
    return { success: result.success }
  }

  static async sendEventApprovedEmail(user: EmailUser, eventTitle: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: `${eventTitle} is live!`,
        message: eventApprovedTemplate(user.fullname, eventTitle),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendEventRejectedEmail(user: EmailUser, eventTitle: string, reason: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: `${eventTitle} needs a change before it can go live`,
        message: eventRejectedTemplate(user.fullname, eventTitle, reason),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendRefundProcessedEmail(user: EmailUser, eventTitle: string, amountLabel: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: 'Your refund has been processed',
        message: refundProcessedTemplate(user.fullname, eventTitle, amountLabel),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendRefundRejectedEmail(user: EmailUser, eventTitle: string, amountLabel: string, reason?: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: 'Your refund request was declined',
        message: refundRejectedTemplate(user.fullname, eventTitle, amountLabel, reason),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendRefundDeductedEmail(organizer: EmailUser, eventTitle: string, amountLabel: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: organizer.email,
        subject: 'A refund was issued for your event',
        message: refundDeductedTemplate(organizer.fullname, eventTitle, amountLabel),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendPlatformFeeChangedEmail(organizer: EmailUser, oldPercent: number, newPercent: number): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: organizer.email,
        subject: 'Eventra commission rate is changing',
        message: platformFeeChangedTemplate(organizer.fullname, oldPercent, newPercent),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendPayoutHoldChangedEmail(organizer: EmailUser, oldHoldLabel: string, newHoldLabel: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: organizer.email,
        subject: 'Eventra payout timing is changing',
        message: payoutHoldChangedTemplate(organizer.fullname, oldHoldLabel, newHoldLabel),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendNewsletterWelcomeEmail(email: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email,
        subject: 'Welcome to the Eventra newsletter',
        message: newsletterWelcomeTemplate(email),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendEventCancelledEmail(
    user: EmailUser,
    eventTitle: string,
    eventDateLabel: string,
    reason: string,
    isPaid: boolean
  ): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: `${eventTitle} has been cancelled`,
        message: eventCancelledTemplate(user.fullname, eventTitle, eventDateLabel, reason, isPaid),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendEventPostponedEmail(
    user: EmailUser,
    eventTitle: string,
    oldDateLabel: string,
    newDateLabel: string,
    reason?: string
  ): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: `${eventTitle} has a new date`,
        message: eventPostponedTemplate(user.fullname, eventTitle, oldDateLabel, newDateLabel, reason),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendEventReminderEmail(user: EmailUser, eventTitle: string, dateLabel: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: `Reminder: ${eventTitle} is tomorrow`,
        message: eventReminderTemplate(user.fullname, eventTitle, dateLabel),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendWeeklyPicksEmail(
    user: EmailUser,
    events: { title: string; startDate: Date; slug: string }[]
  ): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: "This week's best events on Eventra",
        message: weeklyPicksTemplate(user.fullname, events),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendOrganizerUpdateEmail(user: EmailUser, organizerName: string, eventTitle: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: `${organizerName} just posted a new event`,
        message: organizerUpdateTemplate(user.fullname, organizerName, eventTitle),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendEventUpdatedEmail(user: EmailUser, eventTitle: string, changes: string[]): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: user.email,
        subject: `${eventTitle} has been updated`,
        message: eventUpdatedTemplate(user.fullname, eventTitle, changes),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendNewSaleNotificationEmail(
    organizer: EmailUser,
    eventTitle: string,
    attendeeName: string,
    ticketLabel: string,
    amountLabel: string
  ): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: organizer.email,
        subject: `New ${amountLabel === 'Free RSVP' ? 'RSVP' : 'sale'} for ${eventTitle}`,
        message: newSaleNotificationTemplate(organizer.fullname, eventTitle, attendeeName, ticketLabel, amountLabel),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendPayoutConfirmationEmail(organizer: EmailUser, eventTitle: string, amountLabel: string): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: organizer.email,
        subject: 'Payout sent',
        message: payoutConfirmationTemplate(organizer.fullname, eventTitle, amountLabel),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }

  static async sendDailySalesSummaryEmail(
    organizer: EmailUser,
    dateLabel: string,
    rows: { eventTitle: string; ticketsSold: number; revenueLabel: string }[],
    totalRevenueLabel: string
  ): Promise<{ success: boolean }> {
    try {
      const result = await sendEmail({
        email: organizer.email,
        subject: `Your sales summary — ${dateLabel}`,
        message: dailySalesSummaryTemplate(organizer.fullname, dateLabel, rows, totalRevenueLabel),
      })
      return { success: !!result?.success }
    } catch {
      return { success: false }
    }
  }
}

export const emailService = new EmailService()
