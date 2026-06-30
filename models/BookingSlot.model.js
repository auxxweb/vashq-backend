import mongoose from 'mongoose';

const bookingSlotSchema = new mongoose.Schema({
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
  startTime: {
    type: String,
    required: true,
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid start time']
  },
  endTime: {
    type: String,
    required: true,
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid end time']
  },
  capacity: {
    type: Number,
    required: true,
    min: 1,
    max: 50,
    default: 1
  },
  isEnabled: {
    type: Boolean,
    default: true
  },
  sortOrder: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

bookingSlotSchema.index({ businessId: 1, isEnabled: 1, sortOrder: 1 });

export default mongoose.model('BookingSlot', bookingSlotSchema);
