import mongoose from 'mongoose';

const ownerTaskSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 2000 },
  startAt: { type: Date, required: true, index: true },
  endAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['PENDING', 'COMPLETED'], default: 'PENDING', index: true },
  completedAt: { type: Date },
  /** Push reminder (1h before endAt) was sent at this time. */
  reminderSentAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

ownerTaskSchema.index({ businessId: 1, startAt: 1 });
ownerTaskSchema.index({ businessId: 1, endAt: 1 });

export default mongoose.model('OwnerTask', ownerTaskSchema);

