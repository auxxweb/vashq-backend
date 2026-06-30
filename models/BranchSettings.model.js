import mongoose from 'mongoose';

/** Per-branch operational settings (WhatsApp, booking, capacity, payments). */
const branchSettingsSchema = new mongoose.Schema({
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    unique: true
  },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  timezone: { type: String, default: 'UTC' },
  capacity: { type: Number, default: 5, min: 1 },
  autoSendWhatsApp: { type: Boolean, default: true },
  shopWhatsappNumber: { type: String, trim: true },
  googleReviewLink: { type: String, trim: true },
  whatsappTemplates: {
    received: { type: String, trim: true },
    workStarted: { type: String, trim: true },
    inProgress: { type: String, trim: true },
    washing: { type: String, trim: true },
    drying: { type: String, trim: true },
    completed: { type: String, trim: true },
    delivered: { type: String, trim: true },
    invoiceShare: { type: String, trim: true },
    invoicePackage: { type: String, trim: true },
    googleReview: { type: String, trim: true },
    bookingConfirmed: { type: String, trim: true },
    bookingCancelled: { type: String, trim: true },
    bookingRejected: { type: String, trim: true }
  },
  upiId: { type: String, trim: true },
  qrCodeImage: { type: String, trim: true },
  paymentMobileNumber: { type: String, trim: true },
  gstNumber: { type: String, trim: true },
  taxPercentage: { type: Number, min: 0, max: 100 },
  onlineBookingEnabled: { type: Boolean, default: true },
  bookingAllowedDays: [{ type: Number, min: 0, max: 6 }],
  bookingAdvanceDays: { type: Number, min: 1, max: 365, default: 30 }
}, {
  timestamps: true
});

export default mongoose.model('BranchSettings', branchSettingsSchema);
