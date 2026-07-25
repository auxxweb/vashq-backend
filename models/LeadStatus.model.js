import mongoose from 'mongoose';

/**
 * Lead pipeline status. sortOrder defines funnel order.
 * sortOrder === 0 (or isTerminal) = end of travel (e.g. Invalid number);
 * from there only non-terminal statuses are allowed (revive).
 */
const leadStatusSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  /** Funnel order. 0 = terminal (no forward next). */
  sortOrder: {
    type: Number,
    required: true,
    default: 1
  },
  /** Badge color (hex). */
  color: {
    type: String,
    default: '#64748b',
    trim: true
  },
  /** Moving into this status requires follow-up date + note. */
  isFollowUp: {
    type: Boolean,
    default: false
  },
  /** Explicit terminal flag (also implied when sortOrder === 0). */
  isTerminal: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  /** Seeded defaults; owners can still rename/reorder. */
  isSystem: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

leadStatusSchema.index({ businessId: 1, sortOrder: 1 });
leadStatusSchema.index({ businessId: 1, name: 1 }, { unique: true });

export default mongoose.model('LeadStatus', leadStatusSchema);
