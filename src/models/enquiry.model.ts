import mongoose, { Schema, Document, Types } from "mongoose";

export interface IEnquiry extends Document {
  fullName: string;
  email: string;
  subject: string;
  message: string;
  status: "unread" | "read";
  readBy?: Types.ObjectId;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const enquirySchema = new Schema<IEnquiry>(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ["unread", "read"],
      default: "unread",
      index: true,
    },
    readBy: { type: Schema.Types.ObjectId, ref: "User" },
    readAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model<IEnquiry>("Enquiry", enquirySchema);