import mongoose from 'mongoose';

const pushNotificationLogSchema = new mongoose.Schema({
  businessOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  type: { type: String, required: true, index: true },
  // For event notifications: bookingId/packageId/etc as string.
  // For daily summaries: use a stable key like "2026-04-27".
  refId: { type: String, default: null, index: true },
  sentAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

// Prevent duplicates per owner+type+refId (refId can be null; Mongo treats multiple nulls as duplicates in unique indexes)
// so we store refId as empty string when missing.
pushNotificationLogSchema.pre('validate', function (next) {
  if (this.refId == null) this.refId = '';
  next();
});

pushNotificationLogSchema.index({ businessOwnerId: 1, type: 1, refId: 1 }, { unique: true });

export default mongoose.model('PushNotificationLog', pushNotificationLogSchema);

