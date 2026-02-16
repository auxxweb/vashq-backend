import mongoose from 'mongoose';

const helpArticleSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true
  },
  content: {
    type: String,
    required: [true, 'Content is required']
  },
  category: {
    type: String,
    trim: true
  },
  isPublished: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Indexes
helpArticleSchema.index({ category: 1 });
helpArticleSchema.index({ isPublished: 1 });

export default mongoose.model('HelpArticle', helpArticleSchema);
