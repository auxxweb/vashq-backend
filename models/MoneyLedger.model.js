import mongoose from 'mongoose';

/**
 * Immutable cash/bank movements. Balance after each row is stored for book reports.
 * Only used when BusinessSettings.cashAndBankEnabled is true.
 */
const moneyLedgerSchema = new mongoose.Schema({
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
    required: true,
    index: true
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MoneyAccount',
    required: true,
    index: true
  },
  entryDate: {
    type: Date,
    required: true,
    index: true
  },
  direction: {
    type: String,
    enum: ['IN', 'OUT'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  /** Signed: IN = +amount, OUT = -amount */
  signedAmount: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true,
    min: 0
  },
  sourceType: {
    type: String,
    enum: [
      'OPENING',
      'INVOICE',
      'JOB_ADVANCE',
      'EXPENSE',
      'OTHER_REVENUE',
      'COLLECTION',
      'DEPOSIT',
      'WITHDRAWAL',
      'TRANSFER',
      'ADJUSTMENT',
      'DAY_CLOSE_ADJUST'
    ],
    required: true,
    index: true
  },
  sourceId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    index: true
  },
  /** Links the two legs of a cash↔bank transfer */
  transferGroupId: {
    type: String,
    trim: true,
    default: null,
    index: true
  },
  movementTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CashMovementType',
    default: null
  },
  notes: {
    type: String,
    trim: true,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, { timestamps: true });

moneyLedgerSchema.index({ businessId: 1, branchId: 1, accountType: 1, entryDate: 1 });
moneyLedgerSchema.index(
  { businessId: 1, sourceType: 1, sourceId: 1, accountType: 1, direction: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourceId: { $type: 'objectId' },
      sourceType: { $nin: ['TRANSFER', 'ADJUSTMENT', 'DAY_CLOSE_ADJUST', 'DEPOSIT', 'WITHDRAWAL'] }
    }
  }
);

export default mongoose.model('MoneyLedger', moneyLedgerSchema);
