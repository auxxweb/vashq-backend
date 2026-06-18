import mongoose from 'mongoose';
import { normalizePhone, customerPhoneFilter } from '../utils/customer.utils.js';

const customerSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  phone: {
    type: String,
    required: [true, 'Phone is required']
  },
  whatsappNumber: {
    type: String,
    // Backward compatible: historically required. We now treat "mobile number" as the single source,
    // and default whatsappNumber to phone when not provided.
    required: false
  },
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  address: {
    type: String
  },
  notes: {
    type: String
  },
  loyaltyPointsBalance: {
    type: Number,
    default: 0,
    min: [0, 'Loyalty points balance must be non-negative']
  }
}, {
  timestamps: true
});

customerSchema.pre('validate', async function validateUniquePhone(next) {
  try {
    const phoneTouched = this.isNew || this.isModified('phone') || this.isModified('whatsappNumber');
    if (!phoneTouched) return next();

    if (this.phone) {
      this.phone = normalizePhone(this.phone);
    }
    if (this.whatsappNumber) {
      this.whatsappNumber = normalizePhone(this.whatsappNumber);
    } else if (this.phone) {
      this.whatsappNumber = this.phone;
    }

    if (!this.phone) {
      return next(new Error('Phone is required'));
    }

    const filter = customerPhoneFilter(this.businessId, this.phone);
    if (!this.isNew) filter._id = { $ne: this._id };

    const duplicate = await this.constructor.findOne(filter).select('_id').lean();
    if (duplicate) {
      return next(new Error('Mobile number already exists'));
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Indexes — unique per business on phone (same number allowed across businesses)
customerSchema.index({ businessId: 1 });
customerSchema.index({ businessId: 1, phone: 1 });
customerSchema.index({ phone: 1 });

export default mongoose.model('Customer', customerSchema);
