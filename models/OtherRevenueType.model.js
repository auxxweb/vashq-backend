import mongoose from 'mongoose';

const otherRevenueTypeSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  revenueName: {
    type: String,
    required: [true, 'Revenue type name is required'],
    trim: true
  }
}, {
  timestamps: true
});

otherRevenueTypeSchema.index({ businessId: 1 });

export default mongoose.model('OtherRevenueType', otherRevenueTypeSchema);
