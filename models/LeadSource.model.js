import mongoose from 'mongoose';

const leadSourceSchema = new mongoose.Schema({
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
  isActive: {
    type: Boolean,
    default: true
  },
  isSystem: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

leadSourceSchema.index({ businessId: 1, name: 1 }, { unique: true });

export default mongoose.model('LeadSource', leadSourceSchema);
