import { Request, Response } from 'express'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import Event from '../models/event.model.js'
import TicketType from '../models/ticket-type.model.js'
import { isPastLiveEditCutoff, LIVE_EDITABLE_STATUSES, LIVE_EDIT_CUTOFF_DAYS } from './event.controller.js'
import {
  applyRate,
  applyRateToNaira,
  applyTicketTypeRate,
  type Currency,
  EVENT_LEDGER_CURRENCY,
  getDisplayRate,
  resolveViewerCurrency,
  TICKET_TYPE_CURRENCY,
} from '../services/currency/viewer-currency.js'

/**
 * Confirms the event exists, belongs to the caller, and is a paid event.
 * Ticket types only make sense on paid events (free events use Event.capacity).
 */
const getOwnedPaidEvent = async (eventId: string, organizerId: string) => {
  const event = await Event.findOne({ _id: eventId, organizer: organizerId })
  if (!event) return { event: null, error: 'Event not found' }
  if (event.type !== 'paid') return { event: null, error: 'Ticket types only apply to paid events' }
  return { event, error: null }
}

/**
 * Same cutoff as updateEvent (event.controller.ts) — ticket types are part
 * of "the event" from an editing standpoint, so a live event's ticket
 * lineup freezes on the same schedule as everything else about it. Draft/
 * pending/rejected events aren't live yet, so they're never gated here.
 */
const getLiveEditBlockedError = (event: InstanceType<typeof Event>): string | null => {
  if (!LIVE_EDITABLE_STATUSES.includes(event.status)) return null
  if (!isPastLiveEditCutoff(event.startDate)) return null
  return `This event starts in less than ${LIVE_EDIT_CUTOFF_DAYS} days — ticket types can no longer be changed`
}

/**
 * Recomputes Event.minPrice from the cheapest active ticket type. Call this
 * after any ticket type create/update — it's what keeps Explore's price
 * filter/sort accurate without joining to TicketType on every browse request.
 *
 * TicketType.price is stored in Dollars (TICKET_TYPE_CURRENCY) but
 * Event.minPrice is a Naira ledger field (EVENT_LEDGER_CURRENCY) — see
 * lib/viewerCurrency.ts — so this converts, it doesn't copy directly.
 * Snapped to the nearest ₦1,000 (applyRateToNaira) rather than the
 * nearest kobo — a live Dollar→Naira rate almost never lands on the
 * clean round figure the ticket was actually priced at otherwise.
 */
const syncEventMinPrice = async (eventId: string) => {
  const cheapest = await TicketType.findOne({ event: eventId, isActive: true }).sort({ price: 1 }).select('price').lean()
  const rate = await getDisplayRate(TICKET_TYPE_CURRENCY, EVENT_LEDGER_CURRENCY)
  await Event.updateOne({ _id: eventId }, { $set: { minPrice: cheapest ? applyRateToNaira(cheapest.price, rate) : 0 } })
}

/**
 * Converts a `price` typed in `currency` (whatever the organizer's form
 * sent, defaulting to Naira) into Dollars — the currency TicketType.price
 * is always stored in. Called once, at the moment a ticket type is
 * created/edited; nothing about the stored price ever changes afterward
 * except through this same conversion on a later edit.
 */
const convertInputPriceToStorage = async (price: number, currency: Currency | undefined): Promise<number> => {
  const rate = await getDisplayRate(currency ?? 'Naira', TICKET_TYPE_CURRENCY)
  return applyRate(price, rate)
}

export const createTicketType = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId } = req.params
  const { event, error } = await getOwnedPaidEvent(eventId as string, req.session.userId!)
  if (!event) {
    return sendTsRestError(res, 404, error!)
  }
  const blockedError = getLiveEditBlockedError(event)
  if (blockedError) {
    return sendTsRestError(res, 400, blockedError)
  }

  const { currency, price, ...rest } = req.body as { currency?: Currency; price: number; [key: string]: unknown }
  const storedPrice = await convertInputPriceToStorage(price, currency)

  const ticketType = await TicketType.create({ ...rest, price: storedPrice, event: event._id })
  await syncEventMinPrice(event._id.toString())

  // Convert back to the currency the organizer is actually looking at
  // right now, so what they see right after saving matches what they
  // typed (rather than showing them the internal Dollar figure).
  const viewerCurrency = await resolveViewerCurrency(req)
  const displayRate = await getDisplayRate(TICKET_TYPE_CURRENCY, viewerCurrency)

  return sendTsRestSuccess(res, 201, {
    success: true,
    message: 'Ticket type created',
    body: {
      ...ticketType.toObject(),
      price: applyTicketTypeRate(storedPrice, displayRate, viewerCurrency),
      currency: viewerCurrency,
    },
  })
})

export const listTicketTypesForOrganizer = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId } = req.params
  const { event, error } = await getOwnedPaidEvent(eventId as string, req.session.userId!)
  if (!event) {
    return sendTsRestError(res, 404, error!)
  }

  const [ticketTypes, viewerCurrency] = await Promise.all([
    TicketType.find({ event: event._id }).sort({ createdAt: 1 }).lean(),
    resolveViewerCurrency(req),
  ])

  const rate = await getDisplayRate(TICKET_TYPE_CURRENCY, viewerCurrency)
  const convertedTicketTypes = ticketTypes.map(tt => ({ ...tt, price: applyTicketTypeRate(tt.price, rate, viewerCurrency) }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Ticket types fetched',
    body: { ticketTypes: convertedTicketTypes, currency: viewerCurrency },
  })
})

export const updateTicketType = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId, ticketTypeId } = req.params
  const { event, error } = await getOwnedPaidEvent(eventId as string, req.session.userId!)
  if (!event) {
    return sendTsRestError(res, 404, error!)
  }
  const blockedError = getLiveEditBlockedError(event)
  if (blockedError) {
    return sendTsRestError(res, 400, blockedError)
  }

  const ticketType = await TicketType.findOne({ _id: ticketTypeId, event: event._id })
  if (!ticketType) {
    return sendTsRestError(res, 404, 'Ticket type not found')
  }

  if (typeof req.body.quantity === 'number' && req.body.quantity < ticketType.quantitySold) {
    return sendTsRestError(res, 400, `Quantity can't be lower than the ${ticketType.quantitySold} already sold`)
  }

  const { currency, price, ...rest } = req.body as { currency?: Currency; price?: number; [key: string]: unknown }
  Object.assign(ticketType, rest)
  if (typeof price === 'number') {
    ticketType.price = await convertInputPriceToStorage(price, currency)
  }
  await ticketType.save()
  await syncEventMinPrice(event._id.toString())

  const viewerCurrency = await resolveViewerCurrency(req)
  const displayRate = await getDisplayRate(TICKET_TYPE_CURRENCY, viewerCurrency)

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Ticket type updated',
    body: {
      ...ticketType.toObject(),
      price: applyTicketTypeRate(ticketType.price, displayRate, viewerCurrency),
      currency: viewerCurrency,
    },
  })
})

// Only while nothing's sold — a ticket type with real sales has tickets
// and order line items pointing at it, so removing it outright would
// orphan those records. Once anything's sold, deactivate it instead (see
// updateTicketType's isActive field) rather than delete.
export const deleteTicketType = tryCatchWrapper(async (req: Request, res: Response) => {
  const { eventId, ticketTypeId } = req.params
  const { event, error } = await getOwnedPaidEvent(eventId as string, req.session.userId!)
  if (!event) {
    return sendTsRestError(res, 404, error!)
  }
  const blockedError = getLiveEditBlockedError(event)
  if (blockedError) {
    return sendTsRestError(res, 400, blockedError)
  }

  const ticketType = await TicketType.findOne({ _id: ticketTypeId, event: event._id })
  if (!ticketType) {
    return sendTsRestError(res, 404, 'Ticket type not found')
  }
  if (ticketType.quantitySold > 0) {
    return sendTsRestError(res, 400, 'This ticket type already has sales — deactivate it instead of deleting it')
  }

  await ticketType.deleteOne()
  await syncEventMinPrice(event._id.toString())

  return sendTsRestSuccess<undefined>(res, 200, {
    success: true,
    message: 'Ticket type deleted',
  })
})
