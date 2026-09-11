import crypto from 'node:crypto';
import Car from '../models/Car.model.js';

export const UNIQUE_VEHICLE_ID_PREFIX = 'UID-';
const UNIQUE_VEHICLE_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function isUniqueVehicleId(value) {
  return /^UID-[A-Z0-9]{6,12}$/.test(String(value || '').trim().toUpperCase());
}

export async function allocateUniqueVehicleId({ businessId, excludeCarId = null } = {}) {
  if (!businessId) {
    const err = new Error('Business is required to allocate a unique vehicle ID');
    err.status = 400;
    throw err;
  }

  for (let attempt = 0; attempt < 24; attempt += 1) {
    let suffix = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i += 1) {
      suffix += UNIQUE_VEHICLE_ID_CHARS[bytes[i] % UNIQUE_VEHICLE_ID_CHARS.length];
    }
    const plate = `${UNIQUE_VEHICLE_ID_PREFIX}${suffix}`;
    const filter = { businessId, carNumber: plate };
    if (excludeCarId) filter._id = { $ne: excludeCarId };
    const existing = await Car.findOne(filter).select('_id').lean();
    if (!existing) return plate;
  }

  const err = new Error('Could not allocate a unique vehicle ID');
  err.status = 500;
  throw err;
}
