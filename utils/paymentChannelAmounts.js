import { roundMoney } from './invoicePayment.js';

const EPS = 0.02;

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

/**
 * MongoDB aggregation stages: compute settleCash / settleOnline on each invoice doc.
 * Run after filters; expects fields finalAmount, advancePayment, paymentMethod, paymentCashAmount, paymentOnlineAmount, paymentStatus.
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
    }
  ];
}
