/**
 * One-time historical sync into Cash & Bank ledger when the module is enabled.
 * Posts invoices, job advances, expenses, other revenue, and credit collections
 * chronologically so opening/closing books match prior shop activity.
 */
import mongoose from 'mongoose';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Branch from '../models/Branch.model.js';
import Invoice from '../models/Invoice.model.js';
import Job from '../models/Job.model.js';
import Expense from '../models/Expense.model.js';
import OtherRevenue from '../models/OtherRevenue.model.js';
import PaymentCollection from '../models/PaymentCollection.model.js';
import {
  ensureMoneyAccountsForBranch,
  isCashAndBankEnabled,
  postPaymentChannels,
  rebuildAccountBalancesChronological
} from '../services/moneyBookService.js';
import { roundMoney } from './invoicePayment.js';
import {
  invoiceSettlementCashOnline,
  creditCheckoutCashOnline,
  collectionCashOnline
} from './paymentChannelAmounts.js';
import { expenseCashOnline } from './expensePayment.js';

const EPS = 0.02;

function bizOid(id) {
  return new mongoose.Types.ObjectId(String(id));
}

function idStr(v) {
  if (!v) return '';
  return String(v._id || v);
}

async function resolveDefaultBranchId(businessId) {
  const branch = await Branch.findOne({ businessId: bizOid(businessId), status: 'ACTIVE', isDefault: true })
    .select('_id')
    .lean();
  if (branch?._id) return branch._id;
  const any = await Branch.findOne({ businessId: bizOid(businessId), status: 'ACTIVE' })
    .select('_id')
    .sort({ createdAt: 1 })
    .lean();
  return any?._id || null;
}

function jobAdvanceChannels(job) {
  const adv = roundMoney(Number(job.advancePayment) || 0);
  if (adv <= EPS) return { cash: 0, online: 0 };
  let cash = Number(job.advanceCashAmount);
  let online = Number(job.advanceOnlineAmount);
  const method = String(job.advancePaymentMethod || 'CASH').toUpperCase();
  if (!Number.isFinite(cash) || !Number.isFinite(online) || cash + online < 0.01) {
    if (method === 'ONLINE') {
      cash = 0;
      online = adv;
    } else if (method === 'SPLIT') {
      cash = adv;
      online = 0;
    } else {
      cash = adv;
      online = 0;
    }
  }
  return { cash: roundMoney(cash), online: roundMoney(online) };
}

function otherRevenueChannels(row) {
  // Same legacy rules as expenses (FULL infers from paymentMethod when splits missing).
  return expenseCashOnline(row);
}

/**
 * Backfill all prior money movements into the ledger.
 * Idempotent via MoneyLedger unique source legs; safe to re-run.
 */
export async function backfillHistoricalMoneyBook(businessId, { createdBy = null, force = false } = {}) {
  if (!businessId) return { skipped: true, reason: 'no_business' };

  const settings = await BusinessSettings.findOne({ businessId: bizOid(businessId) })
    .select('cashAndBankEnabled cashAndBankBackfilledAt')
    .lean();
  if (!settings?.cashAndBankEnabled && !(await isCashAndBankEnabled(businessId))) {
    return { skipped: true, reason: 'disabled' };
  }
  if (settings?.cashAndBankBackfilledAt && !force) {
    return { skipped: true, reason: 'already_backfilled', at: settings.cashAndBankBackfilledAt };
  }

  const defaultBranchId = await resolveDefaultBranchId(businessId);
  if (!defaultBranchId) {
    return { skipped: true, reason: 'no_branch' };
  }

  const branches = await Branch.find({ businessId: bizOid(businessId), status: 'ACTIVE' })
    .select('_id')
    .lean();
  for (const b of branches) {
    await ensureMoneyAccountsForBranch(businessId, b._id, { userId: createdBy });
  }

  const bid = bizOid(businessId);
  const events = [];

  // --- Job advances ---
  const jobs = await Job.find({
    businessId: bid,
    advancePayment: { $gt: EPS }
  })
    .select('_id branchId advancePayment advanceCashAmount advanceOnlineAmount advancePaymentMethod tokenNumber createdAt')
    .lean();

  for (const job of jobs) {
    const ch = jobAdvanceChannels(job);
    if (ch.cash <= EPS && ch.online <= EPS) continue;
    events.push({
      branchId: job.branchId || defaultBranchId,
      cash: ch.cash,
      online: ch.online,
      sourceType: 'JOB_ADVANCE',
      sourceId: job._id,
      entryDate: job.createdAt || new Date(),
      notes: `Advance ${job.tokenNumber || ''}`.trim(),
      expenseOut: false
    });
  }

  // --- Invoices (settlement / credit checkout) ---
  const invoices = await Invoice.find({
    businessId: bid,
    $or: [
      { paymentStatus: 'RECEIVED' },
      {
        settlementMode: 'CREDIT',
        $or: [
          { paymentCashAmount: { $gt: EPS } },
          { paymentOnlineAmount: { $gt: EPS } }
        ]
      }
    ]
  })
    .select(
      '_id branchId invoiceNumber paymentStatus settlementMode paymentMethod paymentCashAmount paymentOnlineAmount paymentReceivedAt saleConfirmedAt finalAmount advancePayment createdAt'
    )
    .lean();

  const invoiceBranchById = new Map();
  for (const inv of invoices) {
    const branchId = inv.branchId || defaultBranchId;
    invoiceBranchById.set(idStr(inv._id), branchId);
    let ch = { cash: 0, online: 0 };
    if (inv.paymentStatus === 'RECEIVED' && inv.settlementMode !== 'CREDIT') {
      ch = invoiceSettlementCashOnline(inv);
    } else if (inv.settlementMode === 'CREDIT') {
      ch = creditCheckoutCashOnline(inv);
    } else {
      ch = invoiceSettlementCashOnline(inv);
    }
    if (ch.cash <= EPS && ch.online <= EPS) continue;
    events.push({
      branchId,
      cash: ch.cash,
      online: ch.online,
      sourceType: 'INVOICE',
      sourceId: inv._id,
      entryDate: inv.paymentReceivedAt || inv.saleConfirmedAt || inv.createdAt || new Date(),
      notes: `Invoice ${inv.invoiceNumber || ''}`.trim(),
      expenseOut: false
    });
  }

  // --- Expenses (out) ---
  const expenses = await Expense.find({ businessId: bid })
    .select(
      '_id branchId amount paymentMethod paymentCashAmount paymentOnlineAmount settlementMode expenseDate createdAt'
    )
    .lean();
  for (const exp of expenses) {
    const ch = expenseCashOnline(exp);
    if (ch.cash <= EPS && ch.online <= EPS) continue;
    events.push({
      branchId: exp.branchId || defaultBranchId,
      cash: ch.cash,
      online: ch.online,
      sourceType: 'EXPENSE',
      sourceId: exp._id,
      entryDate: exp.expenseDate || exp.createdAt || new Date(),
      notes: 'Expense',
      expenseOut: true
    });
  }

  // --- Other revenue (in) ---
  const otherRows = await OtherRevenue.find({ businessId: bid })
    .select(
      '_id branchId amount paymentMethod paymentCashAmount paymentOnlineAmount settlementMode revenueDate createdAt'
    )
    .lean();
  for (const row of otherRows) {
    const ch = otherRevenueChannels(row);
    if (ch.cash <= EPS && ch.online <= EPS) continue;
    events.push({
      branchId: row.branchId || defaultBranchId,
      cash: ch.cash,
      online: ch.online,
      sourceType: 'OTHER_REVENUE',
      sourceId: row._id,
      entryDate: row.revenueDate || row.createdAt || new Date(),
      notes: 'Other revenue',
      expenseOut: false
    });
  }

  // --- Credit collections ---
  const collections = await PaymentCollection.find({ businessId: bid })
    .select(
      '_id amount paymentMethod paymentCashAmount paymentOnlineAmount collectionDate collectionNumber allocations createdAt'
    )
    .lean();

  // Resolve missing invoice branches for allocation lookups
  const allocInvoiceIds = [];
  for (const c of collections) {
    for (const a of c.allocations || []) {
      if (a.invoiceId && !invoiceBranchById.has(idStr(a.invoiceId))) {
        allocInvoiceIds.push(a.invoiceId);
      }
    }
  }
  if (allocInvoiceIds.length) {
    const extraInvs = await Invoice.find({ _id: { $in: allocInvoiceIds }, businessId: bid })
      .select('_id branchId')
      .lean();
    for (const inv of extraInvs) {
      invoiceBranchById.set(idStr(inv._id), inv.branchId || defaultBranchId);
    }
  }

  for (const c of collections) {
    const ch = collectionCashOnline(c);
    if (ch.cash <= EPS && ch.online <= EPS) continue;
    let branchId = defaultBranchId;
    const firstAlloc = (c.allocations || [])[0];
    if (firstAlloc?.invoiceId) {
      branchId = invoiceBranchById.get(idStr(firstAlloc.invoiceId)) || defaultBranchId;
    }
    events.push({
      branchId,
      cash: ch.cash,
      online: ch.online,
      sourceType: 'COLLECTION',
      sourceId: c._id,
      entryDate: c.collectionDate || c.createdAt || new Date(),
      notes: `Collection ${c.collectionNumber || ''}`.trim(),
      expenseOut: false
    });
  }

  events.sort((a, b) => {
    const ta = new Date(a.entryDate).getTime();
    const tb = new Date(b.entryDate).getTime();
    if (ta !== tb) return ta - tb;
    return String(a.sourceId).localeCompare(String(b.sourceId));
  });

  let posted = 0;
  let failed = 0;
  for (const ev of events) {
    try {
      const rows = await postPaymentChannels({
        businessId,
        branchId: ev.branchId,
        cashAmount: ev.cash,
        onlineAmount: ev.online,
        sourceType: ev.sourceType,
        sourceId: ev.sourceId,
        entryDate: ev.entryDate,
        notes: ev.notes,
        createdBy,
        expenseOut: ev.expenseOut,
        skipEnabledCheck: true,
        skipBalanceCheck: true,
        skipReverse: true
      });
      if (rows?.length) posted += rows.length;
    } catch (err) {
      failed += 1;
      console.warn('Cash & Bank backfill row failed:', ev.sourceType, ev.sourceId, err?.message || err);
    }
  }

  await rebuildAccountBalancesChronological(businessId);

  await BusinessSettings.updateOne(
    { businessId: bizOid(businessId) },
    { $set: { cashAndBankBackfilledAt: new Date() } }
  );

  return {
    success: true,
    events: events.length,
    posted,
    failed,
    branches: branches.length
  };
}

/**
 * Run backfill once when module is on but history was never synced
 * (covers shops that enabled before this feature shipped).
 */
export async function maybeBackfillCashAndBank(businessId, { createdBy = null } = {}) {
  if (!businessId) return null;
  if (!(await isCashAndBankEnabled(businessId))) return null;
  const settings = await BusinessSettings.findOne({ businessId: bizOid(businessId) })
    .select('cashAndBankBackfilledAt')
    .lean();
  if (settings?.cashAndBankBackfilledAt) return null;
  return backfillHistoricalMoneyBook(businessId, { createdBy, force: false });
}

/** Non-blocking schedule with per-business lock (page loads must not wait). */
const backfillInFlight = new Map();

export function scheduleCashAndBankBackfill(businessId, { createdBy = null, force = false } = {}) {
  const key = String(businessId || '');
  if (!key) return false;
  if (backfillInFlight.get(key)) return false;
  backfillInFlight.set(key, true);
  setImmediate(() => {
    backfillHistoricalMoneyBook(businessId, { createdBy, force })
      .then((r) => {
        if (r && !r.skipped) {
          console.log('Cash & Bank backfill done:', key, r);
        }
      })
      .catch((err) => {
        console.warn('Cash & Bank backfill error:', err?.message || err);
      })
      .finally(() => {
        backfillInFlight.delete(key);
      });
  });
  return true;
}

export function scheduleMaybeCashAndBankBackfill(businessId, { createdBy = null } = {}) {
  const key = String(businessId || '');
  if (!key) return false;
  if (backfillInFlight.get(key)) return false;
  backfillInFlight.set(key, true);
  setImmediate(() => {
    maybeBackfillCashAndBank(businessId, { createdBy })
      .catch((err) => {
        console.warn('Cash & Bank maybe-backfill error:', err?.message || err);
      })
      .finally(() => {
        backfillInFlight.delete(key);
      });
  });
  return true;
}
