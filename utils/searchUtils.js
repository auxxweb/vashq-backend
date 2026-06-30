/**
 * Shared text search helpers — phone numbers match even with +91, spaces, or dashes.
 */

export function escapeRegex(term) {
  return String(term || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function digitsOnly(term) {
  return String(term || '').replace(/\D/g, '');
}

/**
 * $or clauses for Customer search (name, email, phone, whatsapp).
 */
export function customerSearchOrClauses(term) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return [];

  const escaped = escapeRegex(trimmed);
  const clauses = [
    { name: { $regex: escaped, $options: 'i' } },
    { phone: { $regex: escaped, $options: 'i' } },
    { whatsappNumber: { $regex: escaped, $options: 'i' } },
    { email: { $regex: escaped, $options: 'i' } }
  ];

  const digits = digitsOnly(trimmed);
  if (digits.length >= 3) {
    const sep = '[\\s\\-.+()]*';
    const flexible = digits
      .split('')
      .map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join(sep);
    clauses.push(
      { phone: { $regex: flexible, $options: 'i' } },
      { whatsappNumber: { $regex: flexible, $options: 'i' } }
    );
    if (digits.length >= 6) {
      const tail = escapeRegex(digits);
      clauses.push(
        { phone: { $regex: tail, $options: 'i' } },
        { whatsappNumber: { $regex: tail, $options: 'i' } }
      );
    }
  }

  return clauses;
}

/**
 * $or clauses for Booking search (customer name, phone, vehicle, booking id).
 */
export function bookingSearchOrClauses(term) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return [];

  const escaped = escapeRegex(trimmed);
  const clauses = [
    { customerName: { $regex: escaped, $options: 'i' } },
    { customerPhone: { $regex: escaped, $options: 'i' } },
    { vehicleNumber: { $regex: escaped, $options: 'i' } }
  ];

  const digits = digitsOnly(trimmed);
  if (digits.length >= 3) {
    const sep = '[\\s\\-.+()]*';
    const flexible = digits
      .split('')
      .map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join(sep);
    clauses.push({ customerPhone: { $regex: flexible, $options: 'i' } });
  }

  const hexOnly = trimmed.replace(/[^a-f0-9]/gi, '');
  if (/^[a-f0-9]{24}$/i.test(hexOnly)) {
    clauses.push({ _id: hexOnly });
  } else if (hexOnly.length >= 4) {
    clauses.push({
      $expr: {
        $regexMatch: {
          input: { $toString: '$_id' },
          regex: escapeRegex(hexOnly),
          options: 'i'
        }
      }
    });
  }

  return clauses;
}

/**
 * Find customer _ids for a business matching search (name, phone, email, etc.).
 */
export async function distinctCustomerIdsBySearch(Customer, businessId, term) {
  const orClauses = customerSearchOrClauses(term);
  if (!orClauses.length) return [];
  return Customer.find({ businessId, $or: orClauses }).distinct('_id');
}
