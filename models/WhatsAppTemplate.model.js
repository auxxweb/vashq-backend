import mongoose from 'mongoose';

const whatsAppTemplateSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    default: null // null for global templates
  },
  name: {
    type: String,
    required: [true, 'Template name is required'],
    trim: true
  },
  template: {
    type: String,
    required: [true, 'Template content is required']
  },
  variables: [{
    type: String
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  isGlobal: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes
whatsAppTemplateSchema.index({ businessId: 1 });
whatsAppTemplateSchema.index({ isActive: 1 });

export default mongoose.model('WhatsAppTemplate', whatsAppTemplateSchema);
