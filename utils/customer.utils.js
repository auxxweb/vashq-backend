import Customer from '../models/Customer.model.js';

export function normalizePhone(phone) {
  return String(phone || '').trim().replace(/[^\d+]/g, '');
}

/** Match a normalized mobile against phone or legacy whatsappNumber for one business (optionally one branch). */
export function customerPhoneFilter(businessId, normalizedPhone, branchId = null) {
  const filter = {
    businessId,
    $or: [
      { phone: normalizedPhone },
      { whatsappNumber: normalizedPhone }
    ]
  };
  if (branchId) {
    filter.branchId = branchId;
  }
  return filter;
}

export async function findCustomerByPhone(businessId, phone, branchId = null) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return Customer.findOne(customerPhoneFilter(businessId, normalized, branchId));
}

/**
 * Ensures no other customer in this business (and branch, when set) uses the same mobile number.
 * @throws Error with status 400 when duplicate exists
 */
export async function assertCustomerPhoneAvailable(businessId, phone, excludeCustomerId = null, branchId = null) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    const err = new Error('Valid phone number is required');
    err.status = 400;
    throw err;
  }

  const filter = customerPhoneFilter(businessId, normalized, branchId);
  if (excludeCustomerId) {
    filter._id = { $ne: excludeCustomerId };
  }

  const existing = await Customer.findOne(filter).select('_id name phone').lean();
  if (existing) {
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
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Valid phone number is required');

  let customer = await findCustomerByPhone(businessId, normalized, branchId);
  if (customer) {
    let changed = false;
    if (address && !customer.address) {
      customer.address = address;
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
