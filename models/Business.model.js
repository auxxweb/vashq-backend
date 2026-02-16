import mongoose from 'mongoose';

const businessSchema = new mongoose.Schema({
  businessName: {
    type: String,
    required: [true, 'Business name is required'],
    trim: true
  },
  ownerName: {
    type: String,
    required: [true, 'Owner name is required'],
    trim: true
  },
  phone: {
    type: String,
    required: [true, 'Phone is required']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true
  },
  whatsappNumber: {
    type: String,
    required: [true, 'WhatsApp number is required']
  },
  address: {
    type: String,
    required: [true, 'Address is required']
  },
  location: {
    type: String,
    trim: true
  },
  workingHoursStart: {
    type: String,
    required: true,
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format']
  },
  workingHoursEnd: {
    type: String,
    required: true,
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format']
  },
  carHandlingCapacity: {
    type: String,
    enum: ['SINGLE', 'MULTIPLE'],
    default: 'SINGLE'
  },
  maxConcurrentJobs: {
    type: Number,
    default: 1,
    min: 1
  },
  defaultCurrency: {
    type: String,
    default: 'USD'
  },
  defaultLanguage: {
    type: String,
    default: 'en'
  },
  logo: {
    type: String
  },
  googleReviewLink: {
    type: String
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'SUSPENDED', 'INACTIVE'],
    default: 'ACTIVE'
  },
  freeTrialUsed: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes
businessSchema.index({ email: 1 });
businessSchema.index({ status: 1 });

export default mongoose.model('Business', businessSchema);
