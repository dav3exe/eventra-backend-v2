import mongoose, { Document, Schema } from 'mongoose'

export interface IEventVenue {
  name: string
  address: string
  city: string
  state?: string
}

export interface IRefundPolicy {
  type: 'no-refunds' | 'refund-until-days-before'
  daysBefore?: number
}

export interface IEventLineupMember {
  _id: mongoose.Types.ObjectId
  name: string
  role?: string
  imageUrl?: string
}

export interface IEventPromotion {
  package: string
  status: 'pending' | 'approved' | 'rejected'
  paidAt?: Date
  paystackReference?: string
  startsAt?: Date
  endsAt?: Date
}

export interface IEvent extends Document {
  _id: mongoose.Types.ObjectId
  title?: string
  slug: string
  description?: string
  organizer: mongoose.Types.ObjectId
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'postponed' | 'cancelled' | 'removed' | 'suspended'
  rejectionReason?: string
  removedReason?: string
  suspendReason?: string
  category?: mongoose.Types.ObjectId
  type: 'free' | 'paid'
  coverImage?: string
  gallery?: string[]
  tags?: string[]
  agePolicy?: string
  // Physical venue — absent when isOnline is true.
  venue?: IEventVenue
  isOnline: boolean
  onlinePlatform?: string
  // Deliberately never exposed on the public event API response before
  // someone has RSVP'd/bought — see getEventBySlug's response shaping.
  onlineJoinLink?: string
  startDate?: Date
  endDate?: Date
  capacity?: number
  refundPolicy?: IRefundPolicy
  // Artists/speakers/influencers billed for the event — a selling point on
  // the public event page, not part of the venue/schedule fields above.
  lineup?: IEventLineupMember[]
  relatedEventSlugs?: string[]
  goodToKnow?: string[]
  flagged: boolean
  flagReason?: string
  reservationsCount: number
  ticketsSoldCount: number
  isPromoted: boolean
  promotion?: IEventPromotion
  publishedAt?: Date
  revenueTotal: number
  minPrice: number
  cancelledAt?: Date
  cancellationReason?: string
  postponedTo?: Date
  postponementReason?: string
  createdAt: Date
  updatedAt: Date
}

const EventVenueSchema = new Schema<IEventVenue>(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, trim: true },
  },
  { _id: false }
)

const RefundPolicySchema = new Schema<IRefundPolicy>(
  {
    type: { type: String, enum: ['no-refunds', 'refund-until-days-before'], required: true },
    daysBefore: { type: Number, min: 0 },
  },
  { _id: false }
)

const EventLineupMemberSchema = new Schema<IEventLineupMember>({
  name: { type: String, required: true, trim: true },
  role: { type: String, trim: true },
  imageUrl: { type: String, trim: true },
})

const EventPromotionSchema = new Schema<IEventPromotion>(
  {
    package: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    paidAt: { type: Date },
    paystackReference: { type: String },
    startsAt: { type: Date },
    endsAt: { type: Date },
  },
  { _id: false }
)

const EventSchema = new Schema<IEvent>(
  {
    title: {
      type: String,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: {
      type: String,
    },
    organizer: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['draft', 'pending_approval', 'approved', 'rejected', 'postponed', 'cancelled', 'removed', 'suspended'],
      default: 'draft',
    },
    rejectionReason: {
      type: String,
    },
    removedReason: {
      type: String,
    },
    suspendReason: {
      type: String,
    },
    category: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
    },
    type: {
      type: String,
      enum: ['free', 'paid'],
      required: true,
    },
    coverImage: {
      type: String,
      trim: true,
    },
    venue: {
      type: EventVenueSchema,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    onlinePlatform: {
      type: String,
      trim: true,
    },
    onlineJoinLink: {
      type: String,
      trim: true,
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
    capacity: {
      type: Number,
      min: 0,
    },
    refundPolicy: {
      type: RefundPolicySchema,
    },
    lineup: {
      type: [EventLineupMemberSchema],
      default: [],
    },
    relatedEventSlugs: {
      type: [String],
      default: [],
    },
    goodToKnow: {
      type: [String],
      default: [],
    },
    flagged: {
      type: Boolean,
      default: false,
    },
    flagReason: {
      type: String,
    },
    reservationsCount: {
      type: Number,
      default: 0,
    },
    ticketsSoldCount: {
      type: Number,
      default: 0,
    },
    isPromoted: {
      type: Boolean,
      default: false,
    },
    promotion: {
      type: EventPromotionSchema,
    },
    publishedAt: {
      type: Date,
    },
    revenueTotal: {
      type: Number,
      default: 0,
    },
    minPrice: {
      type: Number,
      default: 0,
    },
    cancelledAt: {
      type: Date,
    },
    cancellationReason: {
      type: String,
    },
    postponedTo: {
      type: Date,
    },
    postponementReason: {
      type: String,
    },
    tags: {
      type: [String],
      default: [],
    },
    agePolicy: {
      type: String,
    },
    gallery: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
)

// Indexes — support Explore/search, organizer dashboard, and featured placement
EventSchema.index({ organizer: 1, createdAt: -1 })
EventSchema.index({ status: 1, startDate: 1 })
EventSchema.index({ category: 1, startDate: 1 })
EventSchema.index({ 'venue.city': 1 })
// Supports the Explore/home "state" filter (listPublicEvents) now that it
// correctly matches against venue.state instead of venue.city — see that
// filter's comment in event.controller.ts.
EventSchema.index({ 'venue.state': 1 })
EventSchema.index({ isPromoted: -1, startDate: 1 })
EventSchema.index({ status: 1, minPrice: 1 })
EventSchema.index({ title: 'text', description: 'text', 'venue.name': 'text', 'venue.address': 'text', 'venue.city': 'text' })

const Event = mongoose.models.Event || mongoose.model<IEvent>('Event', EventSchema, 'events')

export default Event
