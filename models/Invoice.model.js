import mongoose from 'mongoose';
import crypto from 'crypto';

const invoiceItemSchema = new mongoose.Schema({
  serviceName: { type: String, required: true, trim: true },
  servicePrice: { type: Number, required: true, min: 0 }
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  saleType: { type: String, enum: ['JOB', 'PACKAGE'], default: 'JOB', index: true },
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
  packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerPackage' },
  packageName: { type: String, trim: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  invoiceNumber: { type: String, required: true, trim: true },
  // Company (for display)
  companyName: { type: String, trim: true },
  companyAddress: { type: String, trim: true },
  companyPhone: { type: String, trim: true },
  companyGst: { type: String, trim: true },
  // Customer
  customerName: { type: String, trim: true },
  customerPhone: { type: String, trim: true },
  customerGst: { type: String, trim: true },
  vehicleNumber: { type: String, trim: true },
  // Line items & totals
  items: [invoiceItemSchema],
  discount: { type: Number, default: 0, min: 0 },
  subtotal: { type: Number, required: true, min: 0 },
  taxPercentage: { type: Number, min: 0, max: 100 },
  gstAmount: { type: Number, default: 0, min: 0 },
  loyaltyRedeemedPoints: { type: Number, default: 0, min: 0 },
  loyaltyRedeemedAmount: { type: Number, default: 0, min: 0 },
  finalAmount: { type: Number, required: true, min: 0 },
  // Payment
  paymentMethod: { type: String, enum: ['CASH', 'ONLINE'], default: 'CASH' },
  paymentStatus: { type: String, enum: ['PENDING', 'RECEIVED'], default: 'PENDING' },
  paymentReceivedAt: { type: Date },
  // Share (public view by token)
  shareToken: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

invoiceSchema.index({ businessId: 1 });
invoiceSchema.index({ businessId: 1, invoiceNumber: 1 }, { unique: true });
// Unique invoice per job (sparse to allow package invoices with no jobId)
invoiceSchema.index({ jobId: 1 }, { unique: true, sparse: true });
// Unique invoice per package purchase (optional but prevents duplicates)
invoiceSchema.index({ packageId: 1 }, { unique: true, sparse: true });
invoiceSchema.index({ shareToken: 1 });

export function generateShareToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** Generate a random invoice number (e.g. INV-A7K9X2M4P1). Unique per business via compound index. */
export function generateInvoiceNumber() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'INV-';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) s += chars[bytes[i] % chars.length];
  return s;
}

export default mongoose.model('Invoice', invoiceSchema);
