import mongoose from 'mongoose';

const leadActivitySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'CREATED',
      'STATUS_CHANGE',
      'NOTE',
      'FOLLOW_UP_SET',
      'FOLLOW_UP_DONE',
      'CONVERTED_BOOKING',
      'CONVERTED_JOB',
      'UPDATED',
      'IMPORTED',
      'ASSIGNED'
    ],
    required: true
  },
  note: { type: String, trim: true, default: '' },
  fromStatusId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeadStatus', default: null },
  fromStatusName: { type: String, default: '' },
  toStatusId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeadStatus', default: null },
  toStatusName: { type: String, default: '' },
  followUpAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const leadSchema = new mongoose.Schema({
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
  name: {
    type: String,
    required: [true, 'Customer name is required'],
    trim: true
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    trim: true
  },
  location: {
    type: String,
    trim: true,
    default: ''
  },
  /** Optional vehicle fields */
  vehicleNumber: { type: String, trim: true, default: '' },
  vehicleBrand: { type: String, trim: true, default: '' },
  vehicleModel: { type: String, trim: true, default: '' },
  vehicleColor: { type: String, trim: true, default: '' },
  vehicleType: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  statusId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LeadStatus',
    required: true,
    index: true
  },
  sourceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LeadSource',
    default: null,
    index: true
  },
  followUpAt: { type: Date, default: null, index: true },
  followUpNotes: { type: String, trim: true, default: '' },
  convertedCustomerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null
  },
  convertedBookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    default: null
  },
  convertedJobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    default: null
  },
  convertedAt: { type: Date, default: null },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  activity: [leadActivitySchema],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, { timestamps: true });

leadSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });
leadSchema.index({ businessId: 1, phone: 1 });
leadSchema.index({ businessId: 1, statusId: 1, followUpAt: 1 });

export default mongoose.model('Lead', leadSchema);
