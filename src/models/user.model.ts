import bcrypt from "bcryptjs";
import mongoose, { Document, Schema } from "mongoose";

export interface IOrganizerProfile {
  businessName?: string;
  category?: string;
  city?: string;
  contactPhone?: string;
  publicEmail?: string;
  bio?: string;
  bankName?: string;
  bankCode?: string;
  accountNumber?: string;
  accountName?: string;
  // Three distinct verification documents, uploaded during onboarding's
  // dedicated verification step — same Cloudinary url+publicId pattern as
  // avatarUrl/avatarPublicId above. Each *PublicId is server-only
  // bookkeeping (never needs to reach the client) — kept purely so a
  // re-upload can delete the old Cloudinary file instead of leaking it.
  cacCertificateUrl?: string;
  cacCertificatePublicId?: string;
  directorIdUrl?: string;
  directorIdPublicId?: string;
  proofOfAddressUrl?: string;
  proofOfAddressPublicId?: string;
  isPayoutReady: boolean;
  // 'draft' — onboarding wizard in progress, not yet submitted (not shown
  // to admins). 'pending' — submitted, awaiting admin review. Set by
  // submitOrganizerProfileForReview, not by every profile edit.
  approvalStatus: "draft" | "pending" | "approved" | "rejected";
  paystackRecipientCode?: string;
  agreedToTerms?: boolean;
  submittedAt?: Date;
  // Mirrors Event.flagged/flagReason (see models/event.ts) but scoped to
  // the organizer's account rather than one event — set either by an admin
  // directly (flagOrganizer/unflagOrganizer) or automatically the moment
  // someone reports this organizer (reportEvent in event.controller.ts).
  // Purely a review marker: it doesn't restrict the account on its own,
  // an admin still has to look into it and either dismiss the flag
  // (dismissOrganizerFlag) or act on it (suspendUser, etc).
  flagged?: boolean;
  flagReason?: string;
}

export interface INotificationPreferences {
  eventReminders: boolean;
  weeklyPicks: boolean;
  organizerUpdates: boolean;
}

export interface IAdminNotificationPreferences {
  approvals: boolean;
  refunds: boolean;
  reports: boolean;
  enquiries: boolean;
}

// Separate from INotificationPreferences above (which is the attendee-facing
// "My account" prefs) — these drive the toggles on the organizer dashboard's
// Settings page instead, and are meaningless for an attendee-only account.
export interface IOrganizerNotificationPreferences {
  newSalesRsvps: boolean;
  dailySalesSummary: boolean;
  payoutConfirmations: boolean;
  eventApprovals: boolean;
}

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  fullname: string;
  email: string;
  password?: string;
  googleId?: string;
  phone?: string;
  city?: string;
  avatarUrl?: string;
  avatarPublicId?: string;
  notificationPreferences: INotificationPreferences;
  organizerNotificationPreferences: IOrganizerNotificationPreferences;
  following: mongoose.Types.ObjectId[]
  role: "attendee" | "organizer" | "admin";
  adminRole?: "owner" | "admin" | "support";
  mustSetPassword?: boolean
  isVerified: boolean
  isSuspended: boolean
  isDeleted?: boolean
  deletedAt?: Date
  emailVerificationOTP?: string
  emailVerificationOTPExpiry?: Date
  passwordResetOTP?: string
  passwordResetOTPExpiry?: Date
  adminNotificationPreferences: IAdminNotificationPreferences;
  organizerProfile?: IOrganizerProfile
  currencyPreference?: 'Naira' | 'Dollar' | 'Cedis' | 'Pound'
  savedEvents: mongoose.Types.ObjectId[]
  createdAt: Date
  updatedAt: Date
  matchPassword: (candidate: string) => Promise<boolean>
}

const OrganizerProfileSchema = new Schema<IOrganizerProfile>(
  {
    businessName: { type: String, trim: true },
    category: { type: String, trim: true },
    city: { type: String, trim: true },
    contactPhone: { type: String, trim: true },
    publicEmail: { type: String, trim: true, lowercase: true },
    bio: { type: String, trim: true, maxlength: 280 },
    bankName: { type: String, trim: true },
    bankCode: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    accountName: { type: String, trim: true },
    cacCertificateUrl: { type: String, trim: true },
    cacCertificatePublicId: { type: String, trim: true, select: false },
    directorIdUrl: { type: String, trim: true },
    directorIdPublicId: { type: String, trim: true, select: false },
    proofOfAddressUrl: { type: String, trim: true },
    proofOfAddressPublicId: { type: String, trim: true, select: false },
    isPayoutReady: { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: ["draft", "pending", "approved", "rejected"],
      default: "draft",
    },
    paystackRecipientCode: { type: String, trim: true },
    agreedToTerms: { type: Boolean, default: false },
    submittedAt: { type: Date },
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, trim: true },
  },
  { _id: false },
);

const UserSchema = new Schema<IUser>(
  {
    fullname: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      // Google-created accounts never set a password — required is a
      // function so this only applies to accounts that signed up the
      // normal way. See matchPassword and googleAuth in auth.controller.ts
      // for the two places that read this and need to handle it being unset.
      required: function (this: IUser) {
        return !this.googleId;
      },
      select: false,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true, // most users won't have one — sparse means the unique index ignores documents missing this field entirely
    },
    phone: {
      type: String,
      required: function (this: IUser) {
        // Google sign-ups never collect a phone number, neither does the
        // organizer registration form, and neither does inviteAdmin
        // (admin.controller.ts) — an admin account is created by another
        // admin filling in fullname/email/tier, with no phone field in
        // that form at all. Only a manual attendee sign-up needs one.
        return (
          !this.googleId && this.role !== "organizer" && this.role !== "admin"
        );
      },
      trim: true,
    },
    city: {
      type: String,
      trim: true,
    },
    avatarUrl: {
      type: String,
    },
    avatarPublicId: {
      type: String,
      select: false, // internal Cloudinary bookkeeping, never needs to leave the server
    },
    notificationPreferences: {
      eventReminders: { type: Boolean, default: true },
      weeklyPicks: { type: Boolean, default: true },
      organizerUpdates: { type: Boolean, default: false },
    },
    // All default false — an organizer opts in per the Settings page,
    // rather than getting opted into ops emails by default.
    organizerNotificationPreferences: {
      newSalesRsvps: { type: Boolean, default: false },
      dailySalesSummary: { type: Boolean, default: false },
      payoutConfirmations: { type: Boolean, default: false },
      eventApprovals: { type: Boolean, default: false },
    },

    adminNotificationPreferences: {
      approvals: { type: Boolean, default: true },
      refunds: { type: Boolean, default: true },
      reports: { type: Boolean, default: true },
      enquiries: { type: Boolean, default: true },
    },
    role: {
      type: String,
      enum: ["attendee", "organizer", "admin"],
      default: "attendee",
    },
    adminRole: {
      type: String,
      enum: ["owner", "admin", "support"],
    },
    mustSetPassword: {
      type: Boolean,
      default: false,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    isSuspended: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
    },
    emailVerificationOTP: {
      type: String,
      select: false,
    },
    emailVerificationOTPExpiry: {
      type: Date,
      select: false,
    },
    passwordResetOTP: {
      type: String,
      select: false,
    },
    passwordResetOTPExpiry: {
      type: Date,
      select: false,
    },
    organizerProfile: {
      type: OrganizerProfileSchema,
      default: undefined,
    },

    following: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    // See the IUser interface comment above — display-only, never mutates
    // any stored price. Left unset (falls back to PlatformSettings.currency)
    // for every account that existed before this field was added.
    currencyPreference: {
      type: String,
      enum: ['Naira', 'Dollar', 'Cedis', 'Pound'],
    },
    savedEvents: [
      {
        type: Schema.Types.ObjectId,
        ref: "Event",
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Hash password before saving whenever it's new or modified
UserSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

UserSchema.methods.matchPassword = async function (
  candidate: string,
): Promise<boolean> {
  if (!this.password) return false; // Google-only account — see googleAuth in auth.controller.ts
  return bcrypt.compare(candidate, this.password);
};

// Indexes
UserSchema.index({ role: 1 });

const User =
  mongoose.models.User || mongoose.model<IUser>("User", UserSchema, "users");

export default User;
