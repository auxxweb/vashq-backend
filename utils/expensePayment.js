import { assertSettlementMatchesDue, roundMoney } from './invoicePayment.js';

export const EXPENSE_PAYMENT_EPS = 0.02;

/**
 * Cash / online paid for an expense (outflow from pocket vs account).
 * Legacy rows without split amounts infer from paymentMethod.
 */
export function expenseCashOnline(exp) {
  if (!exp) return { cash: 0, online: 0 };
  const amt = roundMoney(Number(exp.amount) || 0);
  const pc = roundMoney(Number(exp.paymentCashAmount) || 0);
  const po = roundMoney(Number(exp.paymentOnlineAmount) || 0);
  const pm = exp.paymentMethod || 'CASH';
  const hasStored = pc + po > EXPENSE_PAYMENT_EPS;

  if (pm === 'SPLIT') {
    if (hasStored) return { cash: pc, online: po };
    return { cash: amt, online: 0 };
  }
  if (hasStored) return { cash: pc, online: po };
  if (pm === 'ONLINE') return { cash: 0, online: amt };
  return { cash: amt, online: 0 };
}

/** Sum amount + cash/online channel totals for a list of expense docs. */
export function sumExpenseChannelTotals(expenses) {
  let totalAmount = 0;
  let totalCashAmount = 0;
  let totalOnlineAmount = 0;
  for (const e of expenses || []) {
    totalAmount += Number(e.amount) || 0;
    const { cash, online } = expenseCashOnline(e);
    totalCashAmount += cash;
    totalOnlineAmount += online;
  }
  return {
    totalAmount: roundMoney(totalAmount),
    totalCashAmount: roundMoney(totalCashAmount),
    totalOnlineAmount: roundMoney(totalOnlineAmount),
  };
}

/**
 * @param {number} amount - total expense amount
 * @param {object} body - paymentMethod, paymentCashAmount, paymentOnlineAmount
 * @param {object} [existing] - existing expense doc on update
 */
export function resolveExpensePaymentFields(amount, body, existing = {}) {
  const amt = roundMoney(Math.max(0, Number(amount) || 0));
  if (amt <= 0) {
    const err = new Error('Expense amount must be greater than zero');
    err.status = 400;
    throw err;
  }

  const method = body.paymentMethod !== undefined ? body.paymentMethod : (existing.paymentMethod || 'CASH');
  if (!['CASH', 'ONLINE', 'SPLIT'].includes(method)) {
    const err = new Error('Invalid payment method');
    err.status = 400;
    throw err;
  }

  let pCash = body.paymentCashAmount !== undefined ? Number(body.paymentCashAmount) : Number(existing.paymentCashAmount) || 0;
  let pOnline = body.paymentOnlineAmount !== undefined ? Number(body.paymentOnlineAmount) : Number(existing.paymentOnlineAmount) || 0;
  if (!Number.isFinite(pCash)) pCash = 0;
  if (!Number.isFinite(pOnline)) pOnline = 0;

  if (method === 'CASH') {
    pCash = amt;
    pOnline = 0;
  } else if (method === 'ONLINE') {
    pCash = 0;
    pOnline = amt;
  } else if (method === 'SPLIT') {
    const cashProvided = body.paymentCashAmount !== undefined;
    const onlineProvided = body.paymentOnlineAmount !== undefined;
    if (!cashProvided && !onlineProvided) {
      pCash = roundMoney(Number(existing.paymentCashAmount) || 0);
      pOnline = roundMoney(Number(existing.paymentOnlineAmount) || 0);
      if (Math.abs(pCash + pOnline - amt) > EXPENSE_PAYMENT_EPS) {
        pCash = 0;
        pOnline = amt;
      }
    } else {
      pCash = roundMoney(Math.max(0, pCash));
      pOnline = roundMoney(Math.max(0, pOnline));
      if (pCash > amt + EXPENSE_PAYMENT_EPS || pOnline > amt + EXPENSE_PAYMENT_EPS) {
        const err = new Error('Cash or online amount cannot exceed expense amount');
        err.status = 400;
        throw err;
      }
      if (cashProvided && !onlineProvided) {
        pCash = roundMoney(Math.min(pCash, amt));
        pOnline = roundMoney(amt - pCash);
      } else if (onlineProvided && !cashProvided) {
        pOnline = roundMoney(Math.min(pOnline, amt));
        pCash = roundMoney(amt - pOnline);
      } else if (pCash + pOnline > amt + EXPENSE_PAYMENT_EPS) {
        const err = new Error('Cash plus online cannot exceed expense amount');
        err.status = 400;
        throw err;
      }
    }
  }

  try {
    assertSettlementMatchesDue(method, amt, pCash, pOnline);
  } catch (e) {
    const err = new Error(
      method === 'SPLIT'
        ? 'Cash plus online must equal the expense amount'
        : (e.message || 'Invalid payment split')
    );
    err.status = 400;
    throw err;
  }

  return {
    paymentMethod: method,
    paymentCashAmount: roundMoney(pCash),
    paymentOnlineAmount: roundMoney(pOnline),
  };
}
