import mongoose from 'mongoose';

const attendanceCorrectionRequestSchema = new mongoose.Schema({
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
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  /** Business-timezone calendar day YYYY-MM-DD */
  date: {
    type: String,
    required: true,
    trim: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },
  reason: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000
  },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    default: 'PENDING',
    index: true
  },
  proposedPunchInAt: { type: Date, default: null },
  proposedPunchOutAt: { type: Date, default: null },
  actionedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  actionedAt: { type: Date },
  reviewNote: { type: String, trim: true, maxlength: 1000 },
  appliedPunchInAt: { type: Date },
  appliedPunchOutAt: { type: Date }
}, {
  timestamps: true
});

attendanceCorrectionRequestSchema.index({ businessId: 1, status: 1, createdAt: -1 });
attendanceCorrectionRequestSchema.index(
  { userId: 1, date: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' } }
);

export default mongoose.model('AttendanceCorrectionRequest', attendanceCorrectionRequestSchema);
