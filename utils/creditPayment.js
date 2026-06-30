import { balanceDue, effectiveAdvance, roundMoney } from './invoicePayment.js';

export { roundMoney, effectiveAdvance, balanceDue };

const EPS = 0.02;

export function isCreditSettlementMode(body) {
  return String(body?.settlementMode || '').toUpperCase() === 'CREDIT';
}

/**
 * Partial checkout at credit close: settlement amounts may be less than balance due.
 */
export function assertPartialSettlementValid(paymentMethod, balance, cash, online) {
  const b = roundMoney(balance);
  const c = roundMoney(cash);
  const o = roundMoney(online);

  if (c < -EPS || o < -EPS) {
    const err = new Error('Payment amounts cannot be negative');
    err.status = 400;
    throw err;
  }
  if (c + o > b + EPS) {
    const err = new Error('Payment cannot exceed balance due');
    err.status = 400;
    throw err;
  }

  if (paymentMethod === 'SPLIT') {
    return;
  }
  if (paymentMethod === 'CASH') {
    if (o > EPS) {
      const err = new Error('Online amount must be zero for cash payment');
      err.status = 400;
      throw err;
    }
    return;
  }
  if (paymentMethod === 'ONLINE') {
    if (c > EPS) {
      const err = new Error('Cash amount must be zero for online payment');
      err.status = 400;
      throw err;
    }
  }
}

/**
 * Normalize checkout settlement fields for credit close (partial allowed).
 */
export function normalizeCreditCheckoutPayment(invoice, body = {}) {
  const final = roundMoney(invoice.finalAmount);
  const adv = Number(invoice.advancePayment) || 0;
  const due = balanceDue(final, adv);
  const method = body.paymentMethod !== undefined ? body.paymentMethod : invoice.paymentMethod;

  let pCash = body.paymentCashAmount !== undefined
    ? Number(body.paymentCashAmount)
    : Number(invoice.paymentCashAmount) || 0;
  let pOnline = body.paymentOnlineAmount !== undefined
    ? Number(body.paymentOnlineAmount)
    : Number(invoice.paymentOnlineAmount) || 0;

  if (method === 'CASH') {
    pCash = roundMoney(Math.max(0, Math.min(pCash, due)));
    pOnline = 0;
  } else if (method === 'ONLINE') {
    pCash = 0;
    pOnline = roundMoney(Math.max(0, Math.min(pOnline, due)));
  } else if (method === 'SPLIT') {
    pCash = roundMoney(Math.max(0, Math.min(pCash, due)));
    pOnline = roundMoney(Math.max(0, Math.min(pOnline, due)));
    if (pCash + pOnline > due + EPS) {
      const err = new Error('Cash plus online cannot exceed balance due');
      err.status = 400;
      throw err;
    }
    const cashProvided = body.paymentCashAmount !== undefined;
    const onlineProvided = body.paymentOnlineAmount !== undefined;
    if (cashProvided && !onlineProvided) {
      pOnline = roundMoney(Math.max(0, due - pCash));
      if (pCash + pOnline > due + EPS) {
        pOnline = roundMoney(Math.max(0, due - pCash));
      }
    } else if (onlineProvided && !cashProvided) {
      pCash = roundMoney(Math.max(0, due - pOnline));
    }
    pCash = roundMoney(Math.max(0, Math.min(pCash, due)));
    pOnline = roundMoney(Math.max(0, Math.min(pOnline, due - pCash)));
  }

  invoice.paymentCashAmount = roundMoney(pCash);
  invoice.paymentOnlineAmount = roundMoney(pOnline);
  if (body.paymentMethod !== undefined || body.paymentCashAmount !== undefined || body.paymentOnlineAmount !== undefined) {
    invoice.paymentMethod = method;
  }

  assertPartialSettlementValid(
    invoice.paymentMethod,
    due,
    invoice.paymentCashAmount,
    invoice.paymentOnlineAmount
  );
}

/**
 * Normalize collection payment fields (amount applied to outstanding invoices).
 */
export function normalizeCollectionPayment(amount, paymentMethod, body = {}) {
  const total = roundMoney(amount);
  if (total <= EPS) {
    const err = new Error('Collection amount must be greater than zero');
    err.status = 400;
    throw err;
  }

  let pCash = body.paymentCashAmount !== undefined ? Number(body.paymentCashAmount) : 0;
  let pOnline = body.paymentOnlineAmount !== undefined ? Number(body.paymentOnlineAmount) : 0;

  if (paymentMethod === 'CASH') {
    pCash = total;
    pOnline = 0;
  } else if (paymentMethod === 'ONLINE') {
    pCash = 0;
    pOnline = total;
  } else if (paymentMethod === 'SPLIT') {
    pCash = roundMoney(Math.max(0, pCash));
    pOnline = roundMoney(Math.max(0, pOnline));
    if (Math.abs(pCash + pOnline - total) > EPS) {
      const err = new Error('Cash plus online must equal collection amount');
      err.status = 400;
      throw err;
    }
  }

  assertPartialSettlementValid(paymentMethod, total, pCash, pOnline);

  return {
    paymentMethod,
    paymentCashAmount: roundMoney(pCash),
    paymentOnlineAmount: roundMoney(pOnline),
    amount: total
  };
}

export function parseCreditDueDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const err = new Error('Invalid credit due date');
    err.status = 400;
    throw err;
  }
  return d;
}
