import mongoose from 'mongoose';
import Customer from '../models/Customer.model.js';

export function normalizePhone(phone) {
  return String(phone || '').trim().replace(/[^\d+]/g, '');
}

export const DEFAULT_STORAGE_DIAL_CODE = '+91';

/**
 * If the number has no country code, prefix default dial (+91).
 * Numbers that already start with + are left as-is.
 */
export function applyDefaultCountryCode(phone, defaultDial = DEFAULT_STORAGE_DIAL_CODE) {
  const normalized = normalizePhone(phone);
  if (!normalized) return normalized;
  if (normalized.startsWith('+')) return normalized;

  let digits = normalized.replace(/\D/g, '');
  if (!digits) return normalized;
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');

  const dial = String(defaultDial || DEFAULT_STORAGE_DIAL_CODE).replace(/\D/g, '') || '91';
  if (digits.startsWith(dial) && digits.length > dial.length + 5) {
    return `+${digits}`;
  }
  return `+${dial}${digits}`;
}

/** Digits only (no +). */
export function phoneDigits(phone) {
  return normalizePhone(phone).replace(/\D/g, '');
}

/**
 * Canonical digit form for comparison (India: prefer last 10 when 91-prefixed).
 */
export function canonicalPhoneDigits(phone) {
  let digits = phoneDigits(phone);
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('910')) return digits.slice(3);
  return digits;
}

/** True when two stored phones refer to the same line (legacy 10-digit ↔ +91…). */
export function phonesEquivalent(a, b) {
  const ca = canonicalPhoneDigits(a);
  const cb = canonicalPhoneDigits(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  // Same national number under India dial
  if (ca.length >= 10 && cb.length >= 10 && ca.slice(-10) === cb.slice(-10)) {
    const da = phoneDigits(a);
    const db = phoneDigits(b);
    const bothIndia =
      (da.length === 10 || da.startsWith('91')) &&
      (db.length === 10 || db.startsWith('91'));
    if (bothIndia) return true;
  }
  return false;
}

/**
 * Match variants so legacy 10-digit and E.164 (+91…) resolve to the same customer.
 * Avoids aggressive “last 10 of any international” which caused false collisions.
 */
export function phoneMatchVariants(phone) {
  const raw = normalizePhone(phone);
  const digits = phoneDigits(phone);
  const variants = new Set();
  if (raw) variants.add(raw);
  if (digits) {
    variants.add(digits);
    variants.add(`+${digits}`);
  }
  // India common forms only
  if (digits.length === 10) {
    variants.add(`91${digits}`);
    variants.add(`+91${digits}`);
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    variants.add(digits.slice(2));
    variants.add(`+${digits}`);
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    const rest = digits.slice(1);
    variants.add(rest);
    variants.add(`91${rest}`);
    variants.add(`+91${rest}`);
  }
  return [...variants].filter(Boolean);
}

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (mongoose.isValidObjectId(id)) return new mongoose.Types.ObjectId(String(id));
  return null;
}

/** Match a normalized mobile against phone or legacy whatsappNumber for one business (optionally one branch). */
export function customerPhoneFilter(businessId, normalizedPhone, branchId = null) {
  const variants = phoneMatchVariants(normalizedPhone);
  const filter = {
    businessId,
    $or: [
      { phone: { $in: variants } },
      { whatsappNumber: { $in: variants } }
    ]
  };
  if (branchId) {
    filter.branchId = branchId;
  }
  return filter;
}

export async function findCustomerByPhone(businessId, phone, branchId = null) {
  const normalized = applyDefaultCountryCode(normalizePhone(phone));
  if (!normalized) return null;
  return Customer.findOne(customerPhoneFilter(businessId, normalized, branchId));
}

/**
 * Ensures no other customer in this business (and branch, when set) uses the same mobile number.
 * @throws Error with status 400 when duplicate exists
 */
export async function assertCustomerPhoneAvailable(businessId, phone, excludeCustomerId = null, branchId = null) {
  const normalized = applyDefaultCountryCode(normalizePhone(phone));
  if (!normalized) {
    const err = new Error('Valid phone number is required');
    err.status = 400;
    throw err;
  }

  const filter = customerPhoneFilter(businessId, normalized, branchId);
  const excludeOid = toObjectId(excludeCustomerId);
  if (excludeOid) {
    filter._id = { $ne: excludeOid };
  }

  const existing = await Customer.findOne(filter).select('_id name phone whatsappNumber').lean();
  if (existing) {
    // Belt-and-suspenders: never treat the same customer as a duplicate
    if (excludeOid && String(existing._id) === String(excludeOid)) {
      return normalized;
    }
    const err = new Error('Mobile number already exists');
    err.status = 400;
    err.existingCustomerId = existing._id;
    throw err;
  }

  return normalized;
}

/**
 * Find existing customer by mobile for this business+branch, or create one.
 */
export async function findOrCreateCustomer(businessId, { name, phone, address, email, notes, branchId = null }) {
  const normalized = applyDefaultCountryCode(normalizePhone(phone));
  if (!normalized) throw new Error('Valid phone number is required');

  let customer = await findCustomerByPhone(businessId, normalized, branchId);
  if (customer) {
    let changed = false;
    if (address && !customer.address) {
      customer.address = address;
      changed = true;
    }
    if (email && !customer.email) {
      customer.email = email;
      changed = true;
    }
    if (changed) await customer.save();
    return customer;
  }

  try {
    return await Customer.create({
      businessId,
      branchId: branchId || undefined,
      name: String(name || '').trim() || 'Customer',
      phone: normalized,
      whatsappNumber: normalized,
      email: email || undefined,
      address: address || undefined,
      notes: notes || undefined
    });
  } catch (err) {
    if (/already exists/i.test(err.message)) {
      customer = await findCustomerByPhone(businessId, normalized, branchId);
      if (customer) return customer;
    }
    throw err;
  }
}

export function isDuplicatePhoneError(err) {
  return err?.status === 400 && /already exists/i.test(String(err.message || ''));
}
