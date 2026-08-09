import mongoose from 'mongoose';

const serviceSubCategorySchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ServiceCategory',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: [true, 'Subcategory name is required'],
    trim: true,
    maxlength: 80
  },
  /** Built-in fallback under each category. Cannot be deleted. */
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

serviceSubCategorySchema.index({ businessId: 1, categoryId: 1, name: 1 }, { unique: true });
serviceSubCategorySchema.index({ businessId: 1, categoryId: 1, isDefault: 1 });
serviceSubCategorySchema.index({ businessId: 1, categoryId: 1, sortOrder: 1 });

export default mongoose.model('ServiceSubCategory', serviceSubCategorySchema);
