/**
 * Invoice discount helpers.
 *
 * Legacy invoices store only `discount` as a percent (0–100).
 * New invoices may use:
 *   discountType: 'PERCENT' | 'AMOUNT'
 *   discount: percent when PERCENT (kept for backward compatibility)
 *   discountAmount: monetary discount always persisted when known
 */

export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function normalizeDiscountType(type) {
  return String(type || '').toUpperCase() === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
}

/**
 * Resolve monetary discount and percent from an invoice (or plain object).
 * Existing docs without discountType are treated as PERCENT.
 */
export function resolveInvoiceDiscount(invoice) {
  const subtotal = roundMoney(Math.max(0, Number(invoice?.subtotal) || 0));
  const type = normalizeDiscountType(invoice?.discountType);
  const storedAmount = Number(invoice?.discountAmount);
  const storedPercent = Number(invoice?.discount);

  let percent = 0;
  let amount = 0;

  if (type === 'AMOUNT') {
    amount = Number.isFinite(storedAmount) && storedAmount >= 0
      ? roundMoney(storedAmount)
      : 0;
    // Cap at just under / equal to subtotal — never exceed bill
    if (amount > subtotal) amount = subtotal;
    percent = subtotal > 0 ? roundMoney((amount / subtotal) * 100) : 0;
  } else {
    percent = Number.isFinite(storedPercent)
      ? Math.max(0, Math.min(100, storedPercent))
      : 0;
    amount = roundMoney(subtotal * (percent / 100));
  }

  const afterDiscount = roundMoney(Math.max(0, subtotal - amount));
  return {
    type,
    percent,
    amount,
    afterDiscount,
    subtotal
  };
}

/**
 * Apply discount fields from a request body onto an invoice document.
 * Returns an Error-like object via throw for validation failures.
 *
 * @param {object} invoice - mongoose invoice doc
 * @param {object} body - request body
 * @param {{ amountModeEnabled?: boolean }} options
 */
export function applyInvoiceDiscountFields(invoice, body, options = {}) {
  const amountModeEnabled = options.amountModeEnabled === true;
  const subtotal = roundMoney(Math.max(0, Number(invoice.subtotal) || 0));

  let type = normalizeDiscountType(
    body.discountType !== undefined ? body.discountType : invoice.discountType
  );

  if (!amountModeEnabled) {
    type = 'PERCENT';
  }

  if (type === 'AMOUNT') {
    const raw = body.discountAmount !== undefined
      ? Number(body.discountAmount)
      : (body.discount !== undefined ? Number(body.discount) : Number(invoice.discountAmount) || 0);

    if (!Number.isFinite(raw) || raw < 0) {
      const err = new Error('Discount amount must be a non-negative number');
      err.status = 400;
      throw err;
    }

    let amount = roundMoney(raw);
    if (amount >= subtotal && subtotal > 0) {
      const err = new Error('Discount amount must be less than the bill amount');
      err.status = 400;
      throw err;
    }
    if (subtotal <= 0) {
      amount = 0;
    }

    invoice.discountType = 'AMOUNT';
    invoice.discountAmount = amount;
    invoice.discount = subtotal > 0 ? roundMoney((amount / subtotal) * 100) : 0;
  } else {
    const raw = body.discount !== undefined
      ? Number(body.discount)
      : Number(invoice.discount) || 0;

    if (!Number.isFinite(raw) || raw < 0) {
      const err = new Error('Discount percent must be a non-negative number');
      err.status = 400;
      throw err;
    }

    const percent = Math.max(0, Math.min(100, raw));
    const amount = roundMoney(subtotal * (percent / 100));

    invoice.discountType = 'PERCENT';
    invoice.discount = percent;
    invoice.discountAmount = amount;
  }

  return resolveInvoiceDiscount(invoice);
}

/** Sync discountAmount from current type/% when subtotal changes. */
export function syncInvoiceDiscountAmount(invoice) {
  const resolved = resolveInvoiceDiscount(invoice);
  invoice.discountType = resolved.type;
  invoice.discountAmount = resolved.amount;
  if (resolved.type === 'PERCENT') {
    invoice.discount = resolved.percent;
  } else {
    // Keep stored percent as derived for legacy readers
    invoice.discount = resolved.percent;
  }
  return resolved;
}
