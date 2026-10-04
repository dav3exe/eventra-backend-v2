import { env } from '../../config/keys.js'

// Brand palette pulled from the actual app (index.css / ticket-card.tsx),
// not invented for email — #0C5C48 is the same gradient start used on the
// in-app ticket stub, so a ticket looks like the same "brand" wherever
// it's seen. Email clients can't read CSS custom properties, so these are
// hardcoded hex, kept in one place for this file to stay consistent.
const BRAND_GREEN = '#0C5C48'
const BRAND_GREEN_DARK = '#021713'
const BRAND_MINT = '#E9F5F0'
const BRAND_AMBER = '#F59E0B'
const INK = '#1C1917'
const SUBTLE = '#57534E'
const MUTED = '#A8A29E'

const baseLayout = (
  title: string,
  name: string,
  content: string,
  actionLink?: string,
  actionText?: string,
  expiryText?: string,
  code?: string
) => `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="X-UA-Compatible" content="IE=edge" />
        <title>${title} - Eventra</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');

          body {
            font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #F5F0EB;
            margin: 0;
            padding: 0;
            -webkit-font-smoothing: antialiased;
          }

          .wrapper {
            width: 100%;
            table-layout: fixed;
            background-color: #F5F0EB;
            padding: 48px 0;
          }

          .container {
            width: 100%;
            max-width: 600px;
            background-color: #FFFFFF;
            margin: 0 auto;
            border-radius: 24px;
            overflow: hidden;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.06);
            border: 1px solid #EAE2D7;
          }

          /* Solid brand banner instead of a decorative gradient — reads as
             "Eventra green" at a glance rather than generic rainbow trim */
          .top-banner {
            height: 6px;
            background-color: ${BRAND_GREEN};
          }

          .header {
            background-color: #FFFFFF;
            padding: 32px 40px 20px;
            text-align: left;
          }

          .logo-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
          }

          .logo-text {
            font-size: 22px;
            font-weight: 800;
            color: ${INK};
            letter-spacing: -0.02em;
            display: flex;
            align-items: center;
          }

          .event-badge {
            font-size: 11px;
            font-weight: 700;
            color: ${BRAND_GREEN};
            background-color: ${BRAND_MINT};
            padding: 4px 10px;
            border-radius: 20px;
            letter-spacing: 0.03em;
            text-transform: uppercase;
          }

          .content {
            padding: 32px 40px;
            color: ${SUBTLE};
          }

          .title {
            font-size: 26px;
            font-weight: 700;
            margin-bottom: 20px;
            color: ${INK};
            letter-spacing: -0.02em;
            line-height: 1.2;
          }

          .greeting {
            font-size: 15px;
            font-weight: 600;
            color: ${BRAND_GREEN};
            margin-bottom: 12px;
          }

          .text {
            font-size: 15px;
            line-height: 1.7;
            margin-bottom: 28px;
            color: ${SUBTLE};
          }

          .ticket-line {
            margin: 24px 0;
            background-color: ${BRAND_MINT};
            padding: 16px 20px;
            border-radius: 12px;
            border-left: 4px solid ${BRAND_GREEN};
          }

          .ticket-line p {
            margin: 0;
            font-size: 14px;
            color: ${SUBTLE};
            line-height: 1.6;
          }

          .button-container {
            margin: 32px 0;
            text-align: center;
          }

          .button {
            background-color: ${BRAND_GREEN};
            color: #FFFFFF !important;
            padding: 14px 32px;
            border-radius: 12px;
            text-decoration: none;
            font-weight: 600;
            font-size: 15px;
            display: inline-block;
            box-shadow: 0 4px 14px rgba(12, 92, 72, 0.25);
          }

          .code-display {
            margin: 28px 0;
            text-align: center;
          }

          .code-digits {
            /* inline-block, not inline-flex — flexbox support is
               inconsistent across email clients (Outlook desktop doesn't
               support it at all), which is why this wasn't reliably
               centering. inline-block + text-align on the parent is the
               standard, universally-supported way to center a row of boxes
               in HTML email. */
            display: inline-block;
            background-color: ${BRAND_MINT};
            padding: 16px 24px;
            border-radius: 16px;
            border: 2px dashed ${BRAND_GREEN};
          }

          .code-digit {
            display: inline-block;
            width: 48px;
            height: 56px;
            line-height: 56px;
            background-color: #FFFFFF;
            border-radius: 12px;
            border: 2px solid #CFE8DF;
            font-size: 28px;
            font-weight: 800;
            color: ${BRAND_GREEN};
            letter-spacing: 2px;
            text-align: center;
            vertical-align: middle;
            margin-right: 10px;
          }

          .code-digit:last-child {
            margin-right: 0;
          }

          .expiry-text {
            font-size: 13px;
            color: ${MUTED};
            margin-top: 16px;
            font-style: italic;
            text-align: center;
          }

          /* Ticket stub — mirrors the in-app ticket card: dark green
             "boarding pass" header, perforated tear line, light counterfoil
             below listing each code. Only used by ticketConfirmationTemplate. */
          .stub {
            margin: 24px 0;
            border-radius: 16px;
            overflow: hidden;
            border: 1px solid #DCEEE7;
          }

          .stub-head {
            background: linear-gradient(135deg, ${BRAND_GREEN} 0%, ${BRAND_GREEN_DARK} 100%);
            color: #FFFFFF;
            padding: 20px 24px;
          }

          .stub-eyebrow {
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #BFE3D6;
            margin: 0 0 6px;
          }

          .stub-title {
            font-size: 19px;
            font-weight: 700;
            margin: 0 0 10px;
            line-height: 1.3;
          }

          .stub-meta {
            font-size: 13px;
            color: #E4F3EE;
            margin: 2px 0;
          }

          .stub-tear {
            height: 0;
            border-top: 2px dashed #CFE8DF;
            position: relative;
          }

          .stub-body {
            background-color: ${BRAND_MINT};
            padding: 18px 24px;
          }

          .stub-body-label {
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: ${BRAND_GREEN};
            margin: 0 0 10px;
          }

          /* Each ticket's QR + short code — stacked so the (much longer)
             real ticket code never has to fit next to a label on one line. */
          .stub-ticket {
            background-color: #FFFFFF;
            border: 1px solid #CFE8DF;
            border-radius: 10px;
            padding: 16px;
            margin-bottom: 8px;
            text-align: center;
          }

          .stub-ticket-label {
            font-family: 'Plus Jakarta Sans', sans-serif;
            font-size: 12px;
            font-weight: 600;
            color: ${SUBTLE};
            margin: 0 0 10px;
          }

          .stub-qr {
            width: 120px;
            height: 120px;
            display: block;
            margin: 0 auto 10px;
            border-radius: 6px;
          }

          .stub-ticket-code {
            font-family: 'Courier New', monospace;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.04em;
            color: ${INK};
            word-break: break-all;
          }

          .divider {
            height: 1px;
            background: linear-gradient(90deg, transparent, #E7E5E4, transparent);
            margin: 32px 0;
          }

          .footer {
            padding: 0 40px 40px;
            text-align: left;
            color: ${MUTED};
            font-size: 12px;
          }

          .footer-links {
            margin-bottom: 16px;
          }

          .footer-link {
            color: #78716C;
            text-decoration: none;
            margin-right: 16px;
            font-weight: 500;
            font-size: 13px;
          }

          .footer-link:hover {
            color: ${BRAND_GREEN};
          }

          @media only screen and (max-width: 640px) {
            .wrapper {
              padding: 20px 0;
            }
            .container {
              border-radius: 16px;
              border-left: none;
              border-right: none;
            }
            .content, .header, .footer {
              padding-left: 24px;
              padding-right: 24px;
            }
            .title {
              font-size: 22px;
            }
          }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="container">
            <div class="top-banner"></div>

            <div class="header">
              <div class="logo-row">
                <div class="logo-text">
                  <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${BRAND_GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 10px;">
                    <path d="M4 19 L9 4 L13 19 L17 6 L20 19" />
                  </svg>
                  Eventra
                </div>
                <span class="event-badge">✨ Live</span>
              </div>
            </div>

            <div class="content">
              <h1 class="title">${title}</h1>
              <p class="greeting">Hey ${name} 👋,</p>
              <div class="text">${content}</div>

              ${actionLink
    ? `
                <div class="button-container">
                  <a href="${actionLink}" class="button">${actionText || "Let's Go"}</a>
                </div>
              `
    : ''
  }

              ${code
    ? `
                <div class="code-display">
                  <div class="code-digits">
                    ${code
      .split('')
      .map(d => `<div class="code-digit">${d}</div>`)
      .join('')}
                  </div>
                </div>
              `
    : ''
  }

              ${expiryText ? `<p class="expiry-text">⏱️ ${expiryText}</p>` : ''}

              <div class="divider"></div>

              <p style="font-size: 13px; color: ${MUTED}; line-height: 1.5; margin: 0;">
                Didn't expect this email? No worries — just ignore it and we'll leave you.
              </p>
            </div>

            <div class="footer">
              <div class="footer-links">
                <a href="#" class="footer-link">Help Center</a>
                <a href="#" class="footer-link">Privacy</a>
                <a href="#" class="footer-link">Terms</a>
                <a href="#" class="footer-link">Unsubscribe</a>
              </div>
              <p style="margin-bottom: 8px;">
                © ${new Date().getFullYear()} Eventra. All rights reserved.
              </p>
              <p style="color: ${MUTED}; font-size: 12px;">
                Making every event unforgettable. 🎪
              </p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `

export const resetPasswordTemplate = (name: string, code: string) =>
  baseLayout(
    'Reset your Eventra password 🔑',
    name,
    `
      We got a request to reset the password on your account.
      Enter this code to choose a new one — if you didn't ask for this, you can safely ignore this email.
    `,
    undefined,
    undefined,
    "This code expires in 15 minutes — request a new one if it lapses.",
    code
  )

/**
 * For someone who checked out or RSVP'd as a guest (no account) and wants
 * to view/manage their ticket later. No name to greet them by here — a
 * guest's name lives on the ticket, not anywhere this template has access
 * to before the code is even verified — so this keeps the greeting generic.
 */
export const guestTicketAccessTemplate = (code: string) =>
  baseLayout(
    'Access your tickets 🎟️',
    'there',
    `
      Someone requested access to the Eventra ticket(s) linked to this email address.
      Enter this code to view and manage them — if this wasn't you, you can safely ignore this email.
    `,
    undefined,
    undefined,
    'This code expires in 15 minutes.',
    code
  )

/**
 * Redesigned as an actual ticket stub (dark green "boarding pass" header +
 * perforated tear + light counterfoil listing each code) rather than plain
 * text lines — matches the in-app ticket-card.tsx look. Each ticket's QR
 * is a normal hosted <img src="...">, pointed at the public
 * getTicketQrCodeImage endpoint — not a base64 data: URI (Gmail strips
 * those outright) and not a cid: attachment reference (Brevo, this app's
 * email provider, doesn't support inline/CID attachments at all — confirmed
 * dead end, not a guess). A real fetchable URL is the only approach that
 * reliably renders across email clients. The same QR is still sent as a
 * PNG attachment too, for anyone who wants to save or print it directly.
 */
/**
 * Same shortening the frontend does for ticket cards (see
 * formatTicketCodeForDisplay in features/tickets/adapters.ts) — the real
 * code is a 40-char secret meant for the QR, not for a human to read on a
 * narrow line.
 */
const formatCodeForDisplay = (code: string): string => `EVT-${code.slice(-6).toUpperCase()}`

export const ticketConfirmationTemplate = (
  name: string,
  eventTitle: string,
  eventDateLabel: string,
  venueLabel: string,
  tickets: { code: string; qrCodeUrl?: string }[] = []
) => {
  const ticketCount = tickets.length

  return baseLayout(
    `You're going to ${eventTitle}! 🎉`,
    name,
    `
      Your ${ticketCount > 1 ? `${ticketCount} tickets are` : 'ticket is'} confirmed. Here's your stub for the door:

      <div class="stub">
        <div class="stub-head">
          <p class="stub-eyebrow">${ticketCount > 1 ? `${ticketCount} Admissions` : 'General Admission'}</p>
          <p class="stub-title">${eventTitle}</p>
          <p class="stub-meta">${eventDateLabel}</p>
          <p class="stub-meta">${venueLabel}</p>
        </div>
        <div class="stub-tear"></div>
        <div class="stub-body">
          <p class="stub-body-label">${ticketCount > 1 ? 'Ticket codes' : 'Ticket code'}</p>
          ${tickets
      .map(
        ({ code, qrCodeUrl }, i) =>
          // Prefer the permanent Cloudinary URL generated at issuance
          // time (see TicketService.attachQrCodeUrls) — a plain
          // hosted image Brevo never has to fetch itself. Falls back
          // to the old getTicketQrCodeImage API route only if that
          // upload didn't happen for this ticket (e.g. it failed, or
          // this is a ticket issued before this change existed).
          // Base64 data URIs are avoided (Gmail strips them) and
          // Brevo doesn't support true cid: inline attachments at
          // all, so a real fetchable URL is the only reliable option
          // either way.
          // Every element below repeats its CSS-class rule as an inline
          // style="" too, on top of keeping the class. That's deliberate,
          // not redundant: the classes above live in a <head><style> block,
          // which several mobile mail apps (the Gmail app in particular)
          // strip out entirely and only honor inline styles — without
          // this, the QR code loses its centering on exactly those
          // clients and ends up stuck against one side instead of centered
          // under the guest label.
          `<div class="stub-ticket" style="background-color:#FFFFFF;border:1px solid #CFE8DF;border-radius:10px;padding:16px;margin-bottom:8px;text-align:center;">
                  <p class="stub-ticket-label" style="font-family:'Plus Jakarta Sans',sans-serif;font-size:12px;font-weight:600;color:${SUBTLE};margin:0 0 10px;text-align:center;">${tickets.length > 1 ? `Guest ${i + 1}` : 'Scan at the door'}</p>
                  <img src="${qrCodeUrl || `${env.API_URL}/api/v1/tickets/qrcode-image/${code}`}" width="120" height="120" alt="Ticket QR code" class="stub-qr" style="width:120px;height:120px;display:block;margin:0 auto 10px;border-radius:6px;" />
                  <p class="stub-ticket-code" style="font-family:'Courier New',monospace;font-size:13px;font-weight:700;letter-spacing:0.04em;color:${INK};word-break:break-all;text-align:center;margin:0;">${formatCodeForDisplay(code)}</p>
                </div>`
      )
      .join('')}
        </div>
      </div>

      Show the QR code${ticketCount > 1 ? 's' : ''} above at the door for entry — you can also find ${ticketCount > 1 ? 'them' : 'it'} anytime under My Tickets.
    `
  )
}

export const organizerApprovedTemplate = (name: string) =>
  baseLayout(
    "You're approved to organize on Eventra! ✅",
    name,
    `
      Good news — your organizer account has been approved.
      You can now submit paid events for review and receive payouts once they sell tickets.
    `
  )

export const organizerRejectedTemplate = (name: string) =>
  baseLayout(
    'Update on your organizer application',
    name,
    `
      Your organizer account wasn't approved this time — this is usually due to
      incomplete or unverifiable bank details. Please double check your bank details
      in your organizer profile and reach out to support if you have questions.
    `
  )

export const eventApprovedTemplate = (name: string, eventTitle: string) =>
  baseLayout(
    `${eventTitle} is live! 🎉`,
    name,
    `
      Your event <strong style="color: ${INK};">${eventTitle}</strong> has been reviewed and approved.
      It's now visible to attendees and ready to sell tickets or take reservations.
    `
  )

export const eventRejectedTemplate = (name: string, eventTitle: string, reason: string) =>
  baseLayout(
    `${eventTitle} needs a change before it can go live`,
    name,
    `
      Your event <strong style="color: ${INK};">${eventTitle}</strong> wasn't approved this time.

      <div class="ticket-line">
        <strong style="color: ${INK};">Reason:</strong> ${reason}
      </div>

      You can edit the event and resubmit it for review once it's addressed.
    `
  )

export const eventCancelledTemplate = (name: string, eventTitle: string, eventDateLabel: string, reason: string, isPaid: boolean) =>
  baseLayout(
    `${eventTitle} has been cancelled`,
    name,
    `
      We're sorry to tell you that <strong style="color: ${INK};">${eventTitle}</strong>,
      originally scheduled for ${eventDateLabel}, has been cancelled by the organizer.

      <div class="ticket-line">
        <strong style="color: ${INK};">Reason:</strong> ${reason}
      </div>

      ${isPaid
      ? `Since this was a paid ticket, a refund is being processed back to your original payment method — you'll get a separate email once it's complete.`
      : `No action is needed on your end — your reservation has simply been cancelled.`
    }
    `
  )

export const eventPostponedTemplate = (
  name: string,
  eventTitle: string,
  oldDateLabel: string,
  newDateLabel: string,
  reason?: string
) =>
  baseLayout(
    `${eventTitle} has a new date`,
    name,
    `
      <strong style="color: ${INK};">${eventTitle}</strong> has been postponed from its original
      date of ${oldDateLabel}.

      <div class="ticket-line">
        <strong style="color: ${INK};">New date:</strong> ${newDateLabel}
      </div>

      ${reason ? `<div class="ticket-line"><strong style="color: ${INK};">Reason:</strong> ${reason}</div>` : ''}

      Your existing ticket is still valid for the new date — nothing further is needed from you.
      If the new date doesn't work for you, you can request a refund from My Tickets.
    `
  )

  export const eventReminderTemplate = (name: string, eventTitle: string, dateLabel: string) =>
  baseLayout(
    `Reminder: ${eventTitle} is tomorrow`,
    name,
    `
      Just a heads-up — <strong style="color: ${INK};">${eventTitle}</strong> is happening soon.
      <div class="ticket-line">
        <strong style="color: ${INK};">When:</strong> ${dateLabel}
      </div>
      Check My Tickets for your ticket details and venue information.
    `
  )

  export const weeklyPicksTemplate = (
  name: string,
  events: { title: string; startDate: Date; slug: string }[]
) => {
  const eventsList = events
    .map(
      (event) => `
        <div class="ticket-line">
          <strong style="color: ${INK};">${event.title}</strong> —
          ${new Date(event.startDate).toLocaleDateString('en-NG', { weekday: 'short', month: 'short', day: 'numeric' })}
        </div>
      `
    )
    .join('')

  return baseLayout(
    "This week's best events",
    name,
    `
      Here's what's trending on Eventra this week:
      ${eventsList}
      Head to the app to grab your ticket before they sell out.
    `
  )
}

export const organizerUpdateTemplate = (name: string, organizerName: string, eventTitle: string) =>
  baseLayout(
    `${organizerName} just posted a new event`,
    name,
    `
      <strong style="color: ${INK};">${organizerName}</strong>, an organizer you follow, just published a new event:
      <div class="ticket-line">
        <strong style="color: ${INK};">${eventTitle}</strong>
      </div>
      Check it out on Eventra before it sells out.
    `
  )

/**
 * Sent when an organizer edits a LIVE (approved/postponed) event — see
 * buildEventChangeSummary in event.controller.ts. `changes` is always
 * non-empty when this is called (the controller only emails attendees once
 * it's confirmed there's actually something worth telling them about).
 */
export const eventUpdatedTemplate = (name: string, eventTitle: string, changes: string[]) =>
  baseLayout(
    `${eventTitle} has been updated`,
    name,
    `
      The organizer has made some changes to <strong style="color: ${INK};">${eventTitle}</strong>
      since you got your ticket. Here's what's different:

      ${changes
      .map(change => `<div class="ticket-line">${change}</div>`)
      .join('')}

      Your ticket is still valid — no action is needed unless the change affects your plans, in
      which case you can request a refund from My Tickets (subject to the event's refund policy).
    `
  )

export const refundProcessedTemplate = (name: string, eventTitle: string, amountLabel: string) =>
  baseLayout(
    'Your refund has been processed',
    name,
    `
      Your refund for <strong style="color: ${INK};">${eventTitle}</strong> has been processed.
      <div class="ticket-line">
        <strong style="color: ${INK};">Amount refunded:</strong> ${amountLabel}
      </div>
      It should reflect on your original payment method within a few business days, depending on your bank.
    `
  )
export const refundRejectedTemplate = (name: string, eventTitle: string, amountLabel: string, reason?: string) =>
  baseLayout(
    'Your refund request was declined',
    name,
    `
      Your refund request for <strong style="color: ${INK};">${eventTitle}</strong> was not approved.
      <div class="ticket-line">
        <strong style="color: ${INK};">Amount requested:</strong> ${amountLabel}
      </div>
      ${reason ? `<div class="ticket-line"><strong style="color: ${INK};">Reason:</strong> ${reason}</div>` : ''}
      If you have questions about this decision, please reach out to the event organizer.
    `
  )

export const verifyAccountTemplate = (name: string, code: string, actionLink?: string) =>
  baseLayout(
    'Your Access to Eventra 🎟️',
    name,
    `
      Welcome to <strong>Eventra</strong> — your backstage pass to managing incredible events.
      You're one step away from going live.

      <div class="ticket-line">
        <strong style="color: ${INK};">Enter this code to verify your email</strong>
      </div>
    `,
    actionLink,
    'Verify & Join',
    "This code expires in 15 minutes — don't miss the show.",
    code
  )

// Below: organizer-facing notification emails, each gated behind its own
// toggle on the Settings page (see IOrganizerNotificationPreferences on the
// User model) — newSalesRsvps, payoutConfirmations, dailySalesSummary.

export const newSaleNotificationTemplate = (name: string, eventTitle: string, attendeeName: string, ticketLabel: string, amountLabel: string) =>
  baseLayout(
    `New ${amountLabel === 'Free RSVP' ? 'RSVP' : 'sale'} for ${eventTitle}`,
    name,
    `
      ${attendeeName} just ${amountLabel === 'Free RSVP' ? 'reserved a spot for' : 'bought a ticket to'}
      <strong style="color: ${INK};">${eventTitle}</strong>.

      <div class="ticket-line">
        <strong style="color: ${INK};">Ticket:</strong> ${ticketLabel}
      </div>
      <div class="ticket-line">
        <strong style="color: ${INK};">Amount:</strong> ${amountLabel}
      </div>
    `
  )

export const payoutConfirmationTemplate = (name: string, eventTitle: string, amountLabel: string) =>
  baseLayout(
    'Payout sent',
    name,
    `
      A payout for <strong style="color: ${INK};">${eventTitle}</strong> is on its way to your bank account.

      <div class="ticket-line">
        <strong style="color: ${INK};">Amount:</strong> ${amountLabel}
      </div>

      It typically lands within a few business days, depending on your bank.
    `
  )

export const refundDeductedTemplate = (name: string, eventTitle: string, amountLabel: string) =>
  baseLayout(
    'A refund was issued for your event',
    name,
    `
      An attendee's refund request for <strong style="color: ${INK};">${eventTitle}</strong> was approved and refunded.
      <div class="ticket-line">
        <strong style="color: ${INK};">Amount refunded:</strong> ${amountLabel}
      </div>
      This amount has been deducted from your earnings for this event.
    `
  )

export const platformFeeChangedTemplate = (name: string, oldPercent: number, newPercent: number) =>
  baseLayout(
    'Commission rate is changing',
    name,
    `
      Eventra's platform commission is changing from <strong style="color: ${INK};">${oldPercent}%</strong> to <strong style="color: ${INK};">${newPercent}%</strong>.
      <div class="ticket-line">
        This only applies to tickets sold from now on — any order already placed keeps the commission rate it was charged at, and won't be recalculated.
      </div>
    `
  )

export const payoutHoldChangedTemplate = (name: string, oldHoldLabel: string, newHoldLabel: string) =>
  baseLayout(
    'Payout timing is changing',
    name,
    `
      Eventra's payout hold period is changing from <strong style="color: ${INK};">${oldHoldLabel}</strong> after an event to <strong style="color: ${INK};">${newHoldLabel}</strong>.
      <div class="ticket-line">
        This only applies to tickets sold from now on — any order already placed keeps the payout timing it had when it was purchased.
      </div>
    `
  )

export const dailySalesSummaryTemplate = (
  name: string,
  dateLabel: string,
  rows: { eventTitle: string; ticketsSold: number; revenueLabel: string }[],
  totalRevenueLabel: string
) =>
  baseLayout(
    `Your sales summary — ${dateLabel}`,
    name,
    `
      Here's how your events did in the last 24 hours.

      ${rows
      .map(
        row => `
            <div class="ticket-line">
              <strong style="color: ${INK};">${row.eventTitle}:</strong> ${row.ticketsSold} sold — ${row.revenueLabel}
            </div>
          `
      )
      .join('')}

      <div class="ticket-line">
        <strong style="color: ${INK};">Total:</strong> ${totalRevenueLabel}
      </div>
    `
  )
  
 export const newsletterWelcomeTemplate = (email: string) =>
  baseLayout(
    "You're subscribed!",
    'there',
    `
      Thanks for subscribing to the Eventra newsletter.
      You'll get the week's best events straight to your inbox — no spam, just the good stuff.
    `
  )
