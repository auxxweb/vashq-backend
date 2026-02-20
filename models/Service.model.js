import mongoose from 'mongoose';

const serviceSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  name: {
    type: String,
    required: [true, 'Service name is required'],
    trim: true
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price must be non-negative']
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
