import mongoose from 'mongoose';

const serviceSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
    index: true
  },
  name: {
    type: String,
    required: [true, 'Service name is required'],
    trim: true
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price must be non-negative'],
    default: 0
  },
  minTime: {
    type: Number,
    default: null,
    min: [0, 'Min time must be non-negative']
  },
  maxTime: {
    type: Number,
    default: null,
    min: [0, 'Max time must be non-negative']
  },
  description: {
    type: String
  },
  loyaltyPointsEarned: {
    type: Number,
    default: 0,
    min: [0, 'Loyalty points must be non-negative']
  },
  /** When true, price is entered per job/invoice (catalog price is optional guide only). */
  isVariable: {
    type: Boolean,
    default: false
  },
  /** When true (and isVariable), sold via Variable Service tab — skips wash workflow and bills immediately. */
  skipWorkProcess: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Indexes
serviceSchema.index({ businessId: 1 });
serviceSchema.index({ isActive: 1 });

export default mongoose.model('Service', serviceSchema);
