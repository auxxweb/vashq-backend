import { effectiveAdvance, roundMoney } from '../../utils/invoicePayment.js';

const EPS = 0.02;

export const COLLECTION_STATUS = {
  PAID: 'PAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  OUTSTANDING: 'OUTSTANDING'
};

export function getAdvanceCollected(invoice) {
  return effectiveAdvance(invoice.finalAmount, invoice.advancePayment);
}

export function getCheckoutSettlement(invoice) {
  return roundMoney(
    (Number(invoice.paymentCashAmount) || 0) + (Number(invoice.paymentOnlineAmount) || 0)
  );
}

/** Total collected at checkout (advance + settlement at close). */
export function getCheckoutTotal(invoice) {
  return roundMoney(getAdvanceCollected(invoice) + getCheckoutSettlement(invoice));
}

export function getTotalCollected(invoice) {
  return roundMoney(getCheckoutTotal(invoice) + (Number(invoice.amountCollectedLater) || 0));
}

export function computeOutstanding(invoice) {
  const final = Math.max(0, Number(invoice.finalAmount) || 0);
  return roundMoney(Math.max(0, final - getTotalCollected(invoice)));
}

export function isFullyPaid(invoice) {
  return computeOutstanding(invoice) <= EPS;
}

export function deriveCollectionDisplayStatus(invoice) {
  if (invoice.settlementMode !== 'CREDIT' && invoice.paymentStatus === 'RECEIVED') {
    return COLLECTION_STATUS.PAID;
  }
  if (invoice.settlementMode !== 'CREDIT' && invoice.paymentStatus === 'PENDING') {
    return null;
  }

  const outstanding = computeOutstanding(invoice);
  const collected = getTotalCollected(invoice);

  if (outstanding <= EPS) {
    return COLLECTION_STATUS.PAID;
  }
  if (collected <= EPS) {
    return COLLECTION_STATUS.OUTSTANDING;
  }
  return COLLECTION_STATUS.PARTIALLY_PAID;
}

/** Recompute cached fields and paymentStatus for a credit invoice document. */
export function syncInvoiceOutstanding(invoice) {
  const checkoutTotal = getCheckoutTotal(invoice);
  invoice.amountCollectedAtCheckout = checkoutTotal;
  invoice.outstandingAmount = computeOutstanding(invoice);

  if (invoice.outstandingAmount <= EPS) {
    invoice.paymentStatus = 'RECEIVED';
    if (!invoice.paymentReceivedAt) {
      invoice.paymentReceivedAt = new Date();
    }
  } else if (invoice.settlementMode === 'CREDIT' && invoice.saleConfirmedAt) {
    invoice.paymentStatus = 'PENDING';
  }

  return invoice;
}

export function applyCollectionToInvoice(invoice, amount) {
  const alloc = roundMoney(amount);
  if (alloc <= EPS) {
    return invoice;
  }

  const outstanding = computeOutstanding(invoice);
  if (alloc > outstanding + EPS) {
    const err = new Error(`Allocation exceeds invoice outstanding (${invoice.invoiceNumber || invoice._id})`);
    err.status = 400;
    throw err;
  }

  invoice.amountCollectedLater = roundMoney((Number(invoice.amountCollectedLater) || 0) + alloc);
  return syncInvoiceOutstanding(invoice);
}

export function sumCustomerOutstanding(invoices) {
  return roundMoney(
    invoices.reduce((sum, inv) => sum + Math.max(0, computeOutstanding(inv)), 0)
  );
}

export function isOpenCreditInvoice(invoice) {
  if (invoice.settlementMode !== 'CREDIT' || !invoice.saleConfirmedAt) {
    return false;
  }
  return computeOutstanding(invoice) > EPS;
}

/** Sort open invoices oldest first (FIFO). */
export function sortInvoicesFifo(invoices) {
  return [...invoices].sort((a, b) => {
    const aDate = a.saleConfirmedAt || a.createdAt;
    const bDate = b.saleConfirmedAt || b.createdAt;
    const diff = new Date(aDate).getTime() - new Date(bDate).getTime();
    if (diff !== 0) return diff;
    return String(a._id).localeCompare(String(b._id));
  });
}
