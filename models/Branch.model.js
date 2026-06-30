import mongoose from 'mongoose';

const branchSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: [true, 'Branch name is required'],
    trim: true
  },
  code: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  address: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  location: { type: String, trim: true, default: '' },
  workingHoursStart: { type: String, trim: true, default: '09:00' },
  workingHoursEnd: { type: String, trim: true, default: '18:00' },
  maxConcurrentJobs: { type: Number, default: 1, min: 1 },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'EXPIRED'],
    default: 'ACTIVE',
    index: true
  },
  /** First branch included with main shop subscription — no separate branch fee. */
  isDefault: {
    type: Boolean,
    default: false,
    index: true
  },
  requestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BranchCreationRequest',
    default: null
  },
  activatedAt: { type: Date, default: null }
}, {
  timestamps: true
});

branchSchema.index({ businessId: 1, code: 1 }, { unique: true });
branchSchema.index({ businessId: 1, status: 1 });
branchSchema.index({ businessId: 1, isDefault: 1 });

export default mongoose.model('Branch', branchSchema);
