import mongoose from 'mongoose';

/**
 * Other / additional revenue (inflow) — not from jobs, variable services, or product sales.
 * Mirrors Expense settlement/payment fields; CREDIT = receivable (amount still to collect).
 */
const otherRevenueSchema = new mongoose.Schema({
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
  otherRevenueTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OtherRevenueType',
    required: true
  },
  /** Total revenue amount (what was earned / billed). */
  amount: {
    type: Number,
    required: [true, 'Amount is required'],
    min: 0
  },
  /**
   * FULL = received in full at entry.
   * CREDIT = collect later / partial now — outstanding is a receivable.
   */
  settlementMode: {
    type: String,
    enum: ['FULL', 'CREDIT'],
    default: 'FULL',
    index: true
  },
  /** Remaining uncollected amount when settlementMode is CREDIT. Always 0 for FULL. */
  outstandingAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  paymentStatus: {
    type: String,
    enum: ['PAID', 'PARTIAL', 'UNPAID'],
    default: 'PAID'
  },
  /** Optional date by which remaining receivable should be collected. */
  creditDueDate: {
    type: Date,
    default: null
  },
  /** How the received portion came in: cash, online, or split. */
  paymentMethod: {
    type: String,
    enum: ['CASH', 'ONLINE', 'SPLIT'],
    default: 'CASH'
  },
  paymentCashAmount: { type: Number, default: 0, min: 0 },
  paymentOnlineAmount: { type: Number, default: 0, min: 0 },
  /** Optional receipt / proof image URL. */
  receiptImage: {
    type: String,
    trim: true
  },
  revenueDate: {
    type: Date,
    required: true,
    default: () => new Date()
  },
  notes: {
    type: String,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

otherRevenueSchema.index({ businessId: 1 });
otherRevenueSchema.index({ businessId: 1, revenueDate: -1 });
otherRevenueSchema.index({ businessId: 1, settlementMode: 1, outstandingAmount: 1 });

export default mongoose.model('OtherRevenue', otherRevenueSchema);
