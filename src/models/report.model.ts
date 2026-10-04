import mongoose, { Document, Schema } from 'mongoose'

// One row per report an attendee (or organizer) files against an event or
// its organizer, from the "Report" action on the public event page.
//
// Filing a report immediately flags its target — Event.flagged/flagReason
// for an event target, or User.organizerProfile.flagged/flagReason for an
// organizer target — the same fields an admin sets by hand via
// flagEvent/flagOrganizer (see admin.controller.ts). That's deliberate: the
// point is for a flagged item to show up right away in the admin's flagged
// queue. The Report row is what carries the actual reason; an admin opens
// the flag-detail page, reads the report(s), and decides whether the flag
// was warranted — dismissEventFlag/dismissOrganizerFlag both clear the
// reports AND the flag if not, while a genuinely bad actor gets handled
// with the existing removeEvent/suspendUser tools (flag stays set until an
// admin acts either way). Admins can also flag/unflag by hand at any time,
// completely independent of whether any report exists.
export interface IReport extends Document {
  _id: mongoose.Types.ObjectId
  targetType: 'event' | 'organizer'
  event: mongoose.Types.ObjectId
  organizer?: mongoose.Types.ObjectId
  reportedBy?: mongoose.Types.ObjectId
  reporterName: string
  reason: string
  // Free-text category picked by the reporter on the public report form
  // (e.g. "Misleading info", "Scam"). Not an enum since the report-form
  // categories can differ per targetType and evolve independently of this
  // model — validate the allowed set at the controller/form level instead.
  category: string
  evidence?: { url: string }[]
  additionalInformation?: string
  status: 'open' | 'dismissed' | 'actioned'
  createdAt: Date
  updatedAt: Date
}

const ReportSchema = new Schema<IReport>(
  {
    targetType: { type: String, enum: ['event', 'organizer'], required: true },
    // Always set, even for an organizer report — that's the event the
    // reporter was looking at when they filed it, so the admin flag-detail
    // page has something concrete to show regardless of which target type
    // this is.
    event: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    organizer: { type: Schema.Types.ObjectId, ref: 'User' },
    reportedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    // Denormalized at write time (not populated from `reportedBy` on read)
    // so the admin flag-detail page still shows who reported it even if
    // that account is later deleted.
    reporterName: { type: String, trim: true, required: true },
    reason: { type: String, trim: true, required: true },
    category: { type: String, trim: true, required: true },
    evidence: [{ url: { type: String, required: true } }],
    additionalInformation: { type: String, trim: true },
    status: { type: String, enum: ['open', 'dismissed', 'actioned'], default: 'open' },
  },
  { timestamps: true }
)

// Powers listFlags' aggregation (group open reports by target) and the
// flag-detail pages (all open reports for one event/organizer).
ReportSchema.index({ targetType: 1, event: 1, status: 1 })
ReportSchema.index({ targetType: 1, organizer: 1, status: 1 })

const Report = mongoose.models.Report || mongoose.model<IReport>('Report', ReportSchema, 'reports')

export default Report