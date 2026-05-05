import { roundMoney } from './invoicePayment.js';

const EPS = 0.02;

/**
 * Normalize advance payment fields when creating a job (cash / online / split).
 * @param {object} body - req.body
 * @param {number} advanceTotal - non-negative total advance
 */
export function normalizeJobAdvanceForCreate(body, advanceTotal) {
  const adv = roundMoney(Math.max(0, Number(advanceTotal) || 0));
  if (adv <= 0) {
    return {
      advancePayment: 0,
      advancePaymentMethod: 'CASH',
      advanceCashAmount: 0,
      advanceOnlineAmount: 0
    };
  }

  let method = body.advancePaymentMethod;
  if (!['CASH', 'ONLINE', 'SPLIT'].includes(method)) {
    method = 'CASH';
  }

  if (method === 'CASH') {
    return {
      advancePayment: adv,
      advancePaymentMethod: 'CASH',
      advanceCashAmount: adv,
      advanceOnlineAmount: 0
    };
  }
  if (method === 'ONLINE') {
    return {
      advancePayment: adv,
      advancePaymentMethod: 'ONLINE',
      advanceCashAmount: 0,
      advanceOnlineAmount: adv
    };
  }

  const cashProvided = body.advanceCashAmount !== undefined && body.advanceCashAmount !== null && body.advanceCashAmount !== '';
  const onlineProvided = body.advanceOnlineAmount !== undefined && body.advanceOnlineAmount !== null && body.advanceOnlineAmount !== '';

  let cash = roundMoney(Math.max(0, Math.min(Number(body.advanceCashAmount) || 0, adv)));
  let online = roundMoney(Math.max(0, Math.min(Number(body.advanceOnlineAmount) || 0, adv)));

  if (cash + online > adv + EPS) {
    const err = new Error('Advance cash plus online cannot exceed advance total');
    err.status = 400;
    throw err;
  }

  if (cashProvided && !onlineProvided) {
    online = roundMoney(Math.max(0, adv - cash));
  } else if (onlineProvided && !cashProvided) {
    cash = roundMoney(Math.max(0, adv - online));
  } else if (!cashProvided && !onlineProvided) {
    cash = 0;
    online = adv;
  }

  if (Math.abs(cash + online - adv) > EPS) {
    const err = new Error('Advance cash plus online must equal advance total');
    err.status = 400;
    throw err;
  }

  return {
    advancePayment: adv,
    advancePaymentMethod: 'SPLIT',
    advanceCashAmount: roundMoney(cash),
    advanceOnlineAmount: roundMoney(online)
  };
}
