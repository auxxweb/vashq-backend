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
 * Never count more than balance-due at checkout (advance is counted separately).
 * Scales cash/online proportionally when stored amounts exceed the due.
 */
export function capSettlementChannelsToBalanceDue(cash, online, balanceDue) {
  const due = roundMoney(Math.max(0, Number(balanceDue) || 0));
  let c = roundMoney(Math.max(0, Number(cash) || 0));
  let o = roundMoney(Math.max(0, Number(online) || 0));
  if (due <= EPS) return { cash: 0, online: 0 };
  const total = roundMoney(c + o);
  if (total <= due + EPS) return { cash: c, online: o };
  if (total <= EPS) return { cash: due, online: 0 };
  const scale = due / total;
  c = roundMoney(c * scale);
  o = roundMoney(due - c);
  return { cash: c, online: o };
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
 * Stored paymentCash/Online are capped to balance due so advance is never double-counted.
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
  if (balanceDue <= EPS) {
    return { cash: 0, online: 0 };
  }

  const pc = roundMoney(Number(inv.paymentCashAmount) || 0);
  const po = roundMoney(Number(inv.paymentOnlineAmount) || 0);
  const pm = inv.paymentMethod || 'CASH';
  const hasStored = pc + po > EPS;

  let cash;
  let online;
  if (pm === 'SPLIT') {
    if (hasStored) {
      cash = pc;
      online = po;
    } else {
      cash = balanceDue;
      online = 0;
    }
  } else if (hasStored) {
    cash = pc;
    online = po;
  } else if (pm === 'ONLINE') {
    cash = 0;
    online = balanceDue;
  } else {
    cash = balanceDue;
    online = 0;
  }

  return capSettlementChannelsToBalanceDue(cash, online, balanceDue);
}

export function invoiceSettlementCashOnlineByMode(inv) {
  const base = invoiceSettlementCashOnline(inv);
  const modeSplit = onlineAmountByMode(base.online, inv?.onlinePaymentMode);
  return { ...base, ...modeSplit };
}

/**
 * MongoDB aggregation stages: compute settleCash / settleOnline / settleUpi / settleCard.
 * Run after filters; expects fields finalAmount, advancePayment, paymentMethod, paymentCashAmount, paymentOnlineAmount, paymentStatus, onlinePaymentMode.
 * Caps settle amounts to balance due so advances are not double-counted in cash-received reports.
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
        _rawSettleCash: {
          $cond: [
            { $lte: ['$_balanceDue', 0.02] },
            0,
            {
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
            }
          ]
        },
        _rawSettleOnline: {
          $cond: [
            { $lte: ['$_balanceDue', 0.02] },
            0,
            {
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
          ]
        }
      }
    },
    {
      $addFields: {
        _rawSettleTotal: { $add: ['$_rawSettleCash', '$_rawSettleOnline'] }
      }
    },
    {
      $addFields: {
        settleCash: {
          $cond: [
            { $lte: ['$_balanceDue', 0.02] },
            0,
            {
              $cond: [
                { $lte: ['$_rawSettleTotal', { $add: ['$_balanceDue', 0.02] }] },
                '$_rawSettleCash',
                {
                  $cond: [
                    { $lte: ['$_rawSettleTotal', 0.02] },
                    '$_balanceDue',
                    {
                      $round: [
                        {
                          $multiply: [
                            '$_rawSettleCash',
                            { $divide: ['$_balanceDue', '$_rawSettleTotal'] }
                          ]
                        },
                        2
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    },
    {
      $addFields: {
        settleOnline: {
          $cond: [
            { $lte: ['$_balanceDue', 0.02] },
            0,
            {
              $cond: [
                { $lte: ['$_rawSettleTotal', { $add: ['$_balanceDue', 0.02] }] },
                '$_rawSettleOnline',
                {
                  $cond: [
                    { $lte: ['$_rawSettleTotal', 0.02] },
                    0,
                    {
                      $round: [
                        { $subtract: ['$_balanceDue', '$settleCash'] },
                        2
                      ]
                    }
                  ]
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
