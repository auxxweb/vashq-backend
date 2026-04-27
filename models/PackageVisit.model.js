import mongoose from 'mongoose';

const serviceUsedSchema = new mongoose.Schema({
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  quantity: { type: Number, required: true, min: 1, default: 1 }
}, { _id: false });

const packageVisitSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  customerPackageId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerPackage', required: true, index: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, required: false, index: true }, // optional integration
  // If this visit originated as a scheduled booking, keep the scheduled datetime here
  // even after the visit is completed (so UI can show "Early/Overdue" correctly).
  scheduledFor: { type: Date, default: null, index: true },
  date: { type: Date, default: Date.now, index: true },
  status: { type: String, enum: ['scheduled', 'completed', 'cancelled', 'no-show'], required: true, index: true },
  notes: { type: String, trim: true },
  servicesUsed: { type: [serviceUsedSchema], default: [] },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  createWithoutImages: { type: Boolean, default: false },
  beforeImages: [{ type: String }],
  afterImages: [{ type: String }]
}, { timestamps: true });

packageVisitSchema.index({ businessId: 1, customerPackageId: 1, date: -1 });

export default mongoose.model('PackageVisit', packageVisitSchema);

