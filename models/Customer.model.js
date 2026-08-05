import mongoose from 'mongoose';
import { normalizePhone, phoneMatchVariants } from '../utils/customer.utils.js';

const customerSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
    index: true
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

    const variants = phoneMatchVariants(this.phone);
    const filter = {
      businessId: this.businessId,
      $or: [
        { phone: { $in: variants } },
        { whatsappNumber: { $in: variants } }
      ]
    };
    if (this.branchId) filter.branchId = this.branchId;

    const selfId = this._id;
    if (selfId && !this.isNew) {
      filter._id = { $ne: selfId };
    }

    const duplicate = await this.constructor.findOne(filter).select('_id').lean();
    if (duplicate) {
      // Never flag the same record as a duplicate (findOneAndUpdate validator edge cases)
      if (selfId && String(duplicate._id) === String(selfId)) {
        return next();
      }
      return next(new Error('Mobile number already exists'));
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Indexes — unique per business+branch on phone
customerSchema.index({ businessId: 1 });
customerSchema.index({ businessId: 1, branchId: 1, phone: 1 });
customerSchema.index({ businessId: 1, phone: 1 });
customerSchema.index({ phone: 1 });

export default mongoose.model('Customer', customerSchema);
