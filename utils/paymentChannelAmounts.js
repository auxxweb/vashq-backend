import { roundMoney } from './invoicePayment.js';

const EPS = 0.02;

/**
 * Split an online amount into UPI vs Card using onlinePaymentMode (default UPI).
 * @returns {{ upi: number, card: number }}
 */
export function onlineAmountByMode(onlineAmount, onlinePaymentMode) {
  const online = roundMoney(onlineAmount);
  if (online <= EPS) return { upi: 0, card: 0 };
  if (String(onlinePaymentMode || '').toUpperCase() === 'CARD') {
    return { upi: 0, card: online };
  }
  return { upi: online, card: 0 };
}

/**
 * Cash + online for a credit payment collection row.
 * Legacy rows without split amounts infer from paymentMethod.
 *
 * @param {object} c - PaymentCollection lean doc (amount, paymentMethod, paymentCashAmount, paymentOnlineAmount)
 * @returns {{ cash: number, online: number }}
 */
export function collectionCashOnline(c) {
  if (!c) return { cash: 0, online: 0 };
  const amt = roundMoney(Number(c.amount) || 0);
  const pc = roundMoney(Number(c.paymentCashAmount) || 0);
  const po = roundMoney(Number(c.paymentOnlineAmount) || 0);
  const pm = c.paymentMethod || 'CASH';
  const hasStored = pc + po > EPS;

  if (pm === 'SPLIT') {
    if (hasStored) return { cash: pc, online: po };
    return { cash: amt, online: 0 };
  }
  if (hasStored) return { cash: pc, online: po };
  if (pm === 'ONLINE') return { cash: 0, online: amt };
  return { cash: amt, online: 0 };
}

/** Cash + online + UPI/Card split for a collection row. */
export function collectionCashOnlineByMode(c) {
  const base = collectionCashOnline(c);
  const modeSplit = onlineAmountByMode(base.online, c?.onlinePaymentMode);
  return { ...base, ...modeSplit };
}

/**
 * Cash + online collected at credit checkout (excludes advance).
 * Uses stored split amounts when present; otherwise infers from paymentMethod.
 */
export function creditCheckoutCashOnline(inv) {
  if (!inv) return { cash: 0, online: 0 };
  const pc = roundMoney(Number(inv.paymentCashAmount) || 0);
  const po = roundMoney(Number(inv.paymentOnlineAmount) || 0);
  const settled = roundMoney(pc + po);
  const pm = inv.paymentMethod || 'CASH';
  const hasStored = settled > EPS;

  if (pm === 'SPLIT') {
    if (hasStored) return { cash: pc, online: po };
    return { cash: 0, online: 0 };
  }
  if (hasStored) return { cash: pc, online: po };
  if (pm === 'ONLINE') return { cash: 0, online: settled };
  return { cash: settled, online: 0 };
}

export function creditCheckoutCashOnlineByMode(inv) {
  const base = creditCheckoutCashOnline(inv);
  const modeSplit = onlineAmountByMode(base.online, inv?.onlinePaymentMode);
  return { ...base, ...modeSplit };
}

/**
 * Cash + online amounts collected at invoice settlement (checkout only).
 * Uses balance due = finalAmount - min(advancePayment, finalAmount), not full final amount.
 * For legacy rows with no stored split amounts, infers from paymentMethod.
 *
 * @param {object} inv - invoice lean doc (finalAmount, advancePayment, paymentMethod, paymentCashAmount, paymentOnlineAmount, paymentStatus)
 * @returns {{ cash: number, online: number }}
 */
export function invoiceSettlementCashOnline(inv) {
  if (!inv || inv.paymentStatus !== 'RECEIVED') {
    return { cash: 0, online: 0 };
  }
  const fa = roundMoney(Number(inv.finalAmount) || 0);
  const advRaw = roundMoney(Number(inv.advancePayment) || 0);
  const effAdv = roundMoney(Math.min(advRaw, fa));
  const balanceDue = roundMoney(Math.max(0, fa - effAdv));
  const pc = roundMoney(Number(inv.paymentCashAmount) || 0);
  const po = roundMoney(Number(inv.paymentOnlineAmount) || 0);
  const pm = inv.paymentMethod || 'CASH';
  const hasStored = pc + po > EPS;

  if (pm === 'SPLIT') {
    if (hasStored) return { cash: pc, online: po };
    return { cash: balanceDue, online: 0 };
  }
  if (hasStored) return { cash: pc, online: po };
  if (pm === 'ONLINE') return { cash: 0, online: balanceDue };
  return { cash: balanceDue, online: 0 };
}

export function invoiceSettlementCashOnlineByMode(inv) {
  const base = invoiceSettlementCashOnline(inv);
  const modeSplit = onlineAmountByMode(base.online, inv?.onlinePaymentMode);
  return { ...base, ...modeSplit };
}

/**
 * MongoDB aggregation stages: compute settleCash / settleOnline / settleUpi / settleCard.
 * Run after filters; expects fields finalAmount, advancePayment, paymentMethod, paymentCashAmount, paymentOnlineAmount, paymentStatus, onlinePaymentMode.
 */
export function invoiceSettlementAggregationStages() {
  return [
    {
      $addFields: {
        _effAdv: {
          $min: [{ $ifNull: ['$advancePayment', 0] }, { $ifNull: ['$finalAmount', 0] }]
        }
      }
    },
    {
      $addFields: {
        _balanceDue: {
          $max: [
            0,
            {
              $subtract: [{ $ifNull: ['$finalAmount', 0] }, '$_effAdv']
            }
          ]
        },
        _pc: { $ifNull: ['$paymentCashAmount', 0] },
        _po: { $ifNull: ['$paymentOnlineAmount', 0] }
      }
    },
    {
      $addFields: {
        settleCash: {
          $cond: [
            { $eq: ['$paymentMethod', 'SPLIT'] },
            {
              $cond: [
                { $gt: [{ $add: ['$_pc', '$_po'] }, 0.01] },
                '$_pc',
                '$_balanceDue'
              ]
            },
            {
              $cond: [
                { $gt: [{ $add: ['$_pc', '$_po'] }, 0.01] },
                '$_pc',
                {
                  $cond: [{ $eq: ['$paymentMethod', 'ONLINE'] }, 0, '$_balanceDue']
                }
              ]
            }
          ]
        },
        settleOnline: {
          $cond: [
            { $eq: ['$paymentMethod', 'SPLIT'] },
            {
              $cond: [
                { $gt: [{ $add: ['$_pc', '$_po'] }, 0.01] },
                '$_po',
                0
              ]
            },
            {
              $cond: [
                { $gt: [{ $add: ['$_pc', '$_po'] }, 0.01] },
                '$_po',
                {
                  $cond: [{ $eq: ['$paymentMethod', 'ONLINE'] }, '$_balanceDue', 0]
                }
              ]
            }
          ]
        }
      }
    },
    {
      $addFields: {
        settleUpi: {
          $cond: [
            { $eq: [{ $toUpper: { $ifNull: ['$onlinePaymentMode', 'UPI'] } }, 'CARD'] },
            0,
            '$settleOnline'
          ]
        },
        settleCard: {
          $cond: [
            { $eq: [{ $toUpper: { $ifNull: ['$onlinePaymentMode', 'UPI'] } }, 'CARD'] },
            '$settleOnline',
            0
          ]
        }
      }
    }
  ];
}
