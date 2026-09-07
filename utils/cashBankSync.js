/**
 * Cash & Bank ledger posts.
 *
 * On every create/edit of invoices, purchases, expenses, other revenue, collections,
 * or job advances: reverse old legs → post current amounts/dates → rebuild balances.
 * Day open/close stays continuous (balances may go negative).
 */
import mongoose from 'mongoose';
import Branch from '../models/Branch.model.js';
import MoneyLedger from '../models/MoneyLedger.model.js';
import {
  isCashAndBankEnabled,
  postPaymentChannels,
  reverseLedgerBySource,
  rebuildAccountBalancesChronological
} from '../services/moneyBookService.js';
import { roundMoney } from './invoicePayment.js';

const EPS = 0.02;

function safeBranchId(doc) {
  return doc?.branchId?._id || doc?.branchId || null;
}

function bizOid(id) {
  return new mongoose.Types.ObjectId(String(id));
}

async function resolveBranchId(businessId, branchId) {
  if (branchId) return branchId;
  const def = await Branch.findOne({ businessId: bizOid(businessId), status: 'ACTIVE', isDefault: true })
    .select('_id')
    .lean();
  if (def?._id) return def._id;
  const any = await Branch.findOne({ businessId: bizOid(businessId), status: 'ACTIVE' })
    .select('_id')
    .sort({ createdAt: 1 })
    .lean();
  return any?._id || null;
}

/** True when ledger cash/bank rows match expected amounts and calendar entryDate. */
async function ledgerMatchesSource({
  businessId,
  sourceType,
  sourceId,
  cashAmount,
  onlineAmount,
  entryDate
}) {
  const rows = await MoneyLedger.find({
    businessId: bizOid(businessId),
    sourceType,
    sourceId
  }).lean();

  const cashWant = roundMoney(cashAmount);
  const onlineWant = roundMoney(onlineAmount);
  const wantMs = entryDate ? new Date(entryDate).getTime() : null;

  const checkLeg = (want, row) => {
    if (want <= EPS) return !row;
    if (!row) return false;
    if (Math.abs(roundMoney(row.amount) - want) > 0.05) return false;
    if (wantMs != null && Math.abs(new Date(row.entryDate).getTime() - wantMs) > 1000) return false;
    return true;
  };

  return (
    checkLeg(cashWant, rows.find((r) => r.accountType === 'CASH')) &&
    checkLeg(onlineWant, rows.find((r) => r.accountType === 'BANK'))
  );
}

/**
 * Canonical sync: reverse prior legs for this source, post current cash/online,
 * rebuild chronological balances, then verify (retry once if needed).
 */
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
  rebuildBalances = true
}) {
  try {
    if (!businessId || !sourceId) return;
    if (!(await isCashAndBankEnabled(businessId))) return;
    const brid = await resolveBranchId(businessId, branchId || null);
    if (!brid) {
      console.warn('Cash & Bank sync skipped — no branch for business', String(businessId));
      return;
    }

    const cash = roundMoney(cashAmount);
    const online = roundMoney(onlineAmount);
    const when = entryDate ? new Date(entryDate) : new Date();
    const deferBalanceRebuild = !rebuildBalances;

    const runOnce = async () => {
      await reverseLedgerBySource(businessId, sourceType, sourceId, {
        skipEnabledCheck: true,
        deferBalanceRebuild
      });

      if (cash > EPS || online > EPS) {
        await postPaymentChannels({
          businessId,
          branchId: brid,
          cashAmount: cash,
          onlineAmount: online,
          sourceType,
          sourceId,
          entryDate: when,
          notes,
          createdBy,
          expenseOut,
          skipEnabledCheck: true,
          skipBalanceCheck,
          skipReverse: true,
          deferBalanceRebuild
        });
      }

      if (rebuildBalances) {
        await rebuildAccountBalancesChronological(businessId);
      }
    };

    await runOnce();

    // Verify only on interactive syncs (immediate rebuild). Bulk realign verifies after final rebuild.
    if (rebuildBalances) {
      const aligned = await ledgerMatchesSource({
        businessId,
        sourceType,
        sourceId,
        cashAmount: cash,
        onlineAmount: online,
        entryDate: when
      });
      if (!aligned) {
        console.warn('Cash & Bank ledger misaligned after sync — retrying', {
          sourceType,
          sourceId: String(sourceId),
          cash,
          online
        });
        await runOnce();
      }
    }
  } catch (err) {
    console.error('Cash & Bank sync error:', err?.message || err);
    if (throwOnError) throw err;
  }
}

export async function syncMoneyBookFromInvoice(invoice, { createdBy = null, ...opts } = {}) {
  if (!invoice?._id) return;
  const { invoiceSettlementCashOnline } = await import('./paymentChannelAmounts.js');
  let cash = 0;
  let online = 0;
  if (invoice.paymentStatus === 'RECEIVED') {
    const ch = invoiceSettlementCashOnline(invoice);
    cash = ch.cash;
    online = ch.online;
  } else {
    cash = Number(invoice.paymentCashAmount) || 0;
    online = Number(invoice.paymentOnlineAmount) || 0;
  }
  await syncMoneyBookFromChannels({
    businessId: invoice.businessId,
    branchId: safeBranchId(invoice),
    cashAmount: cash,
    onlineAmount: online,
    sourceType: 'INVOICE',
    sourceId: invoice._id,
    entryDate: invoice.paymentReceivedAt || invoice.saleConfirmedAt || invoice.updatedAt || new Date(),
    notes: `Invoice ${invoice.invoiceNumber || ''}`.trim(),
    createdBy,
    expenseOut: false,
    ...opts
  });
}

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
    await reverseLedgerBySource(job.businessId, 'JOB_ADVANCE', job._id, {
      deferBalanceRebuild: opts.rebuildBalances === false
    }).catch(() => {});
    if (opts.rebuildBalances !== false) {
      await rebuildAccountBalancesChronological(job.businessId).catch(() => {});
    }
    return;
  }
  let cash = Number(job.advanceCashAmount);
  let online = Number(job.advanceOnlineAmount);
  const method = String(job.advancePaymentMethod || 'CASH').toUpperCase();
  if (!Number.isFinite(cash) || !Number.isFinite(online) || cash + online < 0.01) {
    cash = method === 'ONLINE' ? 0 : adv;
    online = method === 'ONLINE' ? adv : 0;
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

/**
 * Full business realign: re-post every money source then rebuild balances.
 * Safe to run after bulk edits or when day books look wrong.
 */
export async function realignBusinessMoneyBook(businessId, { createdBy = null } = {}) {
  if (!(await isCashAndBankEnabled(businessId))) {
    return { skipped: true };
  }
  const bid = bizOid(businessId);
  const Invoice = (await import('../models/Invoice.model.js')).default;
  const Expense = (await import('../models/Expense.model.js')).default;
  const Purchase = (await import('../models/Purchase.model.js')).default;
  const OtherRevenue = (await import('../models/OtherRevenue.model.js')).default;
  const PaymentCollection = (await import('../models/PaymentCollection.model.js')).default;
  const Job = (await import('../models/Job.model.js')).default;

  const counts = {
    invoices: 0,
    expenses: 0,
    purchases: 0,
    otherRevenue: 0,
    collections: 0,
    advances: 0
  };

  const invoices = await Invoice.find({
    businessId: bid,
    $or: [
      { paymentStatus: 'RECEIVED' },
      { paymentCashAmount: { $gt: EPS } },
      { paymentOnlineAmount: { $gt: EPS } }
    ]
  });
  for (const inv of invoices) {
    await syncMoneyBookFromInvoice(inv, { createdBy, rebuildBalances: false, throwOnError: false });
    counts.invoices += 1;
  }

  const expenses = await Expense.find({ businessId: bid });
  for (const exp of expenses) {
    await syncMoneyBookFromExpense(exp, { createdBy, rebuildBalances: false, throwOnError: false });
    counts.expenses += 1;
  }

  const purchases = await Purchase.find({ businessId: bid });
  for (const p of purchases) {
    await syncMoneyBookFromPurchase(p, { createdBy, rebuildBalances: false, throwOnError: false });
    counts.purchases += 1;
  }

  const ors = await OtherRevenue.find({ businessId: bid });
  for (const row of ors) {
    await syncMoneyBookFromOtherRevenue(row, { createdBy, rebuildBalances: false, throwOnError: false });
    counts.otherRevenue += 1;
  }

  const cols = await PaymentCollection.find({ businessId: bid });
  for (const c of cols) {
    await syncMoneyBookFromCollection(c, { createdBy, branchId: c.branchId, rebuildBalances: false });
    counts.collections += 1;
  }

  const jobs = await Job.find({
    businessId: bid,
    advancePayment: { $gt: EPS }
  }).select('_id businessId branchId advancePayment advanceCashAmount advanceOnlineAmount advancePaymentMethod createdAt tokenNumber');
  for (const job of jobs) {
    await syncMoneyBookFromJobAdvance(job, { createdBy, rebuildBalances: false });
    counts.advances += 1;
  }

  await rebuildAccountBalancesChronological(businessId);
  return { skipped: false, ...counts };
}
