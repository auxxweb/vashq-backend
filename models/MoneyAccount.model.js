import mongoose from 'mongoose';

/**
 * Per-branch Cash / Bank wallet. Opening balance is also mirrored as an OPENING ledger row.
 * Only used when BusinessSettings.cashAndBankEnabled is true.
 */
const moneyAccountSchema = new mongoose.Schema({
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
  accountType: {
    type: String,
    enum: ['CASH', 'BANK'],
    required: true
  },
  name: {
    type: String,
    trim: true,
    default: ''
  },
  openingBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  openingDate: {
    type: Date,
    default: null
  },
  /** Cached running balance (updated on each ledger post). */
  currentBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

moneyAccountSchema.index({ businessId: 1, branchId: 1, accountType: 1 }, { unique: true });

export default mongoose.model('MoneyAccount', moneyAccountSchema);
