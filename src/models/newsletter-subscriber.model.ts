import mongoose, { Document, Schema } from 'mongoose'

export interface INewsletterSubscriber extends Document {
  _id: mongoose.Types.ObjectId
  email: string
  subscribedAt: Date
}

const NewsletterSubscriberSchema = new Schema<INewsletterSubscriber>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    subscribedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
)

const NewsletterSubscriber =
  mongoose.models.NewsletterSubscriber ||
  mongoose.model<INewsletterSubscriber>('NewsletterSubscriber', NewsletterSubscriberSchema, 'newsletter_subscribers')

export default NewsletterSubscriber