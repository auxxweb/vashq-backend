import mongoose from 'mongoose';

const tutorialStepSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  order: {
    type: Number,
    required: true
  }
}, { _id: false });

const tutorialSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true
  },
  description: {
    type: String,
    required: [true, 'Description is required']
  },
  steps: [tutorialStepSchema],
  youtubeLink: {
    type: String
  },
  thumbnail: {
    type: String
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
tutorialSchema.index({ isPublished: 1 });

export default mongoose.model('Tutorial', tutorialSchema);
