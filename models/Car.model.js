import mongoose from 'mongoose';

const carSchema = new mongoose.Schema({
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
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  carNumber: {
    type: String,
    required: [true, 'Car number is required'],
    trim: true
  },
  brand: {
    type: String,
    trim: true
  },
  model: {
    type: String,
    trim: true
  },
  color: {
    type: String,
    trim: true
  },
  notes: {
    type: String
  },
  vehicleType: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Indexes
carSchema.index({ businessId: 1 });
carSchema.index({ customerId: 1 });
carSchema.index({ carNumber: 1 });

export default mongoose.model('Car', carSchema);
