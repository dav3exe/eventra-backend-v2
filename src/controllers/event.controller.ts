import crypto from 'crypto'
import { Request, Response } from 'express'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import { buildPaginationMeta, escapeRegExp, getDateRangeForWhen, getPagination, isValidObjectId, slugify } from '../utils/helpers.js'
import Category from '../models/category.model.js'
import Event from '../models/event.model.js'
import Order from '../models/order.model.js'
import Report from '../models/report.model.js'
import Ticket from '../models/ticket.model.js'
import TicketType from '../models/ticket-type.model.js'
import User from '../models/user.model.js'
import { PaystackService } from '../services/paystack.service.js'
import { EmailService } from '../services/email/email.service.js'
import logger from '../config/logger.js'
import { formatEventDateLabel, formatVenueLabel } from '../services/ticket.service.js'
import { NotificationService } from '../services/notification.service.js'
import PlatformSettings from '../models/platform-settings.model.js'
import mongoose from 'mongoose'
import {
  applyRate,
  applyRateToNaira,
  applyTicketTypeRate,
  EVENT_LEDGER_CURRENCY,
  getDisplayRate,
  resolveViewerCurrency,
  TICKET_TYPE_CURRENCY,
} from '../services/currency/viewer-currency.js'

const EDITABLE_STATUSES = ['draft', 'rejected']

// A live (approved/postponed) event can still be edited, but only up to a
// few days before it starts — after that, changes are frozen so attendees
// aren't blindsided right before the door opens. Draft/rejected events
// aren't gated by this at all (see EDITABLE_STATUSES above).
export const LIVE_EDITABLE_STATUSES = ['approved', 'postponed']
export const LIVE_EDIT_CUTOFF_DAYS = 3

export const isPastLiveEditCutoff = (startDate?: Date | null): boolean => {
  if (!startDate) return false
  const cutoff = new Date(startDate.getTime() - LIVE_EDIT_CUTOFF_DAYS * 24 * 60 * 60 * 1000)
  return new Date() >= cutoff
}

// Only the fields that matter for telling an attendee "something changed" —
// deliberately excludes ticket type price/quantity (those live on
// TicketType, not Event, and don't retroactively affect someone who
// already has a ticket at the price they paid).
type EventChangeSnapshot = {
  title?: string
  description?: string
  startDate?: Date
  endDate?: Date
  isOnline?: boolean
  venue?: { name?: string; address?: string; city?: string; state?: string }
  onlinePlatform?: string
  onlineJoinLink?: string
  capacity?: number
  refundPolicy?: { type?: string; daysBefore?: number }
  agePolicy?: string
  lineupCount?: number
}

const snapshotEventForDiff = (event: InstanceType<typeof Event>): EventChangeSnapshot => ({
  title: event.title,
  description: event.description,
  startDate: event.startDate,
  endDate: event.endDate,
  isOnline: event.isOnline,
  venue: event.venue ? (typeof (event.venue as any).toObject === 'function' ? (event.venue as any).toObject() : { ...event.venue }) : undefined,
  onlinePlatform: event.onlinePlatform,
  onlineJoinLink: event.onlineJoinLink,
  capacity: event.capacity,
  refundPolicy: event.refundPolicy ? (typeof (event.refundPolicy as any).toObject === 'function' ? (event.refundPolicy as any).toObject() : { ...event.refundPolicy }) : undefined,
  agePolicy: event.agePolicy,
  lineupCount: event.lineup?.length ?? 0,
})

const buildEventChangeSummary = (before: EventChangeSnapshot, after: InstanceType<typeof Event>): string[] => {
  const changes: string[] = []
  if (before.title !== undefined && after.title && before.title !== after.title) {
    changes.push(`Event name changed from "${before.title}" to "${after.title}"`)
  }
  if (before.startDate && after.startDate && before.startDate.getTime() !== after.startDate.getTime()) {
    changes.push(`Date/time changed to ${formatEventDateLabel(after.startDate)}`)
  }
  if (Boolean(before.isOnline) !== Boolean(after.isOnline)) {
    changes.push(after.isOnline ? 'Moved online' : 'Switched to an in-person venue')
  } else if (!after.isOnline && before.venue && after.venue) {
  // Treat "" / null / undefined as equivalent — an edit form that
  // round-trips an unset field as "" shouldn't register as a real change.
  const normalize = (v: unknown) => v || undefined
  const venueChanged =
    normalize(before.venue.name) !== normalize(after.venue.name) ||
    normalize(before.venue.address) !== normalize(after.venue.address) ||
    normalize(before.venue.city) !== normalize(after.venue.city) ||
    normalize(before.venue.state) !== normalize(after.venue.state)
  if (venueChanged) {
    changes.push(`Venue changed to ${formatVenueLabel(after.venue)}`)
  }
} else if (after.isOnline && (before.onlinePlatform !== after.onlinePlatform || before.onlineJoinLink !== after.onlineJoinLink)) {
    changes.push('Online access details updated — check My Tickets for the latest link')
  }
  if (before.description !== undefined && before.description !== after.description) {
    changes.push('Event description updated')
  }
  if (before.capacity !== after.capacity) {
    changes.push('Capacity updated')
  }
 if (
  before.refundPolicy &&
  after.refundPolicy &&
  (before.refundPolicy.type !== after.refundPolicy.type ||
    (before.refundPolicy.daysBefore || undefined) !== (after.refundPolicy.daysBefore || undefined))
) {
  changes.push('Refund policy updated')
}
  if (before.agePolicy !== after.agePolicy) {
    changes.push('Age policy updated')
  }
  if (before.lineupCount !== (after.lineup?.length ?? 0)) {
    changes.push('Lineup updated')
  }
  return changes
}

/**
 * Emails every attendee following this organizer that a new event was
 * just published. Fire-and-forget, same pattern as every other
 * best-effort notification in this file — a failure here never blocks
 * the event actually going live.
 */
const notifyFollowersOfNewEvent = async (organizerId: mongoose.Types.ObjectId, eventTitle: string, organizerName: string): Promise<void> => {
  try {
    const followers = await User.find({ following: organizerId })
      .select('fullname email notificationPreferences')
      .lean()

    const optedIn = followers.filter(f => f.notificationPreferences?.organizerUpdates === true)

    await Promise.all(
      optedIn.map(follower =>
        EmailService.sendOrganizerUpdateEmail(follower, organizerName, eventTitle)
      )
    )
  } catch (error) {
    logger.error({ err: error }, `Follower notification failed for organizer ${organizerId}`)
  }
}



export const createEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { category: categoryId, ...rest } = req.body

  // Only validated when provided — the wizard creates the draft right
  // after Step 1 (Type only), well before Step 2 collects a category.
  let category = null
  if (categoryId) {
    category = await Category.findOne({ _id: categoryId, isActive: true })
    if (!category) {
      return sendTsRestError(res, 400, 'Invalid or inactive category')
    }
  }

  // Untitled drafts still need a unique slug to satisfy the schema — this
  // gets replaced with a proper title-based one the moment a title is set
  // (see updateEvent below), so it's never the slug a published event
  // actually ends up with.
  const slug = `${rest.title ? slugify(rest.title) : 'untitled-event'}-${crypto.randomBytes(3).toString('hex')}`

  const event = await Event.create({
    ...rest,
    ...(category ? { category: category._id } : {}),
    slug,
    organizer: req.session.userId,
    status: 'draft',
  })

  return sendTsRestSuccess(res, 201, {
    success: true,
    message: 'Event created as a draft',
    body: event.toObject(),
  })
})

export const updateEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const event = await Event.findOne({ _id: id, organizer: req.session.userId })

  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  const isDraftEdit = EDITABLE_STATUSES.includes(event.status)
  const isLiveEdit = LIVE_EDITABLE_STATUSES.includes(event.status)

  if (!isDraftEdit && !isLiveEdit) {
    return sendTsRestError(res, 400, 'This event cannot be edited in its current state')
  }

  if (isLiveEdit && isPastLiveEditCutoff(event.startDate)) {
    return sendTsRestError(
      res,
      400,
      `This event starts in less than ${LIVE_EDIT_CUTOFF_DAYS} days and can no longer be edited`
    )
  }

  // Snapshot BEFORE Object.assign so buildEventChangeSummary can diff
  // against what's actually about to change — only taken for a live edit,
  // since a draft/rejected event has no attendees to notify yet.
  const before = isLiveEdit ? snapshotEventForDiff(event) : null

  const { category: categoryId, ...rest } = req.body

  if (categoryId) {
    const category = await Category.findOne({ _id: categoryId, isActive: true })
    if (!category) {
      return sendTsRestError(res, 400, 'Invalid or inactive category')
    }
    event.category = category._id
  }

  Object.assign(event, rest)

  // Only while still 'draft' — a rejected event being fixed already has a
  // slug that may have been shared/seen, so editing it further shouldn't
  // change the URL out from under anyone.
  if (rest.title && event.status === 'draft') {
    event.slug = `${slugify(rest.title)}-${crypto.randomBytes(3).toString('hex')}`
  }

  await event.save()

  // Best-effort, fire-and-forget — mirrors cancelEvent/postponeEvent below.
  // Only fires for a live edit, and only once there's actually something
  // worth telling attendees about (a no-op save shouldn't spam anyone).
    // Best-effort, fire-and-forget — mirrors cancelEvent/postponeEvent below.
  // Only fires for a live edit, and only once there's actually something
  // worth telling attendees about (a no-op save shouldn't spam anyone).
  
    if (before) {
    const changes = buildEventChangeSummary(before, event)

    if (changes.length > 0) {
      Ticket.find({ event: event._id, status: { $in: ['valid', 'checked_in'] } })
        .select('attendeeName attendeeEmail attendee')
        .lean()
        .then(affectedTickets => {
          const uniqueAttendees = Array.from(new Map(affectedTickets.map(t => [t.attendeeEmail, t])).values())
          Promise.all(
            uniqueAttendees.map(attendee =>
              EmailService.sendEventUpdatedEmail(
                { fullname: attendee.attendeeName, email: attendee.attendeeEmail },
                event.title,
                changes,
              )
            )
          ).catch(error => logger.error({ err: error }, `Event-updated emails failed for event ${event._id}`))

          const registeredAttendeeIds = Array.from(
            new Set(affectedTickets.filter(t => t.attendee).map(t => String(t.attendee)))
          )
          Promise.all(
            registeredAttendeeIds.map(attendeeId =>
              NotificationService.create({
                recipient: attendeeId,
                type: 'event_updated',
                title: 'Event details updated',
                message: `"${event.title}" was updated: ${changes.join('; ')}`,
                link: '/tickets',
                relatedEvent: event._id,
              })
            )
          ).catch(error => logger.error({ err: error }, `Event-updated notifications failed for event ${event._id}`))
        })
    }
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event updated',
    body: event.toObject(),
  })
})

/**
 * Separate from updateEvent on purpose — that endpoint is locked to
 * draft/rejected events because changing venue, date, price, or capacity
 * on a live event is exactly the kind of thing that should require
 * re-approval. Lineup isn't that: "DJ X just confirmed" is routine on an
 * event that's already approved and selling tickets, so this only blocks
 * cancelled events, not approved/pending/postponed ones.
 */
export const updateEventLineup = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const event = await Event.findOne({ _id: id, organizer: req.session.userId })

  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }
  if (event.status === 'cancelled') {
    return sendTsRestError(res, 400, "Can't edit the lineup of a cancelled event")
  }

  event.lineup = req.body.lineup
  await event.save()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Lineup updated',
    body: event.toObject(),
  })
})

export const submitEventForApproval = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const event = await Event.findOne({ _id: id, organizer: req.session.userId })

  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }
  if (!EDITABLE_STATUSES.includes(event.status)) {
    return sendTsRestError(res, 400, 'This event has already been submitted')
  }

  // Every field the wizard collects across its steps used to be required
  // by the Zod schema at creation time — now that a draft can be created
  // with just `type` (see createEventSchema), completeness is enforced
  // here instead, at the point it actually needs to be true.
  const missing: string[] = []
  if (!event.title) missing.push('Event name')
  if (!event.description) missing.push('Description')
  if (!event.category) missing.push('Category')
  if (!event.startDate) missing.push('Date & time')
  if (event.isOnline ? !event.onlineJoinLink : !event.venue) missing.push(event.isOnline ? 'Join link' : 'Venue')
  if (missing.length > 0) {
    return sendTsRestError(res, 400, `Finish these before submitting: ${missing.join(', ')}`)
  }

  const organizer = await User.findById(req.session.userId)
  if (!organizer) {
    return sendTsRestError(res, 404, 'Organizer not found')
  }

    if (event.type === 'paid') {
    if (organizer.organizerProfile?.approvalStatus !== 'approved') {
      return sendTsRestError(res, 403, 'Your organizer account must be approved before publishing a paid event')
    }
    const hasBankDetails = organizer.organizerProfile?.accountNumber && organizer.organizerProfile?.bankCode
    if (!hasBankDetails) {
      return sendTsRestError(res, 400, 'Add your bank account details before publishing a paid event')
    }
    const ticketTypeCount = await TicketType.countDocuments({ event: event._id })
    if (ticketTypeCount === 0) {
      return sendTsRestError(res, 400, 'Add at least one ticket type before submitting a paid event')
    }

    const platformSettings = await PlatformSettings.findOne()

        if (platformSettings?.autoApproveEvents) {
      event.status = 'approved'
      event.rejectionReason = undefined
      event.publishedAt = new Date()
      await event.save()

      notifyFollowersOfNewEvent(event.organizer, event.title, organizer.fullname)

      return sendTsRestSuccess(res, 200, {
        success: true,
        message: 'Your event is live',
        body: event.toObject(),
      })
    }

    event.status = 'pending_approval'
    event.rejectionReason = undefined
    await event.save()

    NotificationService.notifyAdmins({
      type: 'event_pending_review',
      title: 'New event awaiting review',
      message: `"${event.title}" by ${organizer.fullname} was submitted for approval.`,
      link: '/admin/events',
      relatedEvent: event._id,
    }).catch(error => logger.error({ err: error }, `Event-pending-review notification failed for event ${event._id}`))

    return sendTsRestSuccess(res, 200, {
      success: true,
      message: 'Event submitted for admin approval',
      body: event.toObject(),
    })
  }

   // Free events skip organizer-approval and admin review entirely — "Free
  // events can go live now, paid events unlock once you're verified" is
  // the actual promise made on the dashboard banner, so this has to be
  // true regardless of the organizer's own approvalStatus.
  event.status = 'approved'
  event.rejectionReason = undefined
  event.publishedAt = new Date()
  await event.save()

  notifyFollowersOfNewEvent(event.organizer, event.title, organizer.fullname)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Your event is live',
    body: event.toObject(),
  })
})

export const deleteEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const event = await Event.findOne({ _id: id, organizer: req.session.userId })

  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }
  if (!EDITABLE_STATUSES.includes(event.status) || event.reservationsCount > 0 || event.ticketsSoldCount > 0) {
    return sendTsRestError(res, 400, 'Only draft or rejected events with no reservations/sales can be deleted')
  }

  await TicketType.deleteMany({ event: event._id })
  await event.deleteOne()

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Event deleted',
  })
})

/**
 * Clones an event (and its ticket types) into a fresh draft — the fast
 * path for "run this again next month" without re-filling the whole
 * wizard. Deliberately resets everything that shouldn't carry over:
 * status/dates/sales counters/promotion/lineup images stay put, but the
 * new copy starts from zero, unpublished, with its own slug.
 */
export const duplicateEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const source = await Event.findOne({ _id: id, organizer: req.session.userId }).lean()

  if (!source) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  const title = source.title ? `${source.title} (Copy)` : undefined

  const duplicate = await Event.create({
    organizer: req.session.userId,
    title,
    slug: `${title ? slugify(title) : 'untitled-event'}-${crypto.randomBytes(3).toString('hex')}`,
    description: source.description,
    category: source.category,
    type: source.type,
    coverImage: source.coverImage,
    venue: source.venue,
    isOnline: source.isOnline,
    onlinePlatform: source.onlinePlatform,
    onlineJoinLink: source.onlineJoinLink,
    capacity: source.capacity,
    refundPolicy: source.refundPolicy,
    lineup: source.lineup,
    gallery: source.gallery,
    tags: source.tags,
    agePolicy: source.agePolicy,
    // Explicitly NOT carried over: startDate/endDate (last run's dates
    // rarely apply to the next one), status (always starts a fresh
    // draft), isPromoted/promotion, and every sales/reservation counter.
  })

  const sourceTicketTypes = await TicketType.find({ event: source._id }).lean()
  if (sourceTicketTypes.length > 0) {
    await TicketType.insertMany(
      sourceTicketTypes.map(ticketType => ({
        event: duplicate._id,
        name: ticketType.name,
        description: ticketType.description,
        price: ticketType.price,
        quantity: ticketType.quantity,
        purchaseLimitPerPerson: ticketType.purchaseLimitPerPerson,
        isActive: ticketType.isActive,
        // quantitySold intentionally omitted — defaults to 0, this is a
        // brand-new, unsold batch of tickets.
      }))
    )

    // Mirrors syncEventMinPrice in ticketType.controller.ts — insertMany
    // bypasses that controller entirely, so Event.minPrice needs the same
    // recompute done here instead of drifting from what was just inserted.
    // TicketType.price is stored in Dollars (TICKET_TYPE_CURRENCY) but
    // Event.minPrice is a Naira ledger field (EVENT_LEDGER_CURRENCY) — see
    // lib/viewerCurrency.ts — so this has to convert, not copy directly.
    const cheapest = await TicketType.findOne({ event: duplicate._id, isActive: true }).sort({ price: 1 }).select('price').lean()
    if (cheapest) {
      const rate = await getDisplayRate(TICKET_TYPE_CURRENCY, EVENT_LEDGER_CURRENCY)
      duplicate.minPrice = applyRateToNaira(cheapest.price, rate)
    } else {
      duplicate.minPrice = 0
    }
    await duplicate.save()
  }

  return sendTsRestSuccess(res, 201, {
    success: true,
    message: 'Event duplicated as a new draft',
    body: duplicate.toObject(),
  })
})

export const listMyEvents = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)
  const filter = { organizer: req.session.userId }

  const [events, total, viewerCurrency] = await Promise.all([
    Event.find(filter).populate('category', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Event.countDocuments(filter),
    resolveViewerCurrency(req),
  ])

  // minPrice/revenueTotal are EVENT_LEDGER_CURRENCY (Naira) — display-only
  // conversion to the organizer's chosen currency, same pattern as every
  // other money endpoint. Was previously never currency-aware at all, so
  // the Events table's REVENUE column stayed static Naira regardless of
  // the organizer's currency preference.
  const ledgerRate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)
  const convertedEvents = events.map(e => ({
    ...e,
    minPrice: typeof e.minPrice === 'number' ? applyRate(e.minPrice, ledgerRate) : e.minPrice,
    revenueTotal: typeof e.revenueTotal === 'number' ? applyRate(e.revenueTotal, ledgerRate) : e.revenueTotal,
  }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Your events fetched',
    body: { events: convertedEvents, currency: viewerCurrency, meta: buildPaginationMeta(page, limit, total) },
  })
})

// Public — surfaces admin-approved events, including ones that have since
// been postponed (still live/on-sale, just with a new date — see
// postponeEvent below). Only cancelled/rejected/draft events are excluded.
export const listPublicEvents = tryCatchWrapper(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query)

  const filter: Record<string, any> = {
    status: { $in: ['approved', 'postponed'] },
    // Only still-live events belong on the public listing — an approved
    // event's status never flips on its own once its date has passed (no
    // cron marks it "ended"), so without this an event from months ago
    // would keep showing here forever. Matches the same startDate-only
    // "upcoming" simplification already used for Explore's "When" filter
    // below (see getDateRangeForWhen's own comment in lib/utils.ts) —
    // overwritten by the "when" filter's own startDate range further
    // down when one is given, which already implies this.
    startDate: { $gte: new Date() },
  }

  // Category — accepts a single id or a comma-separated list, e.g. ?category=a,b,c
  if (req.query.category && typeof req.query.category === 'string') {
    const categoryIds = req.query.category.split(',').map(id => id.trim()).filter(isValidObjectId)
    if (categoryIds.length === 1) filter.category = categoryIds[0]
    else if (categoryIds.length > 1) filter.category = { $in: categoryIds }
  }

  // Despite the param name (`city`), this always carries a Nigerian STATE
  // value — it's fed by Explore's state dropdown and the home page's
  // geolocation-detected state (see STATES/useViewerCity on the frontend),
  // never free-text city search. It used to be matched against
  // venue.city, which is the organizer's free-text city ("Ikeja", "Lekki",
  // "Onipanu"...) — so a "Lagos" filter would miss most real Lagos events
  // (their city field says "Ikeja", not "Lagos") while incorrectly
  // matching any event in a different state whose city happened to
  // contain the word "Lagos". venue.state is what organizers actually
  // pick from a state dropdown at event creation (see LocationForm on the
  // frontend) — the correct field to match a state filter against. Falls
  // back to the old venue.city match only for the rare event that somehow
  // has no venue.state captured at all, so nothing that used to show up
  // silently disappears.
  if (req.query.city && typeof req.query.city === 'string') {
    const stateRegex = new RegExp(escapeRegExp(req.query.city), 'i')
    filter.$or = [
      { 'venue.state': stateRegex },
      { 'venue.state': { $exists: false }, 'venue.city': stateRegex },
    ]
  }
  if (req.query.type === 'free' || req.query.type === 'paid') filter.type = req.query.type

  // "When" — Today / This weekend / This week / This month
  if (
    req.query.when === 'today' ||
    req.query.when === 'this-weekend' ||
    req.query.when === 'this-week' ||
    req.query.when === 'this-month'
  ) {
    const { from, to } = getDateRangeForWhen(req.query.when)
    filter.startDate = { $gte: from, $lte: to }
  }

  // Price — filters on the denormalized Event.minPrice (see models/event.ts)
  const minPrice = Number(req.query.minPrice)
  const maxPrice = Number(req.query.maxPrice)
  if (!Number.isNaN(minPrice) || !Number.isNaN(maxPrice)) {
    filter.minPrice = {}
    if (!Number.isNaN(minPrice)) filter.minPrice.$gte = minPrice
    if (!Number.isNaN(maxPrice)) filter.minPrice.$lte = maxPrice
  }

  const searchQuery = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null
  // The live search-suggestions dropdown (fetchEventSuggestions,
  // events-api.ts) hits this same endpoint with mode=prefix. $text below
  // is a stemmed, whole-word match — great for the "hit search"/Explore
  // results page, but it means nothing shows in the typeahead dropdown
  // until a full word has been typed, which read as broken (typing "bo"
  // showed nothing until "Bolt" was typed out completely). Prefix mode
  // instead does a plain case-insensitive substring match on the title,
  // so results appear as soon as a recognizable fragment is typed.
  const prefixSearch = req.query.mode === 'prefix'
  if (searchQuery) {
    if (prefixSearch) {
      filter.title = new RegExp(escapeRegExp(searchQuery), 'i')
    } else {
      filter.$text = { $search: searchQuery }
    }
  }

  const projection = searchQuery && !prefixSearch ? { score: { $meta: 'textScore' } } : undefined

  // A search term always takes priority for ordering. Otherwise, `sort` picks
  // the order; default ("trending") is featured-first then soonest.
  let sort: Record<string, any> = { isPromoted: -1, startDate: 1 }
  if (searchQuery && !prefixSearch) {
    sort = { score: { $meta: 'textScore' } }
  } else if (req.query.sort === 'date') {
    sort = { startDate: 1 }
  } else if (req.query.sort === 'price-asc') {
    sort = { minPrice: 1 }
  } else if (req.query.sort === 'price-desc') {
    sort = { minPrice: -1 }
  }

  const [events, total, viewerCurrency] = await Promise.all([
    Event.find(filter, projection)
      .sort(sort as any)
      .skip(skip)
      .limit(limit)
      .populate('category', 'name slug')
      .lean(),
    Event.countDocuments(filter),
    resolveViewerCurrency(req),
  ])

  // Display-only conversion — Event.minPrice stays a Naira ledger field in
  // the database (EVENT_LEDGER_CURRENCY); this just reshapes what's sent
  // back for this particular viewer. See lib/viewerCurrency.ts.
  const rate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)
  const convertedEvents = events.map(event => ({
    ...event,
    minPrice: typeof event.minPrice === 'number' ? applyRate(event.minPrice, rate) : event.minPrice,
  }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Events fetched',
    body: { events: convertedEvents, currency: viewerCurrency, meta: buildPaginationMeta(page, limit, total) },
  })
})

const PLACEMENT_PACKAGES: Record<string, string[]> = {
  // homepage-hero buys hero + featured + explore (spotlight) placement, so
  // it's eligible for all three slots below — see config/promotionPackages.ts
  // for the actual package definitions.
  hero: ['homepage-hero'],
  featured: ['featured', 'homepage-hero'],
  spotlight: ['spotlight', 'homepage-hero'],
}

/**
 * Powers the homepage Hero carousel, the homepage "Featured This Week"
 * section, and the spotlight card at the top of Explore. Returns ONLY
 * events actively promoted (approved + isPromoted) in a package that buys
 * the requested placement — never backfilled with unpromoted events, so a
 * placement with nothing currently promoted just comes back empty and the
 * section hides itself client-side rather than showing events that weren't
 * paid to be there.
 *
 * Deliberately a separate endpoint from listPublicEvents/Explore — that
 * one shows every approved event with no filtering (promotion only
 * affects its sort order there), which is a different contract than "give
 * me only what's actually promoted for this placement."
 */
export const getSpotlightEvents = tryCatchWrapper(async (req: Request, res: Response) => {
  const placement = ['hero', 'featured', 'spotlight'].includes(req.query.placement as string)
    ? (req.query.placement as string)
    : 'featured'
  const limit = Math.min(Number(req.query.limit) || 8, 20)

  const [events, viewerCurrency] = await Promise.all([
    Event.find({
      status: 'approved',
      isPromoted: true,
      'promotion.package': { $in: PLACEMENT_PACKAGES[placement] },
      // Same "still live" reasoning as listPublicEvents just above — a
      // promotion doesn't expire an event's own visibility, so without
      // this a paid placement can keep spotlighting an event that already
      // happened.
      startDate: { $gte: new Date() },
    })
      .sort({ 'promotion.startsAt': -1 })
      .limit(limit)
      .populate('category', 'name slug')
      .lean(),
    resolveViewerCurrency(req),
  ])

  // Display-only conversion — see the matching comment in listPublicEvents.
  const rate = await getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency)
  const convertedEvents = events.map(event => ({
    ...event,
    minPrice: typeof event.minPrice === 'number' ? applyRate(event.minPrice, rate) : event.minPrice,
  }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Spotlight events fetched',
    body: { events: convertedEvents, currency: viewerCurrency },
  })
})

export const getEventDashboard = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const event = await Event.findOne({ _id: id, organizer: req.session.userId }).populate('category', 'name').lean()
  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  const [ticketTypes, checkedInCount, recentAttendees, viewerCurrency] = await Promise.all([
    event.type === 'paid'
      ? TicketType.find({ event: event._id }).select('name price quantity quantitySold purchaseLimitPerPerson isActive').lean()
      : Promise.resolve([]),
    Ticket.countDocuments({ event: event._id, status: 'checked_in' }),
    Ticket.find({ event: event._id })
      .select('attendeeName code ticketId type status ticketType')
      .populate('ticketType', 'name')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    resolveViewerCurrency(req),
  ])

  // Display-only conversion for the organizer's own currencyPreference —
  // ticket type prices are Dollar-denominated (TICKET_TYPE_CURRENCY),
  // revenue/payout figures are Naira ledger amounts (EVENT_LEDGER_CURRENCY).
  // What actually gets paid out is always Naira regardless of what's shown
  // here — see the payout.amountDue comment below.
  const [ticketTypeRate, ledgerRate] = await Promise.all([
    getDisplayRate(TICKET_TYPE_CURRENCY, viewerCurrency),
    getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency),
  ])
  const convertedTicketTypes = ticketTypes.map(tt => ({
    ...tt,
    price: applyTicketTypeRate(tt.price, ticketTypeRate, viewerCurrency),
  }))
  const convertedRevenueTotal = applyRate(event.revenueTotal, ledgerRate)

  const body = {
    event: {
      _id: event._id,
      title: event.title,
      slug: event.slug,
      description: event.description,
      status: event.status,
      type: event.type,
      category: (event.category as any)?.name,
      coverImage: event.coverImage,
      startDate: event.startDate,
      isOnline: event.isOnline,
      venue: event.venue,
      lineup: event.lineup,
      isPromoted: event.isPromoted,
      promotionStatus: event.promotion?.status,
    },
    reservationsCount: event.reservationsCount,
    capacity: event.capacity ?? null,
    capacityRemaining: event.capacity ? Math.max(event.capacity - event.reservationsCount, 0) : null,
    ticketsSoldCount: event.ticketsSoldCount,
    revenueTotal: convertedRevenueTotal,
    currency: viewerCurrency,
    checkedInCount,
    recentAttendees: recentAttendees.map(t => ({
      _id: t._id,
      attendeeName: t.attendeeName,
      code: t.code,
      // Was missing entirely — the frontend's shortenTicketRef(a.ticketId)
      // unconditionally calls .split('-') on this, so its absence threw a
      // TypeError deep inside fetchEventDashboard on every event that had
      // at least one attendee. That error had nothing to do with the event
      // itself, but the page had no way to tell the difference and showed
      // "Event Not Found" for what was actually a live, fully valid event.
      ticketId: t.ticketId,
      status: t.status,
      ticketTypeName: t.type === 'free' ? 'RSVP' : ((t.ticketType as any)?.name ?? 'General'),
    })),
    ticketTypes: convertedTicketTypes.map(tt => ({
      ...tt,
      quantityRemaining: Math.max(tt.quantity - tt.quantitySold, 0),
    })),
    payout: {
      // Funds are held until a few days after the event — see PAYOUT_DELAY_DAYS in ticket.service.ts.
      // Shown here converted to the organizer's viewer currency like
      // everything else on this dashboard, but the ACTUAL payout to their
      // bank account is always in Naira (EVENT_LEDGER_CURRENCY) — this
      // figure is a display convenience, not what lands in their account.
      amountDue: convertedRevenueTotal,
    },
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Dashboard fetched',
    body,
  })
})

/**
 * Fetches the raw, full-fidelity event document (every field, no computed
 * stats) — used by the create/edit wizard to resume a draft. Deliberately
 * separate from getEventDashboard above: that endpoint returns a
 * stats-shaped view for the event-detail page, not a form-fillable one.
 */
export const getMyEventById = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const event = await Event.findOne({ _id: id, organizer: req.session.userId }).lean()
  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event fetched',
    body: event,
  })
})

/**
 * Cancels a live event. Paid tickets are refunded (one Paystack refund per
 * order) and all tickets invalidated. Free reservations are simply invalidated.
 */
export const cancelEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { reason } = req.body
  const isAdmin = req.session.role === 'admin'

  const event = await Event.findOne(isAdmin ? { _id: id } : { _id: id, organizer: req.session.userId })
  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }
  if (event.status !== 'approved' && event.status !== 'postponed') {
    return sendTsRestError(res, 400, 'Only a live (approved or postponed) event can be cancelled')
  }

  event.status = 'cancelled'
  event.cancelledAt = new Date()
  event.cancellationReason = reason
  await event.save()

  // Snapshot attendees BEFORE the status-flip loops below run — the
  // notice goes out to everyone currently holding a live ticket,
  // regardless of what their ticket's status becomes as a result of this
  // same cancellation.
   const affectedTickets = await Ticket.find({ event: event._id, status: { $in: ['valid', 'checked_in'] } })
    .select('attendeeName attendeeEmail attendee')
    .lean()
  const uniqueAttendees = Array.from(new Map(affectedTickets.map(t => [t.attendeeEmail, t])).values())

  const eventDateLabel = event.startDate ? formatEventDateLabel(event.startDate) : 'the scheduled date'
  Promise.all(
    uniqueAttendees.map(attendee =>
      EmailService.sendEventCancelledEmail(
        { fullname: attendee.attendeeName, email: attendee.attendeeEmail },
        event.title,
        eventDateLabel,
        reason,
        event.type === 'paid'
      )
    )
  ).catch(error => logger.error({ err: error }, `Cancellation emails failed for event ${event._id}`))

   const registeredAttendeeIds = Array.from(
    new Set(affectedTickets.filter(t => t.attendee).map(t => String(t.attendee)))
   )
    Promise.all(
    registeredAttendeeIds.map(attendeeId =>
      NotificationService.create({
        recipient: attendeeId,
        type: 'event_cancelled',
        title: 'Event cancelled',
        message: `"${event.title}" has been cancelled.${event.type === 'paid' ? ' A refund is being processed.' : ''}`,
        link: '/tickets',
        relatedEvent: event._id,
      })
    )
  ).catch(error => logger.error({ err: error }, `Cancellation notifications failed for event ${event._id}`))

  if (event.type === 'paid') {
    const paidOrders = await Order.find({ event: event._id, status: 'paid' })
    for (const order of paidOrders) {
      try {
        await PaystackService.refundTransaction({
          transactionReference: order.paystackReference,
          reason: 'Event cancelled by organizer',
        })
        order.status = 'refunded'
        order.refundedAt = new Date()
        order.refundAmount = order.total
        await order.save()
        await Ticket.updateMany({ order: order._id, status: { $in: ['valid', 'checked_in'] } }, { status: 'refunded' })

        const buyer = order.buyer ? await User.findById(order.buyer).select('fullname email').lean() : null
        const recipient = buyer ?? (order.guestEmail ? { fullname: order.guestName, email: order.guestEmail } : null)
        if (recipient) {
          EmailService.sendRefundProcessedEmail(recipient, event.title, `₦${order.total.toLocaleString('en-NG')}`).catch(error =>
            logger.error({ err: error }, `Refund-processed email failed for order ${order._id}`)
          )
        }
      } catch (error: any) {
        // Logged inside PaystackService — leave this order for manual admin follow-up.
      }
    }
  } else {
    await Ticket.updateMany({ event: event._id, status: 'valid' }, { status: 'cancelled' })
  }

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event cancelled. Paid attendees are being refunded',
    body: event.toObject(),
  })
})

/**
 * Postpones a live event to a new date. Existing tickets stay valid; attendees
 * who can't make the new date use the normal refund-request flow.
 */
export const postponeEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { newStartDate, reason } = req.body
  const isAdmin = req.session.role === 'admin'

  if (!newStartDate) {
    return sendTsRestError(res, 400, 'newStartDate is required')
  }

  const event = await Event.findOne(isAdmin ? { _id: id } : { _id: id, organizer: req.session.userId })
  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }
  if (event.status !== 'approved') {
    return sendTsRestError(res, 400, 'Only a live approved event can be postponed')
  }

  const oldDateLabel = event.startDate ? formatEventDateLabel(event.startDate) : 'the original date'

  event.status = 'postponed'
  // The new date IS the event's date now — everything else in the app
  // (event cards, sorting, the public event page, "is this event still
  // upcoming" checks) reads startDate, not postponedTo. postponedTo stays
  // set too, purely as a record that this event was postponed at all.
  const previousStartDate = event.startDate
  event.postponedTo = new Date(newStartDate)
  event.startDate = event.postponedTo
  // Shift endDate by the same amount so the event keeps its original
  // duration instead of ending before its (now later) start.
  if (event.endDate && previousStartDate) {
    event.endDate = new Date(event.endDate.getTime() + (event.startDate.getTime() - previousStartDate.getTime()))
  }
  event.postponementReason = reason
  await event.save()

  const affectedTickets = await Ticket.find({ event: event._id, status: { $in: ['valid', 'checked_in'] } })
    .select('attendeeName attendeeEmail attendee')
    .lean()
  const uniqueAttendees = Array.from(new Map(affectedTickets.map(t => [t.attendeeEmail, t])).values())
  const newDateLabel = formatEventDateLabel(event.startDate)

  Promise.all(
    uniqueAttendees.map(attendee =>
      EmailService.sendEventPostponedEmail(
        { fullname: attendee.attendeeName, email: attendee.attendeeEmail },
        event.title,
        oldDateLabel,
        newDateLabel,
        reason
      )
    )
  ).catch(error => logger.error({ err: error }, `Postponement emails failed for event ${event._id}`))

  const registeredAttendeeIds = Array.from(
    new Set(affectedTickets.filter(t => t.attendee).map(t => String(t.attendee)))
  )
  Promise.all(
    registeredAttendeeIds.map(attendeeId =>
      NotificationService.create({
        recipient: attendeeId,
        type: 'event_postponed',
        title: 'Event postponed',
        message: `"${event.title}" has been moved to ${newDateLabel}.`,
        link: '/tickets',
        relatedEvent: event._id,
      })
    )
  ).catch(error => logger.error({ err: error }, `Postponement notifications failed for event ${event._id}`))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event postponed. Existing tickets remain valid',
    body: event.toObject(),
  })
})

export const getEventBySlug = tryCatchWrapper(async (req: Request, res: Response) => {
  const { slug } = req.params

  const event = await Event.findOne({ slug, status: { $in: ['approved', 'postponed'] } })
    .populate('category', 'name slug')
    .populate('organizer', 'fullname avatarUrl organizerProfile.businessName organizerProfile.approvalStatus')
    .lean()

  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  const [ticketTypes, viewerCurrency] = await Promise.all([
    event.type === 'paid' ? TicketType.find({ event: event._id, isActive: true }).lean() : Promise.resolve([]),
    resolveViewerCurrency(req),
  ])

  // Display-only conversion — this is the actual ticket-buying page, so it
  // matters that both the headline price (event.minPrice, a Naira ledger
  // field) and each ticket type's price (Dollar-denominated,
  // TICKET_TYPE_CURRENCY) show correctly in the viewer's chosen currency.
  // See lib/viewerCurrency.ts.
  const [ledgerRate, ticketTypeRate] = await Promise.all([
    getDisplayRate(EVENT_LEDGER_CURRENCY, viewerCurrency),
    getDisplayRate(TICKET_TYPE_CURRENCY, viewerCurrency),
  ])
  const convertedEvent = {
    ...event,
    minPrice: typeof event.minPrice === 'number' ? applyRate(event.minPrice, ledgerRate) : event.minPrice,
  }
  const convertedTicketTypes = ticketTypes.map(tt => ({
    ...tt,
    price: applyTicketTypeRate(tt.price, ticketTypeRate, viewerCurrency),
  }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Event fetched',
    body: { ...convertedEvent, ticketTypes: convertedTicketTypes, currency: viewerCurrency },
  })
})

/**
 * Attendee-facing "Report" action from the public event page — lets
 * anyone logged in report either the event itself or its organizer.
 * Filing a report immediately flags the target (Event.flagged/flagReason,
 * or the organizer's User.organizerProfile.flagged/flagReason) — the same
 * flag an admin can set by hand via flagEvent/flagOrganizer — so it shows
 * up right away in the admin's flagged queue. An admin then opens the
 * flag-detail page, reads the report's reason, and decides for themselves
 * whether to dismiss it (dismissEventFlag/dismissOrganizerFlag, which
 * clears the reports AND the flag) or act on it (removeEvent, suspendUser,
 * etc). See models/report.ts for the full reasoning.
 */
export const reportEvent = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { targetType, reason, category,
    evidence,
    additionalInformation, } = req.body as {
      targetType: 'event' | 'organizer';
      reason: string
      category: string
      evidence?: { url: string }[]
      additionalInformation?: string
    }

  const event = await Event.findById(id).select('title organizer flagged')
  if (!event) {
    return sendTsRestError(res, 404, 'Event not found')
  }

  const reporter = await User.findById(req.session.userId).select('fullname').lean()
  if (!reporter) {
    return sendTsRestError(res, 401, 'Please log in to report this')
  }
    await Report.create({
    targetType,
    event: event._id,
    organizer: targetType === 'organizer' ? event.organizer : undefined,
    reportedBy: reporter._id,
    reporterName: reporter.fullname,
    reason,
    category,
    evidence,
    additionalInformation,
  })

  // Flag the target right away — same fields flagEvent/flagOrganizer set
  // by hand, so it lands in the admin's flagged queue immediately instead
  // of waiting on a separate admin decision. See the JSDoc above.
  if (targetType === 'event') {
    event.flagged = true
    event.flagReason = reason
    await event.save()
  } else if (event.organizer) {
    await User.findOneAndUpdate(
      { _id: event.organizer, role: 'organizer' },
      { 'organizerProfile.flagged': true, 'organizerProfile.flagReason': reason }
    )
  }

  NotificationService.notifyAdmins({
    type: 'report_submitted',
    title: targetType === 'event' ? 'Event reported' : 'Organizer reported',
    message: `${reporter.fullname} reported "${event.title || 'an event'}"${targetType === 'organizer' ? "'s organizer" : ''
      }: ${reason}`,
    link: '/admin/reports',
    relatedEvent: event._id,
  }).catch(error => logger.error({ err: error }, `Report notification failed for event ${event._id}`))

  return sendTsRestSuccess(res, 201, {
    success: true,
    message: "Thanks — our team will take a look",
    body: { received: true },
  })
})

export const getReports = tryCatchWrapper(async (req: Request, res: Response) => {
  const reports = await Report.find()
    .sort({ createdAt: -1 })
    // Only pull the fields the admin UI actually displays (event title,
    // organizer name/email) — avoid dragging full Event/User docs over
    // the wire for a list endpoint.
    .populate('event', 'title')
    .populate('organizer', 'fullname email')
    .lean()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Reports fetched successfully',
    body: reports,
  })
})
