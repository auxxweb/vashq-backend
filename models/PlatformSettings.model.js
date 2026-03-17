import mongoose from 'mongoose';

const platformSettingsSchema = new mongoose.Schema({
  platformName: {
    type: String,
    default: 'Vashq',
    trim: true
  },
  supportEmail: {
    type: String,
    trim: true,
    lowercase: true
  },
  supportPhone: {
    type: String,
    trim: true
  },
  defaultCurrency: {
    type: String,
    default: 'USD'
  },
  defaultLanguage: {
    type: String,
    default: 'en'
  },
  // Phone dial code (E.164 prefix) used across the platform (e.g. +91)
  defaultPhoneDialCode: {
    type: String,
    default: '+1',
    trim: true
  },
  // ISO2 country code for phone validation/formatting (e.g. IN)
  defaultPhoneCountryIso2: {
    type: String,
    default: 'US',
    trim: true,
    uppercase: true
  }
}, {
  timestamps: true
});

// Single document for platform-wide settings (do not create custom _id index)

export default mongoose.model('PlatformSettings', platformSettingsSchema);
