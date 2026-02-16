import mongoose from 'mongoose';

const businessSettingsSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    unique: true
  },
  language: {
    type: String,
    default: 'en'
  },
  timezone: {
    type: String,
    default: 'UTC'
  },
  currency: {
    type: String,
    default: 'USD'
  },
  dateFormat: {
    type: String,
    default: 'YYYY-MM-DD'
  },
  numberFormat: {
    type: String,
    default: 'en-US'
  },
  theme: {
    type: String,
    enum: ['light', 'dark'],
    default: 'light'
  },
  workingHours: {
    start: { type: String, default: '09:00' },
    end: { type: String, default: '18:00' }
  },
  capacity: {
    type: Number,
    default: 5,
    min: 1
  },
  autoSendWhatsApp: {
    type: Boolean,
    default: true
  },
  notificationPreferences: {
    jobCreated: { type: Boolean, default: true },
    jobCompleted: { type: Boolean, default: true },
    jobDelivered: { type: Boolean, default: true },
    planExpiry: { type: Boolean, default: true }
  },
  shopWhatsappNumber: { type: String, trim: true },
  googleReviewLink: { type: String, trim: true },
  whatsappTemplates: {
    received: { type: String, trim: true },
    inProgress: { type: String, trim: true },
    washing: { type: String, trim: true },
    drying: { type: String, trim: true },
    completed: { type: String, trim: true },
    delivered: { type: String, trim: true }
  }
}, {
  timestamps: true
});

export default mongoose.model('BusinessSettings', businessSettingsSchema);
