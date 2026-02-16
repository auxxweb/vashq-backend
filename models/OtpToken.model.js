import mongoose from 'mongoose';

const otpTokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  token: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['PASSWORD_RESET'],
    default: 'PASSWORD_RESET'
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expireAfterSeconds: 0 } // Auto-delete expired tokens
  },
  used: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index for faster lookups
otpTokenSchema.index({ userId: 1, token: 1, used: 1 });

export default mongoose.model('OtpToken', otpTokenSchema);
