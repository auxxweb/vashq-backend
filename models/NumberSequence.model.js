import mongoose from 'mongoose';

/**
 * Atomic counters for custom job tokens / invoice numbers.
 * scopeKey examples: GLOBAL | 2026-08-05 (daily) | 2026-08 (monthly)
 */
const numberSequenceSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  kind: {
    type: String,
    enum: ['JOB_TOKEN', 'INVOICE'],
    required: true
  },
  scopeKey: {
    type: String,
    required: true,
    trim: true
  },
  nextValue: {
    type: Number,
    default: 0,
    min: 0
  }
}, {
  timestamps: true
});

numberSequenceSchema.index(
  { businessId: 1, branchId: 1, kind: 1, scopeKey: 1 },
  { unique: true }
);

export default mongoose.model('NumberSequence', numberSequenceSchema);
