import mongoose, { Document, Schema } from 'mongoose'

// A real Paystack chargeback — a customer disputed a charge with their
// bank/card issuer, separate from an in-app RefundRequest (which is the
// attendee asking Eventra directly). Populated entirely from Paystack's
// dispute webhooks (charge.dispute.create / charge.dispute.remind /
// charge.dispute.resolve) — see handleDisputeWebhook in
// payment.controller.ts. Never created any other way, so "open disputes"
// on the admin Overview page is always a real number, not a guess.
export interface IPaymentDispute extends Document {
  _id: mongoose.Types.ObjectId
  paystackDisputeId: string
  paystackReference: string
  order?: mongoose.Types.ObjectId
  event?: mongoose.Types.ObjectId
  amount: number
  reason?: string
  status: 'pending' | 'resolved' | 'lost'
  raisedAt: Date
  resolvedAt?: Date
  // Tracks OUR side of a response to this dispute — separate from
  // `status`, which only flips to 'resolved'/'lost' once Paystack's own
  // resolve webhook confirms the real outcome. The two can legitimately
  // disagree for a while (e.g. we've challenged it, but Paystack hasn't
  // ruled yet).
  merchantResponseStatus?: 'challenged' | 'accepted-loss'
  merchantResponseMessage?: string
  merchantRespondedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const PaymentDisputeSchema = new Schema<IPaymentDispute>(
  {
    paystackDisputeId: { type: String, required: true, unique: true },
    paystackReference: { type: String, required: true },
    // Both optional — a dispute webhook always carries a reference, but
    // resolving it to one of our own orders/events is best-effort (the
    // order may have aged out, or the reference format may not match what
    // we expect from an older transaction). Never block recording a real
    // dispute just because it can't be cross-referenced.
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    event: { type: Schema.Types.ObjectId, ref: 'Event' },
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, trim: true },
    status: {
      type: String,
      enum: ['pending', 'resolved', 'lost'],
      default: 'pending',
    },
    raisedAt: { type: Date, required: true },
    resolvedAt: { type: Date },
    merchantResponseStatus: {
      type: String,
      enum: ['challenged', 'accepted-loss'],
    },
    merchantResponseMessage: { type: String, trim: true },
    merchantRespondedAt: { type: Date },
  },
  { timestamps: true }
)

PaymentDisputeSchema.index({ status: 1, createdAt: -1 })

const PaymentDispute =
  mongoose.models.PaymentDispute ||
  mongoose.model<IPaymentDispute>('PaymentDispute', PaymentDisputeSchema, 'payment_disputes')

export default PaymentDispute
