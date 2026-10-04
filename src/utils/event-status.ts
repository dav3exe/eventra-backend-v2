import { IEvent } from '../models/event.model.js'

export type EventDisplayStatus =
  | 'draft'
  | 'pending_approval'
  | 'rejected'
  | 'cancelled'
  | 'postponed'
  | 'sold_out'
  | 'live'
  | 'past'

export function deriveEventDisplayStatus(
  event: Pick<
    IEvent,
    | 'status'
    | 'startDate'
    | 'endDate'
    | 'capacity'
    | 'ticketsSoldCount'
    | 'reservationsCount'
    | 'type'
  >
): EventDisplayStatus {
  if (event.status !== 'approved') {
    return event.status as EventDisplayStatus
  }

  const soldCount =
    event.type === 'free'
      ? event.reservationsCount
      : event.ticketsSoldCount

  if (event.capacity && soldCount >= event.capacity) {
    return 'sold_out'
  }

  const endsAt = event.endDate ?? event.startDate

  if (!endsAt) {
    return 'past'
  }

  if (endsAt.getTime() < Date.now()) {
    return 'past'
  }

  return 'live'
}