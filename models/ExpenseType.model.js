import mongoose from 'mongoose';

const expenseTypeSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  expenseName: {
    type: String,
    required: [true, 'Expense type name is required'],
    trim: true
  }
}, {
  timestamps: true
});

expenseTypeSchema.index({ businessId: 1 });

export default mongoose.model('ExpenseType', expenseTypeSchema);
