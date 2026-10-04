import crypto from 'crypto'
import mongoose from 'mongoose'
import logger from '../config/logger.js'
import Event from '../models/event.model.js'
import { IOrder } from '../models/order.model.js'
import Ticket, { ITicket } from '../models/ticket.model.js'
import TicketType from '../models/ticket-type.model.js'
import User from '../models/user.model.js'
import { AttendeeInfo } from './attendee.service.js'
import { generateQrCodeBuffer } from '../utils/qrcode.js'
import { CloudinaryService } from './cloudinary.service.js'
import { EmailService } from './email/email.service.js'
import { NotificationService } from './notification.service.js'

export const formatEventDateLabel = (date: Date): string =>
  date.toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' })

export const formatVenueLabel = (venue: { name: string; city: string }): string => `${venue.name}, ${venue.city}`

export class TicketService {
  /**
   * Unguessable, unique QR payload. A screenshot of one ticket can never
   * pass as another because this value — not the ticket's _id — is what's scanned.
   */
  static generateTicketCode(): string {
    return `EVT-TKT-${crypto.randomBytes(16).toString('hex')}`
  }

  /**
   * Short, human-readable ticket identifier for display (ticket card,
   * organizer attendee lists, etc.) — deliberately separate from both the
   * Mongo `_id` (an implementation detail) and `code` (a long secret that
   * must never double as a look-up-friendly label). Collisions are
   * astronomically unlikely at this length, same trade-off the codebase
   * already makes for `code` above (no retry-on-collision loop either).
   */
  static generateTicketId(): string {
    return `TKT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
  }

  /**
   * Generates each ticket's QR PNG and uploads it to Cloudinary, persisting
   * the returned URL on the ticket document — so the confirmation email can
   * point a plain <img src> at a permanent, fast, publicly-cached URL
   * instead of making Brevo fetch the QR from our own (possibly cold)
   * serverless function at send time.
   *
   * Deliberately NOT run inside the issuance transaction (see
   * rsvpToFreeEvent / issueTicketsForPaidOrder below) — a Cloudinary
   * upload is a third-party network call, and holding a Mongo transaction
   * open while waiting on one is exactly the "slow external call blocking
   * something time-sensitive" problem this whole change exists to avoid.
   * Called after the transaction has already committed.
   *
   * Per-ticket failures are caught individually and logged rather than
   * thrown — tickets are already issued and paid for by this point, so a
   * Cloudinary hiccup must never fail the whole batch. A ticket that fails
   * here simply has no qrCodeUrl, and the email template falls back to the
   * old getTicketQrCodeImage API route for that one ticket.
   */
  private static async attachQrCodeUrls(tickets: ITicket[]): Promise<{ code: string; qrCodeUrl?: string }[]> {
    return Promise.all(
      tickets.map(async ticket => {
        try {
          const buffer = await generateQrCodeBuffer(ticket.code)
          const uploaded = await CloudinaryService.uploadQrCode(buffer)
          await Ticket.updateOne({ _id: ticket._id }, { $set: { qrCodeUrl: uploaded.url } })
          return { code: ticket.code, qrCodeUrl: uploaded.url }
        } catch (error) {
          logger.error({ err: error }, `QR code Cloudinary upload failed for ticket ${ticket._id}`)
          return { code: ticket.code, qrCodeUrl: undefined }
        }
      })
    )
  }

  /**
   * Reserve 1-4 places at a free event in one action (the design calls this
   * "guests" — each guest still gets their own individual ticket/QR, this
   * just lets someone claim several in one request instead of repeating the
   * whole flow). Runs in a transaction: the capacity check + reservation
   * increment + every ticket document must all succeed together, same
   * reasoning as issueTicketsForPaidOrder below — partial success would
   * mean tickets that don't actually correspond to a held reservation.
   */
  static async rsvpToFreeEvent(eventId: string, attendee: AttendeeInfo, guests = 1): Promise<ITicket[]> {
    const session = await mongoose.startSession()
    let issuedTickets: ITicket[] = []
    let eventSnapshot: { _id: mongoose.Types.ObjectId; title: string; startDate: Date; venue: { name: string; city: string } } | null = null

    try {
      await session.withTransaction(async () => {
        const updatedEvent = await Event.findOneAndUpdate(
          {
            _id: eventId,
            type: 'free',
            status: 'approved',
            $or: [
              { capacity: { $exists: false } },
              { capacity: null },
              { $expr: { $lte: [{ $add: ['$reservationsCount', guests] }, '$capacity'] } },
            ],
          },
          { $inc: { reservationsCount: guests } },
          { new: true, session }
        )

        if (!updatedEvent) {
          const existing = await Event.findById(eventId).session(session).lean()
          if (!existing || existing.type !== 'free' || existing.status !== 'approved') {
            throw new Error('This event is not open for reservations')
          }
          const remaining = (existing.capacity ?? Infinity) - existing.reservationsCount
          throw new Error(
            remaining <= 0 ? 'This event is fully booked' : `Only ${remaining} spot(s) left — lower your guest count`
          )
        }

        eventSnapshot = updatedEvent

        issuedTickets = await Ticket.create(
          Array.from({ length: guests }, () => ({
            event: updatedEvent._id,
            attendee: attendee.userId,
            ticketId: this.generateTicketId(),
            code: this.generateTicketCode(),
            type: 'free' as const,
            price: 0,
            attendeeName: attendee.fullname,
            attendeeEmail: attendee.email,
            status: 'valid' as const,
          })),
          { session, ordered: true }
        )
      })
    } finally {
      await session.endSession()
    }

    if (eventSnapshot) {
      const evt = eventSnapshot as { _id: mongoose.Types.ObjectId; title: string; startDate: Date; venue: { name: string; city: string } } & { organizer?: mongoose.Types.ObjectId }
      const evtSnapshotId = evt._id

      this.attachQrCodeUrls(issuedTickets)
        .then(tickets =>
          EmailService.sendTicketConfirmationEmail({
            user: attendee,
            eventTitle: evt.title,
            eventDateLabel: formatEventDateLabel(evt.startDate),
            venueLabel: formatVenueLabel(evt.venue),
            tickets,
          })
        )
        .catch(error => logger.error({ err: error }, `Ticket confirmation email failed for RSVP on event ${eventId}`))

      this.notifyOrganizerOfSale(
        evt.organizer,
        evtSnapshotId,
        evt.title,
        attendee.fullname,
        `${issuedTickets.length} guest(s)`,
        'Free RSVP'
      ).catch(error => logger.error({ err: error }, `New-RSVP organizer notification failed for event ${eventId}`))
    }

    return issuedTickets
  }

  /**
   * Notifies the organizer that a sale/RSVP just happened — both as an
   * in-app bell notification (always created; that's just a reflection of
   * what happened, not something anyone opts out of) and as an email
   * (still opt-in, gated by organizerNotificationPreferences.newSalesRsvps,
   * defaults to off, same as every other organizer notification toggle on
   * Settings — that toggle only ever controlled the email channel). Kept as
   * its own helper since both issuance paths (free RSVP and paid checkout)
   * need it.
   */
  private static async notifyOrganizerOfSale(
    organizerId: mongoose.Types.ObjectId | undefined,
    eventId: mongoose.Types.ObjectId,
    eventTitle: string,
    attendeeName: string,
    ticketLabel: string,
    amountLabel: string
  ): Promise<void> {
    if (!organizerId) return

    NotificationService.create({
      recipient: organizerId,
      type: 'new_sale',
      title: 'New ticket sale',
      message: `${attendeeName} just got ${ticketLabel} for "${eventTitle}" (${amountLabel})`,
      link: `/dashboard/events`,
      relatedEvent: eventId,
    }).catch(error => logger.error({ err: error }, `New-sale in-app notification failed for event ${eventId}`))

    const organizer = await User.findById(organizerId)
    if (!organizer?.organizerNotificationPreferences?.newSalesRsvps) return
    await EmailService.sendNewSaleNotificationEmail(organizer, eventTitle, attendeeName, ticketLabel, amountLabel)
  }

  /**
   * Issue tickets for a paid order once payment has been verified with Paystack.
   * Runs inside a transaction: ticket-type stock decrement, ticket creation, and
   * event/order totals must all succeed together or not at all.
   */
  static async issueTicketsForPaidOrder(order: IOrder, attendee: AttendeeInfo): Promise<ITicket[]> {
    const session = await mongoose.startSession()
    let issuedTickets: ITicket[] = []

    try {
      await session.withTransaction(async () => {
        issuedTickets = []

        for (const item of order.items) {
          // Atomic guard: only decrement if enough stock remains — prevents
          // overselling a ticket type when two buyers check out at once.
          const updatedTicketType = await TicketType.findOneAndUpdate(
            {
              _id: item.ticketType,
              $expr: { $lte: [{ $add: ['$quantitySold', item.quantity] }, '$quantity'] },
            },
            { $inc: { quantitySold: item.quantity } },
            { new: true, session }
          )

          if (!updatedTicketType) {
            throw new Error('One or more ticket types sold out before payment was confirmed')
          }

          const ticketsForItem = Array.from({ length: item.quantity }).map(() => ({
            event: order.event,
            attendee: attendee.userId,
            ticketType: item.ticketType,
            order: order._id,
            ticketId: this.generateTicketId(),
            code: this.generateTicketCode(),
            type: 'paid' as const,
            price: item.unitPrice,
            attendeeName: attendee.fullname,
            attendeeEmail: attendee.email,
            status: 'valid' as const,
          }))

          const created = await Ticket.create(ticketsForItem, { session, ordered: true })
          issuedTickets.push(...created)
        }

        const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0)

        await Event.updateOne(
          { _id: order.event },
          {
            $inc: {
              ticketsSoldCount: totalQuantity,
              revenueTotal: order.organizerEarnings,
            },
          },
          { session }
        )

        order.status = 'paid'
        order.paidAt = new Date()
        order.payoutStatus = 'pending'
        await order.save({ session })
      })

      const event = await Event.findById(order.event).lean()
      if (event) {
        this.attachQrCodeUrls(issuedTickets)
          .then(tickets =>
            EmailService.sendTicketConfirmationEmail({
              user: attendee,
              eventTitle: event.title,
              eventDateLabel: formatEventDateLabel(event.startDate),
              venueLabel: formatVenueLabel(event.venue),
              tickets,
            })
          )
          .catch(error => logger.error({ err: error }, `Ticket confirmation email failed for order ${order._id}`))

        const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0)
        this.notifyOrganizerOfSale(
          event.organizer,
          event._id,
          event.title,
          attendee.fullname,
          `${totalQuantity} ticket(s)`,
          `₦${order.total.toLocaleString('en-NG')}`
        ).catch(error => logger.error({ err: error }, `New-sale organizer notification failed for order ${order._id}`))
      }

      return issuedTickets
    } finally {
      await session.endSession()
    }
  }
}

export const ticketService = new TicketService()