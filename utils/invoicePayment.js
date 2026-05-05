/** Invoice balance: advance is capped by final amount; balance due is what customer pays at settlement. */

export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function effectiveAdvance(finalAmount, advancePayment) {
  const f = Math.max(0, Number(finalAmount) || 0);
  const a = Math.max(0, Number(advancePayment) || 0);
  return Math.min(a, f);
}

export function balanceDue(finalAmount, advancePayment) {
  const f = Math.max(0, Number(finalAmount) || 0);
  return roundMoney(f - effectiveAdvance(finalAmount, advancePayment));
}

const EPS = 0.02;

export function assertSettlementMatchesDue(paymentMethod, balance, cash, online) {
  const b = roundMoney(balance);
  const c = roundMoney(cash);
  const o = roundMoney(online);
  if (paymentMethod === 'SPLIT') {
    if (c < -EPS || o < -EPS) {
      throw new Error('Split amounts cannot be negative');
    }
    if (c + o > b + EPS) {
      throw new Error('Cash plus online cannot exceed balance due');
    }
    if (Math.abs(c + o - b) > EPS) {
      throw new Error('Cash plus online must equal balance due');
    }
    return;
  }
  if (paymentMethod === 'CASH') {
    if (Math.abs(c - b) > EPS || o > EPS) {
      throw new Error('Cash payment must match balance due');
    }
    return;
  }
  if (paymentMethod === 'ONLINE') {
    if (Math.abs(o - b) > EPS || c > EPS) {
      throw new Error('Online payment must match balance due');
    }
  }
}

export function normalizeInvoicePaymentFields(invoice, body) {
  const final = roundMoney(invoice.finalAmount);
  const adv = Number(invoice.advancePayment) || 0;
  const due = balanceDue(final, adv);
  const method = body.paymentMethod !== undefined ? body.paymentMethod : invoice.paymentMethod;

  let pCash = body.paymentCashAmount !== undefined ? Number(body.paymentCashAmount) : Number(invoice.paymentCashAmount) || 0;
  let pOnline = body.paymentOnlineAmount !== undefined ? Number(body.paymentOnlineAmount) : Number(invoice.paymentOnlineAmount) || 0;

  if (method === 'CASH') {
    pCash = due;
    pOnline = 0;
  } else if (method === 'ONLINE') {
    pCash = 0;
    pOnline = due;
  } else if (method === 'SPLIT') {
    const cashProvided = body.paymentCashAmount !== undefined;
    const onlineProvided = body.paymentOnlineAmount !== undefined;
    if (!cashProvided && !onlineProvided) {
      pCash = roundMoney(Number(invoice.paymentCashAmount) || 0);
      pOnline = roundMoney(Number(invoice.paymentOnlineAmount) || 0);
      if (Math.abs(pCash + pOnline - due) > EPS) {
        pCash = 0;
        pOnline = due;
      }
    } else {
      pCash = roundMoney(Math.max(0, Math.min(pCash, due)));
      pOnline = roundMoney(Math.max(0, Math.min(pOnline, due)));
      if (pCash + pOnline > due + EPS) {
        const err = new Error('Cash plus online cannot exceed balance due');
        err.status = 400;
        throw err;
      }
      if (cashProvided && !onlineProvided) {
        pOnline = roundMoney(Math.max(0, due - pCash));
      } else if (onlineProvided && !cashProvided) {
        pCash = roundMoney(Math.max(0, due - pOnline));
      }
      if (Math.abs(pCash + pOnline - due) > EPS) {
        const err = new Error('Cash plus online must equal balance due');
        err.status = 400;
        throw err;
      }
    }
  }

  invoice.paymentCashAmount = roundMoney(pCash);
  invoice.paymentOnlineAmount = roundMoney(pOnline);
}
