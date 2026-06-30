import mongoose from 'mongoose';

const aiInsightSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  module: {
    type: String,
    required: true,
    trim: true
  },
  insightType: {
    type: String,
    enum: ['quick', 'deep', 'consultant', 'qa'],
    required: true
  },
  timeRange: { type: String, trim: true },
  rangeLabel: { type: String, trim: true },
  customFrom: { type: Date },
  customTo: { type: Date },
  prompt: { type: String, trim: true },
  followUpType: { type: String, trim: true },
  parentInsightId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AiInsight',
    default: null
  },
  businessHealthScore: { type: Number, min: 0, max: 100 },
  result: { type: mongoose.Schema.Types.Mixed },
  reportMarkdown: { type: String }
}, {
  timestamps: true
});

aiInsightSchema.index({ businessId: 1, createdAt: -1 });

export default mongoose.model('AiInsight', aiInsightSchema);
