import mongoose from 'mongoose';

const shopSubscriptionSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    unique: true
  },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true
  },
  startDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  expiryDate: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'EXPIRED', 'PENDING_UPGRADE'],
    default: 'ACTIVE'
  }
}, {
  timestamps: true
});

shopSubscriptionSchema.index({ shopId: 1 });
shopSubscriptionSchema.index({ status: 1 });
shopSubscriptionSchema.index({ expiryDate: 1 });

export default mongoose.model('ShopSubscription', shopSubscriptionSchema);
