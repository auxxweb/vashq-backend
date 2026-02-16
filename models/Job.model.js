import mongoose from 'mongoose';

const jobStatusHistorySchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['RECEIVED', 'IN_PROGRESS', 'WASHING', 'DRYING', 'COMPLETED', 'DELIVERED', 'CANCELLED'],
    required: true
  },
  notes: {
    type: String
  },
  changedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const jobServiceSchema = new mongoose.Schema({
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true
  },
  price: {
    type: Number,
    required: true
  }
}, { _id: false });

const jobSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  carId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Car',
    required: true
  },
  tokenNumber: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['RECEIVED', 'IN_PROGRESS', 'WASHING', 'DRYING', 'COMPLETED', 'DELIVERED', 'CANCELLED'],
    default: 'RECEIVED'
  },
  totalPrice: {
    type: Number,
    required: true,
    default: 0
  },
  estimatedDelivery: {
    type: Date
  },
  actualDelivery: {
    type: Date
  },
  beforeImages: [{
    type: String
  }],
  afterImages: [{
    type: String
  }],
  notes: {
    type: String
  },
  services: [jobServiceSchema],
  statusHistory: [jobStatusHistorySchema]
}, {
  timestamps: true
});

// Indexes
jobSchema.index({ businessId: 1 });
jobSchema.index({ customerId: 1 });
jobSchema.index({ carId: 1 });
jobSchema.index({ status: 1 });
// Compound unique index: tokenNumber must be unique per business
jobSchema.index({ businessId: 1, tokenNumber: 1 }, { unique: true });
jobSchema.index({ createdAt: -1 });

export default mongoose.model('Job', jobSchema);
