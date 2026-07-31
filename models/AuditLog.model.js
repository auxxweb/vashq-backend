import mongoose from 'mongoose';

const geoSchema = new mongoose.Schema({
  country: { type: String, trim: true },
  region: { type: String, trim: true },
  city: { type: String, trim: true }
}, { _id: false });

const auditLogSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  actorEmail: { type: String, trim: true, lowercase: true, index: true },
  actorRole: { type: String, trim: true, index: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null, index: true },
  action: { type: String, required: true, trim: true, index: true },
  severity: {
    type: String,
    enum: ['CRITICAL', 'HIGH', 'MEDIUM'],
    default: 'MEDIUM',
    index: true
  },
  channel: {
    type: String,
    enum: ['APP'],
    default: 'APP'
  },
  method: { type: String, trim: true },
  path: { type: String, trim: true },
  targetType: { type: String, trim: true },
  targetId: { type: String, trim: true, index: true },
  targetLabel: { type: String, trim: true },
  success: { type: Boolean, default: true },
  statusCode: { type: Number },
  ip: { type: String, trim: true, index: true },
  userAgent: { type: String, trim: true },
  deviceSummary: { type: String, trim: true },
  geo: { type: geoSchema, default: undefined },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ severity: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export default mongoose.model('AuditLog', auditLogSchema);
