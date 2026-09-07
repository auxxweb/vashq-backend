/**
 * Purchase bill math:
 * line subtotal → discount → net goods → (optional additional charges before/after tax) → grand total.
 *
 * additionalChargesMode:
 *   - before_tax: charges join the tax base (e.g. freight on taxable invoice)
 *   - after_tax: charges outside GST (e.g. courier out of bill) — default
 *
 * netGoodsAmount stays goods-only (for inventory / avg cost). Additional charges
 * affect payable grandTotal only.
 */

export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @param {object} opts
 * @param {number} opts.subtotal
 * @param {'amount'|'percent'} [opts.discountType]
 * @param {number} [opts.discountValue]
 * @param {'none'|'included'|'excluded'} [opts.taxMode]
 * @param {number} [opts.taxPercent]
 * @param {number} [opts.additionalCharges]
 * @param {'before_tax'|'after_tax'} [opts.additionalChargesMode]
 */
export function computePurchaseTotals({
  subtotal = 0,
  discountType = 'amount',
  discountValue = 0,
  taxMode = 'none',
  taxPercent = 0,
  additionalCharges = 0,
  additionalChargesMode = 'after_tax'
} = {}) {
  const sub = roundMoney(Math.max(0, Number(subtotal) || 0));
  const dtype = discountType === 'percent' ? 'percent' : 'amount';
  const dval = Math.max(0, Number(discountValue) || 0);
  let discountAmount = 0;
  if (dtype === 'percent') {
    discountAmount = roundMoney(sub * (Math.min(100, dval) / 100));
  } else {
    discountAmount = roundMoney(Math.min(sub, dval));
  }
  const netGoodsAmount = roundMoney(Math.max(0, sub - discountAmount));

  const addl = roundMoney(Math.max(0, Number(additionalCharges) || 0));
  const addlMode = additionalChargesMode === 'before_tax' ? 'before_tax' : 'after_tax';

  const mode = ['included', 'excluded'].includes(String(taxMode)) ? String(taxMode) : 'none';
  const tPct = Math.max(0, Number(taxPercent) || 0);
  let taxAmount = 0;
  let grandTotal = netGoodsAmount;

  if (mode === 'none' || tPct <= 0) {
    taxAmount = 0;
    grandTotal = roundMoney(netGoodsAmount + addl);
  } else if (mode === 'excluded') {
    if (addlMode === 'before_tax') {
      const taxable = roundMoney(netGoodsAmount + addl);
      taxAmount = roundMoney(taxable * (tPct / 100));
      grandTotal = roundMoney(taxable + taxAmount);
    } else {
      taxAmount = roundMoney(netGoodsAmount * (tPct / 100));
      grandTotal = roundMoney(netGoodsAmount + taxAmount + addl);
    }
  } else if (mode === 'included') {
    if (addlMode === 'before_tax') {
      const inclusive = roundMoney(netGoodsAmount + addl);
      const base = roundMoney(inclusive / (1 + tPct / 100));
      taxAmount = roundMoney(inclusive - base);
      grandTotal = inclusive;
    } else {
      const base = roundMoney(netGoodsAmount / (1 + tPct / 100));
      taxAmount = roundMoney(netGoodsAmount - base);
      grandTotal = roundMoney(netGoodsAmount + addl);
    }
  }

  return {
    subtotal: sub,
    discountType: dtype,
    discountValue: dval,
    discountAmount,
    netGoodsAmount,
    additionalCharges: addl,
    additionalChargesMode: addlMode,
    taxMode: mode,
    taxPercent: tPct,
    taxAmount,
    grandTotal
  };
}
