import mongoose from 'mongoose';

/**
 * Immutable stock movements. Service.stockQuantity / avgCost are caches updated with each post.
 * Only used when BusinessSettings.inventoryManagementEnabled is true.
 */
const stockLedgerSchema = new mongoose.Schema({
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
  /** Product catalog row (Service with isVariable + skipWorkProcess). */
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      'OPENING',
      'PURCHASE',
      'SALE',
      'SALE_REVERSAL',
      'ADJUST',
      'RETURN',
      'TRANSFER_OUT',
      'TRANSFER_IN'
    ],
    required: true,
    index: true
  },
  /** Positive = stock in, negative = stock out. */
  qtyDelta: {
    type: Number,
    required: true
  },
  /** Unit cost for this movement (purchase cost or avg cost at sale). */
  unitCost: {
    type: Number,
    default: 0,
    min: 0
  },
  /** qtyDelta * unitCost (signed with qty). */
  valueDelta: {
    type: Number,
    default: 0
  },
  balanceQty: {
    type: Number,
    required: true,
    min: 0
  },
  balanceValue: {
    type: Number,
    default: 0,
    min: 0
  },
  refType: {
    type: String,
    enum: ['PURCHASE', 'JOB', 'INVOICE', 'ADJUST', 'OPENING', 'MANUAL', 'RETURN', 'TRANSFER', null],
    default: null
  },
  refId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  notes: {
    type: String,
    trim: true,
    default: ''
  },
  movementDate: {
    type: Date,
    required: true,
    default: () => new Date(),
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

stockLedgerSchema.index({ businessId: 1, serviceId: 1, movementDate: 1 });
stockLedgerSchema.index({ businessId: 1, type: 1, movementDate: 1 });
stockLedgerSchema.index({ businessId: 1, refType: 1, refId: 1 });

export default mongoose.model('StockLedger', stockLedgerSchema);
