import mongoose from 'mongoose';

const serviceCategorySchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: [true, 'Category name is required'],
    trim: true,
    maxlength: 80
  },
  /** Built-in fallback category for uncategorized / legacy services. Cannot be deleted. */
  isDefault: {
    type: Boolean,
    default: false,
    index: true
  },
  isActive: {
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

serviceCategorySchema.index({ businessId: 1, name: 1 }, { unique: true });
serviceCategorySchema.index({ businessId: 1, isDefault: 1 });

export default mongoose.model('ServiceCategory', serviceCategorySchema);
