import mongoose from 'mongoose';

const serviceSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
    index: true
  },
  name: {
    type: String,
    required: [true, 'Service name is required'],
    trim: true
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price must be non-negative'],
    default: 0
  },
  minTime: {
    type: Number,
    default: null,
    min: [0, 'Min time must be non-negative']
  },
  maxTime: {
    type: Number,
    default: null,
    min: [0, 'Max time must be non-negative'],
    validate: {
      validator(value) {
        if (value == null || this.minTime == null) return true;
        return value > this.minTime;
      },
      message: 'Maximum service time must be greater than minimum service time'
    }
  },
  description: {
    type: String
  },
  loyaltyPointsEarned: {
    type: Number,
    default: 0
  },
  /** When true, price is entered per job/invoice (catalog price is optional guide only). */
  isVariable: {
    type: Boolean,
    default: false
  },
  /** When true (and isVariable), sold via Variable Service tab — skips wash workflow and bills immediately. */
  skipWorkProcess: {
    type: Boolean,
    default: false
  },
  /** Product inventory — enabled for direct-sale (skip work process) items. */
  trackInventory: {
    type: Boolean,
    default: false
  },
  stockQuantity: {
    type: Number,
    default: null,
    min: [0, 'Stock cannot be negative']
  },
  lowStockThreshold: {
    type: Number,
    default: 5,
    min: [0, 'Low stock threshold cannot be negative']
  },
  isActive: {
    type: Boolean,
    default: true
  },
  /**
   * Optional category (when BusinessSettings.serviceCategoriesEnabled).
   * Legacy / unset rows are backfilled to the business Default category when the feature is enabled.
   */
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ServiceCategory',
    default: null,
    index: true
  },
  /**
   * Optional subcategory (when BusinessSettings.serviceSubcategoriesEnabled).
   * Must belong to the same categoryId when set.
   */
  subCategoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ServiceSubCategory',
    default: null,
    index: true
  },
  /**
   * Optional quality checklist for wash workflow (Mark Completed).
   * Only enforced when BusinessSettings.qualityCheckEnabled is true.
   * Multiple checkbox lines under one checklist name per service.
   */
  qualityChecklist: {
    name: { type: String, trim: true, default: '' },
    items: [{
      label: { type: String, trim: true, required: true }
    }]
  }
}, {
  timestamps: true
});

// Indexes
serviceSchema.index({ businessId: 1 });
serviceSchema.index({ isActive: 1 });
serviceSchema.index({ businessId: 1, categoryId: 1 });
serviceSchema.index({ businessId: 1, subCategoryId: 1 });
serviceSchema.index({ businessId: 1, categoryId: 1, subCategoryId: 1 });

export default mongoose.model('Service', serviceSchema);
