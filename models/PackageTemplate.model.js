import mongoose from 'mongoose';

const serviceQtySchema = new mongoose.Schema({
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  quantity: { type: Number, required: true, min: 1, default: 1 }
}, { _id: false });

const packageTemplateSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  totalVisits: { type: Number, required: true, min: 1 },
  validityDays: { type: Number, required: true, min: 1 },
  // Each included service can have a quantity (e.g. Full wash x2)
  servicesIncluded: { type: [serviceQtySchema], default: [] },
  description: { type: String, trim: true },
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

packageTemplateSchema.index({ businessId: 1, createdAt: -1 });
packageTemplateSchema.index({ businessId: 1, name: 1 });

export default mongoose.model('PackageTemplate', packageTemplateSchema);

