/**
 * Fire-and-forget Cash & Bank ledger posts. Never throws to callers.
 * No-ops when cashAndBankEnabled is false.
 */
import {
  isCashAndBankEnabled,
  postPaymentChannels,
  reverseLedgerBySource
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
  expenseOut = false
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
      expenseOut
    });
  } catch (err) {
    console.error('Cash & Bank sync error:', err?.message || err);
  }
}

export async function syncMoneyBookFromInvoice(invoice, { createdBy = null } = {}) {
  if (!invoice?._id) return;
  const cash = Number(invoice.paymentCashAmount) || 0;
  const online = Number(invoice.paymentOnlineAmount) || 0;
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
    expenseOut: false
  });
}

export async function syncMoneyBookFromJobAdvance(job, { createdBy = null } = {}) {
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
    expenseOut: false
  });
}

export async function syncMoneyBookFromExpense(expense, { createdBy = null } = {}) {
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
    expenseOut: true
  });
}

export async function syncMoneyBookFromOtherRevenue(row, { createdBy = null } = {}) {
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
    expenseOut: false
  });
}

export async function syncMoneyBookFromCollection(collection, { createdBy = null, branchId = null } = {}) {
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
    expenseOut: false
  });
}
