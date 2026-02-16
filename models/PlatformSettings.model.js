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
  }
}, {
  timestamps: true
});

// Single document for platform-wide settings
platformSettingsSchema.index({ _id: 1 }, { unique: true });

export default mongoose.model('PlatformSettings', platformSettingsSchema);
