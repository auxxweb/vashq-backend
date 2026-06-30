import mongoose from 'mongoose';

const branchCreationRequestSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  address: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  location: { type: String, trim: true, default: '' },
  workingHoursStart: { type: String, trim: true, default: '09:00' },
  workingHoursEnd: { type: String, trim: true, default: '18:00' },
  maxConcurrentJobs: { type: Number, default: 1, min: 1 },
  message: { type: String, trim: true },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    default: 'PENDING',
    index: true
  },
  rejectionReason: { type: String, trim: true },
  approvedBranchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  transaction: {
    transactionId: { type: String, trim: true },
    method: { type: String, trim: true },
    amount: { type: Number, min: 0 },
    paidAt: { type: Date },
    notes: { type: String, trim: true }
  },
  actionedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  actionedAt: { type: Date, default: null },
  requestType: {
    type: String,
    enum: ['CREATE', 'RENEW'],
    default: 'CREATE',
    index: true
  },
  /** For RENEW — branch being renewed */
  renewBranchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  }
}, {
  timestamps: true
});

branchCreationRequestSchema.index({ businessId: 1, status: 1 });
branchCreationRequestSchema.index({ createdAt: -1 });

export default mongoose.model('BranchCreationRequest', branchCreationRequestSchema);
