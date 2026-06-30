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
  },
  /** Annual fee per additional branch (INR). First branch is included with shop plan. */
  branchAnnualFee: {
    type: Number,
    default: 2000,
    min: 0
  },
  branchValidityDays: {
    type: Number,
    default: 365,
    min: 1
  },
  maxBranchesPerBusiness: {
    type: Number,
    default: 10,
    min: 1
  },
  includedBranchesPerShop: {
    type: Number,
    default: 1,
    min: 1
  }
}, {
  timestamps: true
});

// Single document for platform-wide settings (do not create custom _id index)

export default mongoose.model('PlatformSettings', platformSettingsSchema);
