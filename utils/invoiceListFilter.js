const EPS = 0.02;

/**
 * Mongo filter for invoice list / dashboard status chips.
 *
 * Semantics:
 * - paid: payment received (full checkout or credit fully collected)
 * - pending: not paid yet, and not closed as a credit sale (awaiting checkout / mark paid)
 * - outstanding / overdue: credit sales with remaining balance
 *
 * Important: unpaid job invoices store outstandingAmount = balance due at create time.
 * Do NOT require outstanding ≈ 0 for pending — that hid real unpaid invoices.
 * Do NOT require outstanding ≈ 0 for paid — full-pay close used to leave stale outstanding.
 */
export function invoiceStatusFilterClause(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s || s === 'all') return null;

  if (s === 'paid') {
    return { paymentStatus: 'RECEIVED' };
  }

  if (s === 'pending') {
    return {
      paymentStatus: 'PENDING',
      $or: [
        { saleConfirmedAt: null },
        { saleConfirmedAt: { $exists: false } }
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
