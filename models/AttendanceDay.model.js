import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  punchInAt: { type: Date, required: true },
  punchOutAt: { type: Date, default: null }
}, { _id: false });

const breakSchema = new mongoose.Schema({
  startAt: { type: Date, required: true },
  endAt: { type: Date, default: null }
}, { _id: false });

const attendanceDaySchema = new mongoose.Schema({
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
  status: {
    type: String,
    enum: ['PRESENT', 'LEAVE', 'CORRECTED'],
    default: 'PRESENT'
  },
  sessions: { type: [sessionSchema], default: [] },
  breaks: { type: [breakSchema], default: [] },
  source: {
    type: String,
    enum: ['PUNCH', 'ADMIN_CORRECTION'],
    default: 'PUNCH'
  }
}, {
  timestamps: true
});

attendanceDaySchema.index({ businessId: 1, userId: 1, date: 1 }, { unique: true });
attendanceDaySchema.index({ businessId: 1, branchId: 1, date: 1 });

export default mongoose.model('AttendanceDay', attendanceDaySchema);
