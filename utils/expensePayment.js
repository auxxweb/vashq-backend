import { assertSettlementMatchesDue, roundMoney } from './invoicePayment.js';

export const EXPENSE_PAYMENT_EPS = 0.02;

function isCreditSettlement(mode) {
  return String(mode || '').toUpperCase() === 'CREDIT';
}

function derivePaymentStatus(amount, outstanding) {
  const amt = roundMoney(amount);
  const due = roundMoney(outstanding);
  if (due <= EXPENSE_PAYMENT_EPS) return 'PAID';
  if (due >= amt - EXPENSE_PAYMENT_EPS) return 'UNPAID';
  return 'PARTIAL';
}

function derivePaymentMethodFromChannels(cash, online) {
  const c = roundMoney(cash);
  const o = roundMoney(online);
  if (c > EXPENSE_PAYMENT_EPS && o > EXPENSE_PAYMENT_EPS) return 'SPLIT';
  if (o > EXPENSE_PAYMENT_EPS) return 'ONLINE';
  return 'CASH';
}

/**
 * Cash / online paid for an expense (outflow from pocket vs account).
 * Legacy FULL rows without split amounts infer from paymentMethod + full amount.
 * CREDIT rows always use stored paid amounts (may be 0).
 */
export function expenseCashOnline(exp) {
  if (!exp) return { cash: 0, online: 0 };
  const amt = roundMoney(Number(exp.amount) || 0);
  const pc = roundMoney(Number(exp.paymentCashAmount) || 0);
  const po = roundMoney(Number(exp.paymentOnlineAmount) || 0);
  const pm = exp.paymentMethod || 'CASH';
  const hasStored = pc + po > EXPENSE_PAYMENT_EPS;
  const credit = isCreditSettlement(exp.settlementMode);

  if (credit) {
    return { cash: pc, online: po };
  }
  if (pm === 'SPLIT') {
    if (hasStored) return { cash: pc, online: po };
    return { cash: amt, online: 0 };
  }
  if (hasStored) return { cash: pc, online: po };
  if (pm === 'ONLINE') return { cash: 0, online: amt };
  return { cash: amt, online: 0 };
}

/** Amount actually paid out (cash + online channels). */
export function expenseAmountPaid(exp) {
  const { cash, online } = expenseCashOnline(exp);
  return roundMoney(cash + online);
}

/** Sum amount + cash/online channel totals + payable outstanding for a list of expense docs. */
export function sumExpenseChannelTotals(expenses) {
  let totalAmount = 0;
  let totalCashAmount = 0;
  let totalOnlineAmount = 0;
  let totalPaidAmount = 0;
  let totalOutstandingPayable = 0;
  for (const e of expenses || []) {
    totalAmount += Number(e.amount) || 0;
    const { cash, online } = expenseCashOnline(e);
    totalCashAmount += cash;
    totalOnlineAmount += online;
    totalPaidAmount += cash + online;
    if (isCreditSettlement(e.settlementMode)) {
      totalOutstandingPayable += Number(e.outstandingAmount) || 0;
    }
  }
  return {
    totalAmount: roundMoney(totalAmount),
    totalCashAmount: roundMoney(totalCashAmount),
    totalOnlineAmount: roundMoney(totalOnlineAmount),
    totalPaidAmount: roundMoney(totalPaidAmount),
    totalOutstandingPayable: roundMoney(totalOutstandingPayable),
  };
}

/**
 * Resolve payment for FULL settlement (existing behaviour): cash/online must cover full amount.
 * @param {number} amount
 * @param {object} body
 * @param {object} [existing]
 */
export function resolveExpensePaymentFields(amount, body, existing = {}) {
  const amt = roundMoney(Math.max(0, Number(amount) || 0));
  if (amt <= 0) {
    const err = new Error('Expense amount must be greater than zero');
    err.status = 400;
    throw err;
  }

  const settlementMode = String(
    body.settlementMode !== undefined ? body.settlementMode : (existing.settlementMode || 'FULL')
  ).toUpperCase() === 'CREDIT'
    ? 'CREDIT'
    : 'FULL';

  if (settlementMode === 'CREDIT') {
    return resolveExpenseCreditPaymentFields(amt, body, existing);
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
    settlementMode: 'FULL',
    outstandingAmount: 0,
    paymentStatus: 'PAID',
    creditDueDate: null,
    paymentMethod: method,
    paymentCashAmount: roundMoney(pCash),
    paymentOnlineAmount: roundMoney(pOnline),
  };
}

/**
 * CREDIT / pay-later: paid now may be 0..amount; remainder is payable outstanding.
 */
function resolveExpenseCreditPaymentFields(amt, body, existing = {}) {
  let amountPaidNow;
  if (body.amountPaidNow !== undefined && body.amountPaidNow !== null && body.amountPaidNow !== '') {
    amountPaidNow = roundMoney(Math.max(0, Number(body.amountPaidNow) || 0));
  } else if (body.paymentCashAmount !== undefined || body.paymentOnlineAmount !== undefined) {
    // Explicit channel amounts (create/update) — do not treat paymentMethod alone as "paid 0"
    const c = body.paymentCashAmount !== undefined ? Number(body.paymentCashAmount) : 0;
    const o = body.paymentOnlineAmount !== undefined ? Number(body.paymentOnlineAmount) : 0;
    amountPaidNow = roundMoney(Math.max(0, (Number.isFinite(c) ? c : 0) + (Number.isFinite(o) ? o : 0)));
  } else if (
    isCreditSettlement(existing.settlementMode) ||
    (Number(existing.paymentCashAmount) || 0) + (Number(existing.paymentOnlineAmount) || 0) > EXPENSE_PAYMENT_EPS
  ) {
    // Preserve paid-to-date on update when amountPaidNow is omitted
    amountPaidNow = roundMoney(
      (Number(existing.paymentCashAmount) || 0) + (Number(existing.paymentOnlineAmount) || 0)
    );
  } else {
    amountPaidNow = 0;
  }

  if (amountPaidNow > amt + EXPENSE_PAYMENT_EPS) {
    const err = new Error('Amount paid now cannot exceed the expense amount');
    err.status = 400;
    throw err;
  }
  amountPaidNow = roundMoney(Math.min(amountPaidNow, amt));

  let creditDueDate = null;
  if (body.creditDueDate !== undefined) {
    if (body.creditDueDate === null || body.creditDueDate === '') {
      creditDueDate = null;
    } else {
      const d = new Date(body.creditDueDate);
      if (Number.isNaN(d.getTime())) {
        const err = new Error('Invalid pay-later due date');
        err.status = 400;
        throw err;
      }
      creditDueDate = d;
    }
  } else if (existing.creditDueDate) {
    creditDueDate = existing.creditDueDate;
  }

  let pCash = 0;
  let pOnline = 0;
  let method = 'CASH';

  if (amountPaidNow <= EXPENSE_PAYMENT_EPS) {
    method = 'CASH';
    pCash = 0;
    pOnline = 0;
  } else {
    method = body.paymentMethod !== undefined ? body.paymentMethod : (existing.paymentMethod || 'CASH');
    if (!['CASH', 'ONLINE', 'SPLIT'].includes(method)) {
      const err = new Error('Invalid payment method');
      err.status = 400;
      throw err;
    }
    if (method === 'CASH') {
      pCash = amountPaidNow;
      pOnline = 0;
    } else if (method === 'ONLINE') {
      pCash = 0;
      pOnline = amountPaidNow;
    } else {
      const cashProvided = body.paymentCashAmount !== undefined;
      const onlineProvided = body.paymentOnlineAmount !== undefined;
      pCash = cashProvided ? roundMoney(Math.max(0, Number(body.paymentCashAmount) || 0)) : 0;
      pOnline = onlineProvided ? roundMoney(Math.max(0, Number(body.paymentOnlineAmount) || 0)) : 0;
      if (cashProvided && !onlineProvided) {
        pCash = roundMoney(Math.min(pCash, amountPaidNow));
        pOnline = roundMoney(amountPaidNow - pCash);
      } else if (onlineProvided && !cashProvided) {
        pOnline = roundMoney(Math.min(pOnline, amountPaidNow));
        pCash = roundMoney(amountPaidNow - pOnline);
      } else if (!cashProvided && !onlineProvided) {
        // Keep existing split proportions when only method/amountPaidNow context is inferred
        const prevCash = roundMoney(Number(existing.paymentCashAmount) || 0);
        const prevOnline = roundMoney(Number(existing.paymentOnlineAmount) || 0);
        if (Math.abs(prevCash + prevOnline - amountPaidNow) <= EXPENSE_PAYMENT_EPS) {
          pCash = prevCash;
          pOnline = prevOnline;
        } else {
          pCash = 0;
          pOnline = amountPaidNow;
        }
      }
      try {
        assertSettlementMatchesDue('SPLIT', amountPaidNow, pCash, pOnline);
      } catch (e) {
        const err = new Error('For split payment, cash + online must equal the amount paying now');
        err.status = 400;
        throw err;
      }
    }
  }

  const outstandingAmount = roundMoney(Math.max(0, amt - amountPaidNow));
  return {
    settlementMode: 'CREDIT',
    outstandingAmount,
    paymentStatus: derivePaymentStatus(amt, outstandingAmount),
    creditDueDate,
    paymentMethod: method,
    paymentCashAmount: roundMoney(pCash),
    paymentOnlineAmount: roundMoney(pOnline),
  };
}

/**
 * Apply an additional payment toward outstanding payable on a CREDIT expense.
 * Does not change FULL expenses.
 */
export function applyExpensePayablePayment(expense, body = {}) {
  if (!expense || !isCreditSettlement(expense.settlementMode)) {
    const err = new Error('Only pay-later expenses can receive payable payments');
    err.status = 400;
    throw err;
  }
  const amt = roundMoney(Number(expense.amount) || 0);
  let due = roundMoney(Number(expense.outstandingAmount) || 0);
  if (due <= EXPENSE_PAYMENT_EPS) {
    const err = new Error('This expense has no outstanding amount');
    err.status = 400;
    throw err;
  }

  let payAmount;
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    payAmount = roundMoney(Math.max(0, Number(body.amount) || 0));
  } else {
    const c = Number(body.paymentCashAmount) || 0;
    const o = Number(body.paymentOnlineAmount) || 0;
    payAmount = roundMoney(Math.max(0, c + o));
  }
  if (payAmount <= EXPENSE_PAYMENT_EPS) {
    const err = new Error('Enter a payment amount greater than zero');
    err.status = 400;
    throw err;
  }
  if (payAmount > due + EXPENSE_PAYMENT_EPS) {
    const err = new Error('Payment cannot exceed outstanding amount');
    err.status = 400;
    throw err;
  }
  payAmount = roundMoney(Math.min(payAmount, due));

  const method = body.paymentMethod || 'CASH';
  if (!['CASH', 'ONLINE', 'SPLIT'].includes(method)) {
    const err = new Error('Invalid payment method');
    err.status = 400;
    throw err;
  }

  let addCash = 0;
  let addOnline = 0;
  if (method === 'CASH') {
    addCash = payAmount;
  } else if (method === 'ONLINE') {
    addOnline = payAmount;
  } else {
    const cashProvided = body.paymentCashAmount !== undefined;
    const onlineProvided = body.paymentOnlineAmount !== undefined;
    addCash = cashProvided ? roundMoney(Math.max(0, Number(body.paymentCashAmount) || 0)) : 0;
    addOnline = onlineProvided ? roundMoney(Math.max(0, Number(body.paymentOnlineAmount) || 0)) : 0;
    if (cashProvided && !onlineProvided) {
      addCash = roundMoney(Math.min(addCash, payAmount));
      addOnline = roundMoney(payAmount - addCash);
    } else if (onlineProvided && !cashProvided) {
      addOnline = roundMoney(Math.min(addOnline, payAmount));
      addCash = roundMoney(payAmount - addOnline);
    } else if (!cashProvided && !onlineProvided) {
      addCash = 0;
      addOnline = payAmount;
    }
    try {
      assertSettlementMatchesDue('SPLIT', payAmount, addCash, addOnline);
    } catch (e) {
      const err = new Error('For split payment, cash + online must equal the payment amount');
      err.status = 400;
      throw err;
    }
  }

  const nextCash = roundMoney((Number(expense.paymentCashAmount) || 0) + addCash);
  const nextOnline = roundMoney((Number(expense.paymentOnlineAmount) || 0) + addOnline);
  const outstandingAmount = roundMoney(Math.max(0, amt - nextCash - nextOnline));

  expense.paymentCashAmount = nextCash;
  expense.paymentOnlineAmount = nextOnline;
  expense.paymentMethod = derivePaymentMethodFromChannels(nextCash, nextOnline);
  expense.outstandingAmount = outstandingAmount;
  expense.paymentStatus = derivePaymentStatus(amt, outstandingAmount);
  return expense;
}

/** Mongo expression: amount paid out for dashboard / aggregates (FULL unchanged via fallback). */
export function expensePaidAmountAggregationExpr() {
  return {
    $let: {
      vars: {
        paid: {
          $add: [
            { $ifNull: ['$paymentCashAmount', 0] },
            { $ifNull: ['$paymentOnlineAmount', 0] }
          ]
        }
      },
      in: {
        $cond: [
          { $gt: ['$$paid', 0.01] },
          '$$paid',
          {
            $cond: [
              { $eq: ['$settlementMode', 'CREDIT'] },
              0,
              { $ifNull: ['$amount', 0] }
            ]
          }
        ]
      }
    }
  };
}

/**
 * Query fragment for payment status filter on expense list/report.
 * @param {string} status ALL | OUTSTANDING | PAID
 * @returns {object|null} Mongo filter to merge into the query, or null for ALL
 */
export function expensePaymentStatusQuery(status) {
  const key = String(status || 'ALL').toUpperCase();
  if (key === 'OUTSTANDING') {
    return {
      settlementMode: 'CREDIT',
      outstandingAmount: { $gt: EXPENSE_PAYMENT_EPS },
    };
  }
  if (key === 'PAID') {
    // Fully paid: not credit, or credit with no meaningful outstanding
    return {
      $or: [
        { settlementMode: { $ne: 'CREDIT' } },
        { outstandingAmount: { $lte: EXPENSE_PAYMENT_EPS } },
        { outstandingAmount: { $exists: false } },
        { outstandingAmount: null },
      ],
    };
  }
  return null;
}

