import mongoose, { Document, Schema } from 'mongoose'

// One evidence screenshot uploaded via POST /uploads/refund-evidence (see
// upload.controller.ts) — publicId is kept (even though the attendee-facing
// form only ever reads `.url`) so a rejected/processed request's images can
// be cleaned up from Cloudinary later, same as verification documents.
export interface IRefundEvidence {
  url: string
  publicId?: string
}

export interface IRefundRequest extends Document {
  _id: mongoose.Types.ObjectId
  ticket: mongoose.Types.ObjectId
  order: mongoose.Types.ObjectId
  event: mongoose.Types.ObjectId
  requestedBy?: mongoose.Types.ObjectId
  reason: string
  // The rest of these mirror the attendee-facing refund form (RefundsValues
  // in the frontend's lib/schema.ts) field-for-field — see requestRefund in
  // ticket.controller.ts, which now stores the form as submitted instead of
  // collapsing it into `reason` alone.
  description?: string
  requestedResolution?: string
  evidence: IRefundEvidence[]
  additionalInformation?: string
  amount: number
  status: 'pending' | 'approved' | 'rejected' | 'processed'
  rejectionReason?: string
  paystackRefundReference?: string
  processedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const RefundRequestSchema = new Schema<IRefundRequest>(
  {
    ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    event: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    // Absent for a guest's ticket — the linked `ticket` already snapshots
    // attendeeName/attendeeEmail, so there's nothing else worth duplicating
    // here for a guest requester.
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    requestedResolution: { type: String, trim: true },
    evidence: {
      type: [
        {
          url: { type: String, required: true },
          publicId: { type: String },
        },
      ],
      default: [],
    },
    additionalInformation: { type: String, trim: true },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'processed'],
      default: 'pending',
    },
    rejectionReason: { type: String, trim: true },
    paystackRefundReference: { type: String, trim: true },
    processedAt: { type: Date },
  },
  { timestamps: true }
)

RefundRequestSchema.index({ status: 1, createdAt: 1 })
RefundRequestSchema.index({ ticket: 1 })

const RefundRequest =
  mongoose.models.RefundRequest || mongoose.model<IRefundRequest>('RefundRequest', RefundRequestSchema, 'refund_requests')

export default RefundRequest
