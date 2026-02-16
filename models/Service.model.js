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
    required: [true, 'Min time is required'],
    min: [1, 'Min time must be at least 1 minute']
  },
  maxTime: {
    type: Number,
    required: [true, 'Max time is required'],
    min: [1, 'Max time must be at least 1 minute']
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
