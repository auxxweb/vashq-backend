import mongoose from 'mongoose';
import { invalidateBusinessAuthCache } from '../utils/authCache.js';

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
  },
  /** Super-admin module toggles — when false, feature hidden and API blocked. */
  enabledModules: {
    bookings: { type: Boolean, default: true },
    packages: { type: Boolean, default: true },
    variableServices: { type: Boolean, default: true },
    accounting: { type: Boolean, default: true },
    aiInsights: { type: Boolean, default: true },
    branches: { type: Boolean, default: true },
    printer: { type: Boolean, default: true },
    credit: { type: Boolean, default: true }
  },
  /** Saved branch statuses when multi-branch module is turned off (for restore). */
  branchModuleSuspendSnapshot: [{
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'EXPIRED'] }
  }]
}, {
  timestamps: true
});

// Indexes
businessSchema.index({ status: 1 });

businessSchema.post('save', function(doc) {
  invalidateBusinessAuthCache(doc._id);
});

businessSchema.post('findOneAndUpdate', function(doc) {
  if (doc?._id) invalidateBusinessAuthCache(doc._id);
});

export default mongoose.model('Business', businessSchema);
