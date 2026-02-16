import mongoose from 'mongoose';

const whatsAppMessageSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    default: null
  },
  templateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WhatsAppTemplate',
    default: null
  },
  recipient: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'SENT', 'FAILED'],
    default: 'PENDING'
  },
  sentAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Indexes
whatsAppMessageSchema.index({ businessId: 1 });
whatsAppMessageSchema.index({ jobId: 1 });
whatsAppMessageSchema.index({ status: 1 });

export default mongoose.model('WhatsAppMessage', whatsAppMessageSchema);
