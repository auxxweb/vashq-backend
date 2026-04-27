import mongoose from 'mongoose';

const planUpgradeRequestSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  currentPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true
  },
  requestedPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true
  },
  approvedPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    default: null
  },
  message: {
    type: String,
    trim: true
  },
  transaction: {
    transactionId: { type: String, trim: true },
    method: { type: String, trim: true },
    amount: { type: Number, min: 0 },
    paidAt: { type: Date },
    notes: { type: String, trim: true }
  },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    default: 'PENDING'
  },
  actionedAt: {
    type: Date
  }
}, {
  timestamps: true
});

planUpgradeRequestSchema.index({ status: 1 });
planUpgradeRequestSchema.index({ createdAt: -1 });
planUpgradeRequestSchema.index({ shopId: 1, status: 1 });

export default mongoose.model('PlanUpgradeRequest', planUpgradeRequestSchema);
