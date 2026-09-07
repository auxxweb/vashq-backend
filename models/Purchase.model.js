import mongoose from 'mongoose';

const purchaseItemSchema = new mongoose.Schema({
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true
  },
  productName: {
    type: String,
    trim: true,
    default: ''
  },
  quantity: {
    type: Number,
    required: true,
    min: [0.001, 'Quantity must be positive']
  },
  unitCost: {
    type: Number,
    required: true,
    min: [0, 'Unit cost cannot be negative']
  },
  lineTotal: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false });

const purchaseSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
    index: true
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    default: null
  },
  supplierName: {
    type: String,
    trim: true,
    default: ''
  },
  billNumber: {
    type: String,
    trim: true,
    default: ''
  },
  purchaseDate: {
    type: Date,
    required: true,
    default: () => new Date(),
    index: true
  },
  items: {
    type: [purchaseItemSchema],
    validate: {
      validator(v) {
        return Array.isArray(v) && v.length > 0;
      },
      message: 'At least one purchase line is required'
    }
  },
  subtotal: {
    type: Number,
    required: true,
    min: 0
  },
  /** Discount received from supplier. */
  discountType: {
    type: String,
    enum: ['amount', 'percent'],
    default: 'amount'
  },
  discountValue: { type: Number, default: 0, min: 0 },
  discountAmount: { type: Number, default: 0, min: 0 },
  /** Goods cost after discount (before tax). Used for inventory / P&L purchases. */
  netGoodsAmount: { type: Number, default: 0, min: 0 },
  taxMode: {
    type: String,
    enum: ['none', 'included', 'excluded'],
    default: 'none'
  },
  taxPercent: { type: Number, default: 0, min: 0 },
  taxAmount: { type: Number, default: 0, min: 0 },
  /**
   * Extra bill costs (courier, packing, etc.).
   * before_tax = in GST base; after_tax = outside GST (common for courier).
   */
  additionalCharges: { type: Number, default: 0, min: 0 },
  additionalChargesMode: {
    type: String,
    enum: ['before_tax', 'after_tax'],
    default: 'after_tax'
  },
  /** Payable total (after discount + tax + additional charges). Used for settlement / Cash & Bank. */
  grandTotal: { type: Number, default: 0, min: 0 },
  /** Optional scanned bill / receipt image URL. */
  billImage: {
    type: String,
    trim: true,
    default: ''
  },
  /**
   * FULL = paid in full when purchase is recorded.
   * CREDIT = pay later / partial — outstanding is payable to supplier.
   */
  settlementMode: {
    type: String,
    enum: ['FULL', 'CREDIT'],
    default: 'FULL',
    index: true
  },
  outstandingAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  paymentStatus: {
    type: String,
    enum: ['PAID', 'PARTIAL', 'UNPAID'],
    default: 'PAID',
    index: true
  },
  creditDueDate: {
    type: Date,
    default: null
  },
  paymentMethod: {
    type: String,
    enum: ['CASH', 'ONLINE', 'SPLIT'],
    default: 'CASH'
  },
  paymentCashAmount: { type: Number, default: 0, min: 0 },
  paymentOnlineAmount: { type: Number, default: 0, min: 0 },
  notes: {
    type: String,
    trim: true,
    default: ''
  },
  /** When true, stock ledger rows were posted (cannot delete without reverse). */
  stockPosted: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

purchaseSchema.index({ businessId: 1, purchaseDate: -1 });
purchaseSchema.index({ businessId: 1, supplierId: 1, purchaseDate: -1 });
purchaseSchema.index({ businessId: 1, supplierId: 1, outstandingAmount: 1 });

export default mongoose.model('Purchase', purchaseSchema);
