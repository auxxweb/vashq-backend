import mongoose from 'mongoose';

const branchSubscriptionSchema = new mongoose.Schema({
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    unique: true
  },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  startDate: { type: Date, required: true, default: Date.now },
  expiryDate: { type: Date, required: true },
  annualFee: { type: Number, default: 2000, min: 0 },
  status: {
    type: String,
    enum: ['ACTIVE', 'EXPIRED', 'PENDING_RENEWAL'],
    default: 'ACTIVE',
    index: true
  },
  lastRequestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BranchCreationRequest',
    default: null
  }
}, {
  timestamps: true
});

branchSubscriptionSchema.index({ expiryDate: 1 });
branchSubscriptionSchema.index({ businessId: 1, status: 1 });

export default mongoose.model('BranchSubscription', branchSubscriptionSchema);
