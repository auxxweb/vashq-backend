import mongoose from 'mongoose';

export const BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'CONVERTED_TO_JOB'];
export const BOOKING_OCCUPYING_STATUSES = ['PENDING', 'CONFIRMED', 'CONVERTED_TO_JOB'];

const bookingSchema = new mongoose.Schema({
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
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  carId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Car',
    default: null
  },
  serviceIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service'
  }],
  bookingDate: {
    type: Date,
    required: true,
    index: true
  },
  slotId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BookingSlot',
    required: true
  },
  bayNumber: {
    type: Number,
    required: true,
    min: 1
  },
  status: {
    type: String,
    enum: BOOKING_STATUSES,
    default: 'PENDING',
    index: true
  },
  deliveryMethod: {
    type: String,
    enum: ['SELF_VISIT', 'PICKUP_DROP'],
    default: 'SELF_VISIT'
  },
  pickupAddress: { type: String, trim: true },
  pickupLandmark: { type: String, trim: true },
  pickupNotes: { type: String, trim: true },
  customerName: { type: String, required: true, trim: true },
  customerPhone: { type: String, required: true, trim: true },
  vehicleNumber: { type: String, trim: true },
  vehicleBrand: { type: String, trim: true },
  vehicleModel: { type: String, trim: true },
  vehicleType: { type: String, trim: true },
  notes: { type: String, trim: true },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    default: null
  },
  confirmedAt: { type: Date },
  rejectedAt: { type: Date },
  cancelledAt: { type: Date },
  convertedAt: { type: Date },
  rescheduledFrom: {
    bookingDate: Date,
    slotId: { type: mongoose.Schema.Types.ObjectId, ref: 'BookingSlot' },
    bayNumber: Number
  }
}, {
  timestamps: true
});

bookingSchema.index({ businessId: 1, status: 1, bookingDate: -1 });
bookingSchema.index({ businessId: 1, createdAt: -1 });
bookingSchema.index({ businessId: 1, customerId: 1, createdAt: -1 });
bookingSchema.index({ businessId: 1, slotId: 1, bookingDate: 1, bayNumber: 1 });
bookingSchema.index(
  { businessId: 1, bookingDate: 1, slotId: 1, bayNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: BOOKING_OCCUPYING_STATUSES } }
  }
);

export default mongoose.model('Booking', bookingSchema);
