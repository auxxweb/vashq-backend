import { invalidateDashboardCacheForBusiness } from './dashboardCache.js';

/** Mirrors getTotalCollected() in outstandingService — actual cash received on an invoice. */
export function invoiceCollectedAmountExpression() {
  const finalAmt = { $ifNull: ['$finalAmount', 0] };
  return {
    $min: [
      finalAmt,
      {
        $add: [
          { $min: [{ $ifNull: ['$advancePayment', 0] }, finalAmt] },
          { $ifNull: ['$paymentCashAmount', 0] },
          { $ifNull: ['$paymentOnlineAmount', 0] },
          { $ifNull: ['$amountCollectedLater', 0] }
        ]
      }
    ]
  };
}

/** Outstanding balance derived from invoice fields (not the cached outstandingAmount column). */
export function invoiceOutstandingAmountExpression() {
  const finalAmt = { $ifNull: ['$finalAmount', 0] };
  return {
    $max: [
      0,
      {
        $subtract: [finalAmt, invoiceCollectedAmountExpression()]
      }
    ]
  };
}

/** Invalidate dashboard KPI cache after invoice/payment changes. */
export function invalidateDashboardForBusiness(businessId) {
  if (businessId) invalidateDashboardCacheForBusiness(businessId);
}
