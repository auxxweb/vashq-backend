import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  expenseTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ExpenseType',
    required: true
  },
  amount: {
    type: Number,
    required: [true, 'Amount is required'],
    min: 0
  },
  billImage: {
    type: String,
    trim: true
  },
  expenseDate: {
    type: Date,
    required: true,
    default: () => new Date()
  },
  notes: {
    type: String,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

expenseSchema.index({ businessId: 1 });
expenseSchema.index({ businessId: 1, expenseDate: -1 });

export default mongoose.model('Expense', expenseSchema);
