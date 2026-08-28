import mongoose from 'mongoose';

/**
 * Dynamic deposit / withdrawal categories for Cash & Bank.
 * Only used when BusinessSettings.cashAndBankEnabled is true.
 */
const cashMovementTypeSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },
  /** DEPOSIT = money into cash/bank; WITHDRAWAL = money out */
  kind: {
    type: String,
    enum: ['DEPOSIT', 'WITHDRAWAL'],
    required: true,
    index: true
  },
  /**
   * When true:
   * - WITHDRAWAL → owner drawings (not a P&L expense)
   * - DEPOSIT → owner capital introduced (not P&L income)
   * When false, treated as operational adjustment (still not sales/expense).
   */
  isOwnerCapital: {
    type: Boolean,
    default: true
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  sortOrder: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

cashMovementTypeSchema.index({ businessId: 1, kind: 1, name: 1 }, { unique: true });

export default mongoose.model('CashMovementType', cashMovementTypeSchema);
