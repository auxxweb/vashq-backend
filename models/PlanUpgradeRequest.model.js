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
  message: {
    type: String,
    trim: true
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

planUpgradeRequestSchema.index({ shopId: 1 });
planUpgradeRequestSchema.index({ status: 1 });
planUpgradeRequestSchema.index({ createdAt: -1 });

export default mongoose.model('PlanUpgradeRequest', planUpgradeRequestSchema);
