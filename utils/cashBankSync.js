/**
 * Cash & Bank ledger posts.
 * Default: fire-and-forget (never throws) for checkout/create paths.
 * Pass throwOnError: true for date realignment so callers cannot silently desync.
 */
import {
  isCashAndBankEnabled,
  postPaymentChannels,
  reverseLedgerBySource,
  rebuildAccountBalancesChronological
} from '../services/moneyBookService.js';
import { roundMoney } from './invoicePayment.js';

function safeBranchId(doc) {
  return doc?.branchId?._id || doc?.branchId || null;
}

export async function syncMoneyBookFromChannels({
  businessId,
  branchId,
  cashAmount = 0,
  onlineAmount = 0,
  sourceType,
  sourceId,
  entryDate = new Date(),
  notes = '',
  createdBy = null,
  expenseOut = false,
  throwOnError = false,
  skipBalanceCheck = true,
  rebuildBalances = false
}) {
  try {
    if (!businessId || !sourceId) return;
    if (!(await isCashAndBankEnabled(businessId))) return;
    const brid = branchId || null;
    if (!brid) return;

    const cash = roundMoney(cashAmount);
    const online = roundMoney(onlineAmount);
    if (cash <= 0.02 && online <= 0.02) {
      await reverseLedgerBySource(businessId, sourceType, sourceId);
      if (rebuildBalances) {
        await rebuildAccountBalancesChronological(businessId);
      }
      return;
    }

    await postPaymentChannels({
      businessId,
      branchId: brid,
      cashAmount: cash,
      onlineAmount: online,
      sourceType,
      sourceId,
      entryDate,
      notes,
      createdBy,
      expenseOut,
      skipBalanceCheck
    });

    if (rebuildBalances) {
      await rebuildAccountBalancesChronological(businessId);
    }
  } catch (err) {
    console.error('Cash & Bank sync error:', err?.message || err);
    if (throwOnError) throw err;
  }
}

export async function syncMoneyBookFromInvoice(invoice, { createdBy = null, ...opts } = {}) {
  if (!invoice?._id) return;
  // Always derive from post-discount finalAmount − advance (never subtotal / stale overpay).
  const { invoiceSettlementCashOnline } = await import('./paymentChannelAmounts.js');
  let cash = 0;
  let online = 0;
  if (invoice.paymentStatus === 'RECEIVED') {
    const ch = invoiceSettlementCashOnline(invoice);
    cash = ch.cash;
    online = ch.online;
  } else {
    // Credit / open: only post what was collected at checkout (already capped by callers).
    cash = Number(invoice.paymentCashAmount) || 0;
    online = Number(invoice.paymentOnlineAmount) || 0;
  }
  // Advances are posted separately as JOB_ADVANCE; settlement is checkout only.
  await syncMoneyBookFromChannels({
    businessId: invoice.businessId,
    branchId: safeBranchId(invoice),
    cashAmount: cash,
    onlineAmount: online,
    sourceType: 'INVOICE',
    sourceId: invoice._id,
    entryDate: invoice.paymentReceivedAt || invoice.saleConfirmedAt || new Date(),
    notes: `Invoice ${invoice.invoiceNumber || ''}`.trim(),
    createdBy,
    expenseOut: false,
    ...opts
  });
}

/**
 * Force ledger entryDate to match invoice payment date (settlement date edits).
 * Throws when Cash & Bank is enabled and re-post fails — prevents silent desync.
 */
export async function realignInvoiceLedgerToPaymentDate(invoice, { createdBy = null } = {}) {
  if (!invoice?._id) return;
  if (!(await isCashAndBankEnabled(invoice.businessId))) return;

  await syncMoneyBookFromInvoice(invoice, {
    createdBy,
    throwOnError: true,
    skipBalanceCheck: true,
    rebuildBalances: true
  });
}

export async function syncMoneyBookFromJobAdvance(job, { createdBy = null, ...opts } = {}) {
  if (!job?._id) return;
  const adv = Number(job.advancePayment) || 0;
  if (adv <= 0.02) {
    await reverseLedgerBySource(job.businessId, 'JOB_ADVANCE', job._id).catch(() => {});
    return;
  }
  let cash = Number(job.advanceCashAmount);
  let online = Number(job.advanceOnlineAmount);
  const method = String(job.advancePaymentMethod || 'CASH').toUpperCase();
  if (!Number.isFinite(cash) || !Number.isFinite(online) || cash + online < 0.01) {
    cash = method === 'ONLINE' ? 0 : adv;
    online = method === 'ONLINE' ? adv : (method === 'SPLIT' ? 0 : 0);
    if (method === 'SPLIT') {
      cash = adv;
      online = 0;
    }
  }
  await syncMoneyBookFromChannels({
    businessId: job.businessId,
    branchId: safeBranchId(job),
    cashAmount: cash,
    onlineAmount: online,
    sourceType: 'JOB_ADVANCE',
    sourceId: job._id,
    entryDate: job.createdAt || new Date(),
    notes: `Advance ${job.tokenNumber || ''}`.trim(),
    createdBy,
    expenseOut: false,
    ...opts
  });
}

export async function syncMoneyBookFromExpense(expense, { createdBy = null, ...opts } = {}) {
  if (!expense?._id) return;
  await syncMoneyBookFromChannels({
    businessId: expense.businessId,
    branchId: safeBranchId(expense),
    cashAmount: Number(expense.paymentCashAmount) || 0,
    onlineAmount: Number(expense.paymentOnlineAmount) || 0,
    sourceType: 'EXPENSE',
    sourceId: expense._id,
    entryDate: expense.expenseDate || expense.createdAt || new Date(),
    notes: 'Expense',
    createdBy,
    expenseOut: true,
    ...opts
  });
}

export async function syncMoneyBookFromPurchase(purchase, { createdBy = null, ...opts } = {}) {
  if (!purchase?._id) return;
  await syncMoneyBookFromChannels({
    businessId: purchase.businessId,
    branchId: safeBranchId(purchase),
    cashAmount: Number(purchase.paymentCashAmount) || 0,
    onlineAmount: Number(purchase.paymentOnlineAmount) || 0,
    sourceType: 'PURCHASE',
    sourceId: purchase._id,
    entryDate: purchase.purchaseDate || purchase.createdAt || new Date(),
    notes: `Purchase ${purchase.billNumber || ''}`.trim() || 'Purchase',
    createdBy,
    expenseOut: true,
    ...opts
  });
}

export async function syncMoneyBookFromOtherRevenue(row, { createdBy = null, ...opts } = {}) {
  if (!row?._id) return;
  await syncMoneyBookFromChannels({
    businessId: row.businessId,
    branchId: safeBranchId(row),
    cashAmount: Number(row.paymentCashAmount) || 0,
    onlineAmount: Number(row.paymentOnlineAmount) || 0,
    sourceType: 'OTHER_REVENUE',
    sourceId: row._id,
    entryDate: row.revenueDate || row.createdAt || new Date(),
    notes: 'Other revenue',
    createdBy,
    expenseOut: false,
    ...opts
  });
}

export async function syncMoneyBookFromCollection(collection, { createdBy = null, branchId = null, ...opts } = {}) {
  if (!collection?._id) return;
  await syncMoneyBookFromChannels({
    businessId: collection.businessId,
    branchId: branchId || safeBranchId(collection),
    cashAmount: Number(collection.paymentCashAmount) || 0,
    onlineAmount: Number(collection.paymentOnlineAmount) || 0,
    sourceType: 'COLLECTION',
    sourceId: collection._id,
    entryDate: collection.collectionDate || collection.createdAt || new Date(),
    notes: `Collection ${collection.collectionNumber || ''}`.trim(),
    createdBy,
    expenseOut: false,
    ...opts
  });
}
