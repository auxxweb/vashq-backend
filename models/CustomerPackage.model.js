import mongoose from 'mongoose';

const serviceQtySchema = new mongoose.Schema({
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  quantity: { type: Number, required: true, min: 1, default: 1 }
}, { _id: false });

const serviceRemainingSchema = new mongoose.Schema({
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  total: { type: Number, required: true, min: 0, default: 0 },
  remaining: { type: Number, required: true, min: 0, default: 0 }
}, { _id: false });

const customerPackageSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },

  // Template reference for traceability only (do not depend on it after purchase)
  packageTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageTemplate', required: true, index: true },

  // Snapshot fields copied from template at purchase time
  name: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  totalVisits: { type: Number, required: true, min: 1 },
  validityDays: { type: Number, required: true, min: 1 },
  servicesIncluded: { type: [serviceQtySchema], default: [] },
  servicesRemaining: { type: [serviceRemainingSchema], default: [] },
  description: { type: String, trim: true },

  visitsUsed: { type: Number, default: 0, min: 0 },
  visitsRemaining: { type: Number, required: true, min: 0 },

  startDate: { type: Date, required: true, index: true },
  expiryDate: { type: Date, required: true, index: true },

  status: {
    type: String,
    enum: ['active', 'completed', 'expired', 'cancelled'],
    default: 'active',
    index: true
  }
}, { timestamps: true });

customerPackageSchema.index({ businessId: 1, customerId: 1, status: 1 });
customerPackageSchema.index({ businessId: 1, status: 1, expiryDate: 1 });

export default mongoose.model('CustomerPackage', customerPackageSchema);

