import mongoose from 'mongoose';

/**
 * Optional day open / close session per branch (physical cash count).
 */
const cashDaySessionSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true
  },
  /** Calendar day in business timezone (YYYY-MM-DD stored as UTC noon for stability) */
  sessionDate: {
    type: Date,
    required: true,
    index: true
  },
  sessionDateKey: {
    type: String,
    required: true,
    trim: true
  },
  openingCashExpected: { type: Number, default: 0 },
  openingCashCounted: { type: Number, default: null },
  closingCashExpected: { type: Number, default: 0 },
  closingCashCounted: { type: Number, default: null },
  closingBankExpected: { type: Number, default: 0 },
  varianceCash: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['OPEN', 'CLOSED'],
    default: 'OPEN',
    index: true
  },
  openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  openedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  notes: { type: String, trim: true, default: '' }
}, { timestamps: true });

cashDaySessionSchema.index({ businessId: 1, branchId: 1, sessionDateKey: 1 }, { unique: true });

export default mongoose.model('CashDaySession', cashDaySessionSchema);
