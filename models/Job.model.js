import mongoose from 'mongoose';

const jobStatusHistorySchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['RECEIVED', 'WORK_STARTED', 'COMPLETED', 'DELIVERED', 'CANCELLED'],
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
    required: true,
    min: 0
  },
  /** Optional label override (e.g. custom variable service description on this job). */
  customName: {
    type: String,
    trim: true,
    default: ''
  },
  quantity: {
    type: Number,
    default: 1,
    min: [1, 'Quantity must be at least 1']
  }
}, { _id: false });

const qualityCheckItemSchema = new mongoose.Schema({
  itemId: { type: String, required: true },
  label: { type: String, required: true, trim: true },
  checked: { type: Boolean, default: true }
}, { _id: false });

const qualityCheckGroupSchema = new mongoose.Schema({
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  serviceName: { type: String, trim: true, default: '' },
  checklistName: { type: String, trim: true, default: '' },
  items: [qualityCheckItemSchema]
}, { _id: false });

const jobSchema = new mongoose.Schema({
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
  carId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Car',
    default: null
  },
  tokenNumber: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['RECEIVED', 'WORK_STARTED', 'COMPLETED', 'DELIVERED', 'CANCELLED'],
    default: 'RECEIVED'
  },
  totalPrice: {
    type: Number,
    required: true,
    default: 0
  },
  /** Optional amount collected when the job is created (applied on invoice as advance). */
  advancePayment: {
    type: Number,
    default: 0,
    min: 0
  },
  advancePaymentMethod: {
    type: String,
    enum: ['CASH', 'ONLINE', 'SPLIT'],
    default: 'CASH'
  },
  /** UPI or Card when advance includes online (ONLINE or SPLIT). */
  advanceOnlinePaymentMode: {
    type: String,
    enum: ['UPI', 'CARD'],
    default: 'UPI'
  },
  advanceCashAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  advanceOnlineAmount: {
    type: Number,
    default: 0,
    min: 0
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
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Optional package linkage (prepaid package). Do NOT deduct on job creation; only on completion.
  customerPackageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CustomerPackage',
    default: null,
    index: true
  },
  services: [jobServiceSchema],
  statusHistory: [jobStatusHistorySchema],
  /**
   * Snapshot of quality checklist answers when job was marked COMPLETED.
   * Only set when quality check feature was on and checklists existed.
   */
  qualityChecks: [qualityCheckGroupSchema],
  qualityCheckedAt: { type: Date, default: null },
  qualityCheckedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  /** Set when job is created from an online booking. */
  sourceBookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    default: null,
    index: true
  },
  /** Counter / variable sale billed immediately without wash workflow. */
  directBill: {
    type: Boolean,
    default: false,
    index: true
  },
  /**
   * When product lines on a wash job had inventory deducted (on DELIVERED).
   * Direct-bill sales deduct at create and leave this null.
   */
  productStockDeductedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Indexes
jobSchema.index({ businessId: 1, branchId: 1 });
jobSchema.index({ assignedTo: 1 });
jobSchema.index({ customerId: 1 });
jobSchema.index({ carId: 1 });
jobSchema.index({ status: 1 });
// Compound unique index: tokenNumber must be unique per business + branch
jobSchema.index({ businessId: 1, branchId: 1, tokenNumber: 1 }, { unique: true });
jobSchema.index({ createdAt: -1 });
jobSchema.index({ businessId: 1, status: 1, createdAt: -1 });
jobSchema.index({ businessId: 1, assignedTo: 1, status: 1, createdAt: -1 });
jobSchema.index({ businessId: 1, status: 1, actualDelivery: -1 });
jobSchema.index({ businessId: 1, customerId: 1 });

export default mongoose.model('Job', jobSchema);
