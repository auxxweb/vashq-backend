import mongoose from 'mongoose';

const settlementChangeRequestSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true,
    index: true
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    required: true,
    index: true
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  tokenNumber: { type: String, trim: true },
  /** Snapshot before change */
  previousDeliveredAt: { type: Date },
  previousInvoiceAt: { type: Date },
  /** Requested values */
  proposedDeliveredAt: { type: Date, required: true },
  proposedInvoiceAt: { type: Date, required: true },
  reason: { type: String, required: true, trim: true },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    default: 'PENDING',
    index: true
  },
  actionedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  actionedAt: { type: Date },
  reviewNote: { type: String, trim: true },
  /** Filled when approved */
  appliedDeliveredAt: { type: Date },
  appliedInvoiceAt: { type: Date }
}, {
  timestamps: true
});

settlementChangeRequestSchema.index({ businessId: 1, status: 1, createdAt: -1 });
settlementChangeRequestSchema.index(
  { invoiceId: 1, status: 1 },
  { partialFilterExpression: { status: 'PENDING' } }
);

export default mongoose.model('SettlementChangeRequest', settlementChangeRequestSchema);
