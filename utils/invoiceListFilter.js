const EPS = 0.02;

const PAID_OUTSTANDING_OK = {
  $or: [
    { outstandingAmount: { $lte: EPS } },
    { outstandingAmount: { $exists: false } },
    { outstandingAmount: null }
  ]
};

/** Mongo filter clause for invoice list status (paid | pending | outstanding | overdue). */
export function invoiceStatusFilterClause(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s || s === 'all') return null;

  if (s === 'paid') {
    return {
      paymentStatus: 'RECEIVED',
      ...PAID_OUTSTANDING_OK
    };
  }

  if (s === 'pending') {
    return {
      paymentStatus: 'PENDING',
      $and: [
        {
          $or: [
            { saleConfirmedAt: null },
            { saleConfirmedAt: { $exists: false } }
          ]
        },
        PAID_OUTSTANDING_OK
      ]
    };
  }

  if (s === 'outstanding') {
    return {
      settlementMode: 'CREDIT',
      saleConfirmedAt: { $ne: null },
      outstandingAmount: { $gt: EPS }
    };
  }

  if (s === 'overdue') {
    return {
      settlementMode: 'CREDIT',
      saleConfirmedAt: { $ne: null },
      outstandingAmount: { $gt: EPS },
      creditDueDate: { $ne: null, $lt: new Date() }
    };
  }

  return null;
}
