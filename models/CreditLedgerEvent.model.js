import mongoose from 'mongoose';

const creditLedgerEventSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', index: true },
  collectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentCollection', index: true },
  eventType: {
    type: String,
    enum: ['CREDIT_CREATED', 'PAYMENT_COLLECTED', 'ADJUSTMENT', 'REFUND', 'CANCELLATION'],
    required: true,
    index: true
  },
  amount: { type: Number, default: 0, min: 0 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

creditLedgerEventSchema.index({ businessId: 1, customerId: 1, createdAt: -1 });
creditLedgerEventSchema.index({ businessId: 1, invoiceId: 1, createdAt: -1 });

export default mongoose.model('CreditLedgerEvent', creditLedgerEventSchema);
