import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  phone: {
    type: String,
    required: [true, 'Phone is required']
  },
  whatsappNumber: {
    type: String,
    required: [true, 'WhatsApp number is required']
  },
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  address: {
    type: String
  },
  notes: {
    type: String
  }
}, {
  timestamps: true
});

// Indexes
customerSchema.index({ businessId: 1 });
customerSchema.index({ whatsappNumber: 1 });
customerSchema.index({ phone: 1 });

export default mongoose.model('Customer', customerSchema);
