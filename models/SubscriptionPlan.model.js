import mongoose from 'mongoose';

const subscriptionPlanSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Plan name is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  validityDays: {
    type: Number,
    required: [true, 'Validity in days is required'],
    min: [1, 'Validity must be at least 1 day']
  },
  price: {
    type: Number,
    default: 0,
    min: [0, 'Price cannot be negative']
  },
  features: [{
    type: String,
    trim: true
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  isFreeTrial: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

subscriptionPlanSchema.index({ isActive: 1 });

export default mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
