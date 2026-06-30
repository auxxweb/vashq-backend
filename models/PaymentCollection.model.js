import mongoose from 'mongoose';
import crypto from 'crypto';

const allocationSchema = new mongoose.Schema({
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
  invoiceNumber: { type: String, trim: true },
  amount: { type: Number, required: true, min: 0 }
}, { _id: false });

/** e.g. COL-A7K9X2M4 — unique per business (matches legacy DB index). */
export function generateCollectionNumber() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'COL-';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += chars[bytes[i] % chars.length];
  return s;
}

const paymentCollectionSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  collectionNumber: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: ['CASH', 'ONLINE', 'SPLIT'], required: true },
  paymentCashAmount: { type: Number, default: 0, min: 0 },
  paymentOnlineAmount: { type: Number, default: 0, min: 0 },
  allocationMode: { type: String, enum: ['FIFO', 'MANUAL'], default: 'FIFO' },
  allocations: [allocationSchema],
  notes: { type: String, trim: true },
  collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  /** Client-supplied key to prevent duplicate submissions. */
  idempotencyKey: { type: String, trim: true },
  collectionDate: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

paymentCollectionSchema.index({ businessId: 1, customerId: 1, collectionDate: -1 });
paymentCollectionSchema.index({ businessId: 1, collectionNumber: 1 }, { unique: true });
paymentCollectionSchema.index(
  { businessId: 1, idempotencyKey: 1 },
  { unique: true, sparse: true, partialFilterExpression: { idempotencyKey: { $type: 'string', $ne: '' } } }
);

export default mongoose.model('PaymentCollection', paymentCollectionSchema);
