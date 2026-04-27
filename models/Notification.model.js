import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  // Business scope (admin notifications are business-wide)
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  // Optional owner userId for traceability (business owner only)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  type: {
    type: String,
    enum: [
      'PLAN_EXPIRY',
      'JOB_UPDATE',
      'SUPPORT_RESPONSE',
      'SYSTEM_ALERT',
      'PAYMENT_REMINDER',
      // Push + in-app business events
      'JOB_RECEIVED',
      'JOB_CLOSED',
      'PACKAGE_PURCHASED',
      'VISIT_TODAY',
      'PACKAGE_EXPIRY',
      'OVERDUE_VISIT',
      'SUBSCRIPTION_EXPIRY'
    ],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  link: {
    type: String
  },
  // Used to keep notifications unique per event (e.g. "job_received:booking:abc").
  // This prevents duplicate rows in /admin/notifications.
  refKey: {
    type: String,
    default: '',
    index: true
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Indexes
notificationSchema.index({ businessId: 1, createdAt: -1 });
notificationSchema.index({ isRead: 1 });
notificationSchema.index({ businessId: 1, refKey: 1 }, { unique: true, sparse: true });

export default mongoose.model('Notification', notificationSchema);
