import mongoose from 'mongoose';
import crypto from 'crypto';

const estimateItemSchema = new mongoose.Schema({
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', default: null },
  name: { type: String, required: true, trim: true },
  /** SERVICE = wash/work; PRODUCT = catalog product / variable skip-work; CUSTOM = free text */
  itemType: {
    type: String,
    enum: ['SERVICE', 'PRODUCT', 'CUSTOM'],
    default: 'SERVICE'
  },
  unitPrice: { type: Number, required: true, min: 0 },
  quantity: { type: Number, default: 1, min: 0.01 },
  amount: { type: Number, required: true, min: 0 },
  notes: { type: String, trim: true, default: '' }
}, { _id: false });

const estimateSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
    index: true
  },
  estimateNumber: { type: String, required: true, trim: true },
  status: {
    type: String,
    enum: ['DRAFT', 'SHARED', 'CONVERTED', 'CANCELLED'],
    default: 'DRAFT',
    index: true
  },
  // Company snapshot
  companyName: { type: String, trim: true, default: '' },
  companyOwnerName: { type: String, trim: true, default: '' },
  companyAddress: { type: String, trim: true, default: '' },
  companyPhone: { type: String, trim: true, default: '' },
  companyEmail: { type: String, trim: true, default: '' },
  companyGst: { type: String, trim: true, default: '' },
  companyLogo: { type: String, trim: true, default: '' },
  // Customer / lead
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
  customerName: { type: String, required: true, trim: true },
  customerPhone: { type: String, required: true, trim: true },
  customerEmail: { type: String, trim: true, default: '' },
  customerLocation: { type: String, trim: true, default: '' },
  vehicleNumber: { type: String, trim: true, default: '' },
  vehicleBrand: { type: String, trim: true, default: '' },
  vehicleModel: { type: String, trim: true, default: '' },
  vehicleType: { type: String, trim: true, default: '' },
  vehicleColor: { type: String, trim: true, default: '' },
  // Lines & totals
  items: { type: [estimateItemSchema], default: [] },
  /** Optional budget / package ceiling shown on the document */
  budgetAmount: { type: Number, default: null, min: 0 },
  budgetLabel: { type: String, trim: true, default: '' },
  discountType: { type: String, enum: ['PERCENT', 'AMOUNT'], default: 'PERCENT' },
  discount: { type: Number, default: 0, min: 0 },
  discountAmount: { type: Number, default: 0, min: 0 },
  taxPercentage: { type: Number, default: 0, min: 0, max: 100 },
  taxAmount: { type: Number, default: 0, min: 0 },
  subtotal: { type: Number, default: 0, min: 0 },
  finalAmount: { type: Number, default: 0, min: 0 },
  notes: { type: String, trim: true, default: '' },
  terms: { type: String, trim: true, default: '' },
  validUntil: { type: Date, default: null },
  title: { type: String, trim: true, default: 'Estimate' },
  // Share
  shareToken: { type: String, trim: true, default: null, index: true },
  sharedAt: { type: Date, default: null },
  // Ownership / conversion
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  convertedJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
  convertedBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
  convertedAt: { type: Date, default: null }
}, { timestamps: true });

estimateSchema.index({ businessId: 1, estimateNumber: 1 }, { unique: true });
estimateSchema.index({ businessId: 1, status: 1, createdAt: -1 });
estimateSchema.index({ businessId: 1, customerPhone: 1 });
estimateSchema.index({ businessId: 1, leadId: 1 });

estimateSchema.methods.ensureShareToken = function ensureShareToken() {
  if (!this.shareToken) {
    this.shareToken = crypto.randomBytes(24).toString('hex');
  }
  return this.shareToken;
};

export default mongoose.model('Estimate', estimateSchema);
