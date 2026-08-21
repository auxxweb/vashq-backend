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
  // Primary / last-used customer for this vehicle (jobs still reference carId + customerId separately)
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  // Shared ownership: multiple customers in one business can be linked to the same unique plate
  customerIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  }],
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
carSchema.index({ customerIds: 1 });
carSchema.index({ businessId: 1, carNumber: 1 });

/**
 * Ensure customerId is always present in customerIds (shared ownership list).
 */
carSchema.pre('save', function(next) {
  if (this.customerId) {
    const id = String(this.customerId);
    const list = Array.isArray(this.customerIds) ? this.customerIds.map(String) : [];
    if (!list.includes(id)) {
      this.customerIds = [...(this.customerIds || []), this.customerId];
    }
  }
  next();
});

export default mongoose.model('Car', carSchema);
