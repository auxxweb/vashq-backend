import mongoose from 'mongoose';
import crypto from 'crypto';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Branch from '../models/Branch.model.js';
import MoneyAccount from '../models/MoneyAccount.model.js';
import MoneyLedger from '../models/MoneyLedger.model.js';
import CashMovementType from '../models/CashMovementType.model.js';
import CashDaySession from '../models/CashDaySession.model.js';
import Invoice from '../models/Invoice.model.js';
import { roundMoney } from '../utils/invoicePayment.js';

const EPS = 0.02;

function bizOid(id) {
  return new mongoose.Types.ObjectId(String(id));
}

function branchOid(id) {
  if (!id) return null;
  return new mongoose.Types.ObjectId(String(id));
}

export async function isCashAndBankEnabled(businessId) {
  if (!businessId) return false;
  const settings = await BusinessSettings.findOne({ businessId: bizOid(businessId) })
    .select('cashAndBankEnabled')
    .lean();
  return !!settings?.cashAndBankEnabled;
}

function defaultAccountName(accountType) {
  return accountType === 'BANK' ? 'Bank / Online' : 'Cash in hand';
}

/** Ensure CASH + BANK accounts exist for a branch. */
export async function ensureMoneyAccountsForBranch(businessId, branchId, { openingCash = 0, openingBank = 0, openingDate = null, userId = null } = {}) {
  const bid = bizOid(businessId);
  const brid = branchOid(branchId);
  if (!brid) {
    const err = new Error('Branch is required for Cash & Bank accounts');
    err.status = 400;
    throw err;
  }

  const results = [];
  for (const accountType of ['CASH', 'BANK']) {
    let account = await MoneyAccount.findOne({ businessId: bid, branchId: brid, accountType });
    if (!account) {
      const opening = accountType === 'CASH' ? roundMoney(openingCash) : roundMoney(openingBank);
      account = await MoneyAccount.create({
        businessId: bid,
        branchId: brid,
        accountType,
        name: defaultAccountName(accountType),
        openingBalance: opening,
        openingDate: openingDate || new Date(),
        currentBalance: opening
      });
      if (opening > EPS) {
        await postLedgerEntry({
          businessId: bid,
          branchId: brid,
          accountType,
          direction: 'IN',
          amount: opening,
          sourceType: 'OPENING',
          sourceId: account._id,
          entryDate: openingDate || new Date(),
          notes: 'Opening balance',
          createdBy: userId,
          skipEnabledCheck: true
        });
      }
    }
    results.push(account);
  }
  return results;
}

export async function ensureDefaultMovementTypes(businessId) {
  const bid = bizOid(businessId);
  const defaults = [
    { name: 'Owner capital / cash introduced', kind: 'DEPOSIT', isOwnerCapital: true, sortOrder: 1 },
    { name: 'Bank deposit (cash to bank)', kind: 'DEPOSIT', isOwnerCapital: false, sortOrder: 2 },
    { name: 'Owner drawings / cash taken', kind: 'WITHDRAWAL', isOwnerCapital: true, sortOrder: 1 },
    { name: 'Bank withdrawal (to cash)', kind: 'WITHDRAWAL', isOwnerCapital: false, sortOrder: 2 },
    { name: 'Petty cash top-up', kind: 'DEPOSIT', isOwnerCapital: false, sortOrder: 3 },
    { name: 'Miscellaneous adjustment out', kind: 'WITHDRAWAL', isOwnerCapital: false, sortOrder: 3 }
  ];
  for (const d of defaults) {
    await CashMovementType.updateOne(
      { businessId: bid, kind: d.kind, name: d.name },
      { $setOnInsert: { ...d, businessId: bid, isActive: true } },
      { upsert: true }
    );
  }
}

/** Enable module: seed types + accounts quickly; historical sync runs in background. */
export async function enableCashAndBankForBusiness(businessId, userId = null) {
  await ensureDefaultMovementTypes(businessId);
  const branches = await Branch.find({ businessId: bizOid(businessId), status: 'ACTIVE' })
    .select('_id')
    .lean();
  for (const b of branches) {
    await ensureMoneyAccountsForBranch(businessId, b._id, { userId });
  }
  try {
    const { scheduleCashAndBankBackfill } = await import('../utils/cashBankBackfill.js');
    scheduleCashAndBankBackfill(businessId, { createdBy: userId, force: true });
  } catch (err) {
    console.warn('Cash & Bank backfill schedule failed:', err?.message || err);
  }
  return { seededBranches: branches.length, backfill: { scheduled: true } };
}

export async function getAccount(businessId, branchId, accountType) {
  await ensureMoneyAccountsForBranch(businessId, branchId);
  return MoneyAccount.findOne({
    businessId: bizOid(businessId),
    branchId: branchOid(branchId),
    accountType
  });
}

/**
 * Balance as of a moment (inclusive of entries on/before asOf).
 * Uses latest balanceAfter on or before asOf; falls back to opening/current.
 */
export async function getBalanceAsOf(businessId, branchId, accountType, asOf = new Date()) {
  const bid = bizOid(businessId);
  const brid = branchOid(branchId);
  const account = await MoneyAccount.findOne({ businessId: bid, branchId: brid, accountType }).lean();
  if (!account) return 0;

  const last = await MoneyLedger.findOne({
    businessId: bid,
    branchId: brid,
    accountType,
    entryDate: { $lte: asOf }
  })
    .sort({ entryDate: -1, createdAt: -1 })
    .select('balanceAfter')
    .lean();

  if (last) return roundMoney(last.balanceAfter);
  return roundMoney(account.openingBalance || 0);
}

export async function getBranchBalances(businessId, branchId, asOf = new Date()) {
  const [cash, bank] = await Promise.all([
    getBalanceAsOf(businessId, branchId, 'CASH', asOf),
    getBalanceAsOf(businessId, branchId, 'BANK', asOf)
  ]);
  return {
    cash,
    bank,
    total: roundMoney(cash + bank)
  };
}

/** Sum balances across branches (all-branches view). */
export async function getBusinessBalances(businessId, asOf = new Date(), branchIds = null) {
  let branches = await Branch.find({
    businessId: bizOid(businessId),
    status: 'ACTIVE',
    ...(branchIds?.length ? { _id: { $in: branchIds.map(branchOid) } } : {})
  })
    .select('_id name code isDefault')
    .lean();

  // Ensure accounts exist in one pass without blocking on OPENING posts when already present
  const existing = await MoneyAccount.find({
    businessId: bizOid(businessId),
    branchId: { $in: branches.map((b) => b._id) }
  })
    .select('branchId accountType')
    .lean();
  const have = new Set(existing.map((a) => `${a.branchId}:${a.accountType}`));
  for (const b of branches) {
    if (!have.has(`${b._id}:CASH`) || !have.has(`${b._id}:BANK`)) {
      await ensureMoneyAccountsForBranch(businessId, b._id);
    }
  }

  const perBranch = [];
  let cash = 0;
  let bank = 0;
  // Parallel balance reads
  const bals = await Promise.all(
    branches.map((b) => getBranchBalances(businessId, b._id, asOf).then((bal) => ({ b, bal })))
  );
  for (const { b, bal } of bals) {
    perBranch.push({
      branchId: b._id,
      branchName: b.name,
      branchCode: b.code,
      isDefault: !!b.isDefault,
      ...bal
    });
    cash = roundMoney(cash + bal.cash);
    bank = roundMoney(bank + bal.bank);
  }
  return {
    cash,
    bank,
    total: roundMoney(cash + bank),
    branches: perBranch
  };
}

/**
 * Post a ledger entry. Idempotent for auto sources (same sourceType+sourceId+accountType+direction).
 */
export async function postLedgerEntry({
  businessId,
  branchId,
  accountType,
  direction,
  amount,
  sourceType,
  sourceId = null,
  transferGroupId = null,
  movementTypeId = null,
  notes = '',
  entryDate = new Date(),
  createdBy = null,
  skipEnabledCheck = false,
  skipBalanceCheck = false
}) {
  if (!skipEnabledCheck && !(await isCashAndBankEnabled(businessId))) {
    return null;
  }

  const amt = roundMoney(Math.max(0, Number(amount) || 0));
  if (amt <= EPS && sourceType !== 'OPENING') return null;

  const bid = bizOid(businessId);
  const brid = branchOid(branchId);
  if (!brid) return null;

  const account = await getAccount(businessId, brid, accountType);
  if (!account) return null;

  if (sourceId && !['TRANSFER', 'ADJUSTMENT', 'DAY_CLOSE_ADJUST', 'DEPOSIT', 'WITHDRAWAL'].includes(sourceType)) {
    const existing = await MoneyLedger.findOne({
      businessId: bid,
      sourceType,
      sourceId,
      accountType,
      direction
    }).lean();
    if (existing) return existing;
  }

  const signed = direction === 'IN' ? amt : -amt;
  const prev = roundMoney(account.currentBalance || 0);
  let next = roundMoney(prev + signed);
  if (!skipBalanceCheck && next < -EPS) {
    const err = new Error(
      `Insufficient ${accountType === 'CASH' ? 'cash' : 'bank'} balance. Available: ${prev}`
    );
    err.status = 400;
    throw err;
  }
  // Schema requires balanceAfter >= 0 (also used during historical backfill).
  next = Math.max(0, next);

  const entry = await MoneyLedger.create({
    businessId: bid,
    branchId: brid,
    accountType,
    accountId: account._id,
    entryDate: entryDate || new Date(),
    direction,
    amount: amt,
    signedAmount: signed,
    balanceAfter: next,
    sourceType,
    sourceId: sourceId || null,
    transferGroupId: transferGroupId || null,
    movementTypeId: movementTypeId || null,
    notes: notes || '',
    createdBy: createdBy || null
  });

  account.currentBalance = next;
  await account.save();
  return entry.toObject ? entry.toObject() : entry;
}

/** Remove auto-posted legs for a source and rebuild account cache from ledger. */
export async function reverseLedgerBySource(businessId, sourceType, sourceId, { skipEnabledCheck = false } = {}) {
  if (!skipEnabledCheck && !(await isCashAndBankEnabled(businessId))) return 0;
  if (!sourceId) return 0;
  const bid = bizOid(businessId);
  const rows = await MoneyLedger.find({ businessId: bid, sourceType, sourceId }).lean();
  if (!rows.length) return 0;

  await MoneyLedger.deleteMany({ businessId: bid, sourceType, sourceId });

  const touched = new Map();
  for (const r of rows) {
    touched.set(`${r.branchId}:${r.accountType}`, { branchId: r.branchId, accountType: r.accountType });
  }
  for (const { branchId, accountType } of touched.values()) {
    await rebuildAccountBalance(businessId, branchId, accountType);
  }
  return rows.length;
}

async function rebuildAccountBalance(businessId, branchId, accountType) {
  const account = await MoneyAccount.findOne({
    businessId: bizOid(businessId),
    branchId: branchOid(branchId),
    accountType
  });
  if (!account) return;

  const last = await MoneyLedger.findOne({
    businessId: account.businessId,
    branchId: account.branchId,
    accountType
  })
    .sort({ entryDate: -1, createdAt: -1 })
    .select('balanceAfter')
    .lean();

  account.currentBalance = last ? roundMoney(last.balanceAfter) : roundMoney(account.openingBalance || 0);
  await account.save();
}

/**
 * Recompute signed running balances in chronological order for every account.
 * Used after historical backfill so balanceAfter matches entry dates.
 */
export async function rebuildAccountBalancesChronological(businessId) {
  const accounts = await MoneyAccount.find({ businessId: bizOid(businessId) });
  for (const account of accounts) {
    const rows = await MoneyLedger.find({
      businessId: account.businessId,
      branchId: account.branchId,
      accountType: account.accountType
    })
      .sort({ entryDate: 1, createdAt: 1 })
      .select('_id signedAmount balanceAfter');

    let bal = 0;
    for (const row of rows) {
      bal = Math.max(0, roundMoney(bal + (Number(row.signedAmount) || 0)));
      if (roundMoney(row.balanceAfter) !== bal) {
        await MoneyLedger.updateOne({ _id: row._id }, { $set: { balanceAfter: bal } });
      }
    }
    account.currentBalance = bal;
    await account.save();
  }
}

/**
 * Post cash + online channel amounts (sales / expenses / collections).
 * expenseOut = true → OUT; else IN.
 */
export async function postPaymentChannels({
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
  skipEnabledCheck = false,
  skipBalanceCheck = false,
  skipReverse = false
}) {
  if (!skipEnabledCheck && !(await isCashAndBankEnabled(businessId))) return [];
  if (!branchId) return [];

  if (!skipReverse) {
    await reverseLedgerBySource(businessId, sourceType, sourceId, { skipEnabledCheck });
  }

  const direction = expenseOut ? 'OUT' : 'IN';
  const posted = [];
  const cash = roundMoney(cashAmount);
  const online = roundMoney(onlineAmount);

  if (cash > EPS) {
    const row = await postLedgerEntry({
      businessId,
      branchId,
      accountType: 'CASH',
      direction,
      amount: cash,
      sourceType,
      sourceId,
      entryDate,
      notes,
      createdBy,
      skipEnabledCheck,
      skipBalanceCheck
    });
    if (row) posted.push(row);
  }
  if (online > EPS) {
    const row = await postLedgerEntry({
      businessId,
      branchId,
      accountType: 'BANK',
      direction,
      amount: online,
      sourceType,
      sourceId,
      entryDate,
      notes,
      createdBy,
      skipEnabledCheck,
      skipBalanceCheck
    });
    if (row) posted.push(row);
  }
  return posted;
}

export async function recordDepositOrWithdrawal({
  businessId,
  branchId,
  accountType,
  kind,
  amount,
  movementTypeId,
  notes = '',
  entryDate = new Date(),
  createdBy = null
}) {
  if (!(await isCashAndBankEnabled(businessId))) {
    const err = new Error('Cash & Bank is disabled');
    err.status = 403;
    throw err;
  }
  const type = await CashMovementType.findOne({
    _id: movementTypeId,
    businessId: bizOid(businessId),
    kind,
    isActive: true
  }).lean();
  if (!type) {
    const err = new Error('Select a valid movement type');
    err.status = 400;
    throw err;
  }

  const direction = kind === 'DEPOSIT' ? 'IN' : 'OUT';
  return postLedgerEntry({
    businessId,
    branchId,
    accountType,
    direction,
    amount,
    sourceType: kind,
    sourceId: null,
    movementTypeId: type._id,
    notes: notes || type.name,
    entryDate,
    createdBy
  });
}

export async function recordTransfer({
  businessId,
  branchId,
  fromAccountType,
  toAccountType,
  amount,
  notes = '',
  entryDate = new Date(),
  createdBy = null
}) {
  if (!(await isCashAndBankEnabled(businessId))) {
    const err = new Error('Cash & Bank is disabled');
    err.status = 403;
    throw err;
  }
  if (fromAccountType === toAccountType) {
    const err = new Error('Choose different accounts for transfer');
    err.status = 400;
    throw err;
  }
  const groupId = crypto.randomUUID();
  const amt = roundMoney(amount);
  const out = await postLedgerEntry({
    businessId,
    branchId,
    accountType: fromAccountType,
    direction: 'OUT',
    amount: amt,
    sourceType: 'TRANSFER',
    transferGroupId: groupId,
    notes: notes || `Transfer to ${toAccountType}`,
    entryDate,
    createdBy
  });
  const inn = await postLedgerEntry({
    businessId,
    branchId,
    accountType: toAccountType,
    direction: 'IN',
    amount: amt,
    sourceType: 'TRANSFER',
    transferGroupId: groupId,
    notes: notes || `Transfer from ${fromAccountType}`,
    entryDate,
    createdBy
  });
  return { transferGroupId: groupId, out, in: inn };
}

export async function setOpeningBalance({
  businessId,
  branchId,
  accountType,
  openingBalance,
  openingDate = new Date(),
  createdBy = null
}) {
  if (!(await isCashAndBankEnabled(businessId))) {
    const err = new Error('Cash & Bank is disabled');
    err.status = 403;
    throw err;
  }
  await ensureMoneyAccountsForBranch(businessId, branchId, { userId: createdBy });
  const account = await MoneyAccount.findOne({
    businessId: bizOid(businessId),
    branchId: branchOid(branchId),
    accountType
  });
  if (!account) {
    const err = new Error('Account not found');
    err.status = 404;
    throw err;
  }

  // Remove prior OPENING rows for this account, then rebuild
  await MoneyLedger.deleteMany({
    businessId: account.businessId,
    branchId: account.branchId,
    accountType,
    sourceType: 'OPENING'
  });

  const opening = roundMoney(Math.max(0, Number(openingBalance) || 0));
  account.openingBalance = opening;
  account.openingDate = openingDate || new Date();
  account.currentBalance = 0;
  await account.save();

  // Replay: opening first, then all non-opening chronologically with new balances
  const rest = await MoneyLedger.find({
    businessId: account.businessId,
    branchId: account.branchId,
    accountType,
    sourceType: { $ne: 'OPENING' }
  })
    .sort({ entryDate: 1, createdAt: 1 })
    .lean();

  await MoneyLedger.deleteMany({
    businessId: account.businessId,
    branchId: account.branchId,
    accountType
  });

  let bal = 0;
  if (opening > EPS) {
    bal = opening;
    await MoneyLedger.create({
      businessId: account.businessId,
      branchId: account.branchId,
      accountType,
      accountId: account._id,
      entryDate: account.openingDate,
      direction: 'IN',
      amount: opening,
      signedAmount: opening,
      balanceAfter: opening,
      sourceType: 'OPENING',
      sourceId: account._id,
      notes: 'Opening balance',
      createdBy
    });
  }

  for (const r of rest) {
    const signed = r.direction === 'IN' ? roundMoney(r.amount) : -roundMoney(r.amount);
    bal = roundMoney(Math.max(0, bal + signed));
    await MoneyLedger.create({
      ...r,
      _id: undefined,
      signedAmount: signed,
      balanceAfter: bal,
      createdAt: r.createdAt,
      updatedAt: new Date()
    });
  }

  account.currentBalance = bal;
  await account.save();
  return account.toObject();
}

/**
 * Cash / Bank book for a date range (one account).
 */
export async function getAccountBook({
  businessId,
  branchId,
  accountType,
  startUtc,
  endUtc
}) {
  await ensureMoneyAccountsForBranch(businessId, branchId);
  const opening = await getBalanceAsOf(
    businessId,
    branchId,
    accountType,
    new Date(new Date(startUtc).getTime() - 1)
  );

  const movements = await MoneyLedger.find({
    businessId: bizOid(businessId),
    branchId: branchOid(branchId),
    accountType,
    entryDate: { $gte: startUtc, $lt: endUtc },
    sourceType: { $ne: 'OPENING' }
  })
    .populate('movementTypeId', 'name kind isOwnerCapital')
    .populate('createdBy', 'name')
    .sort({ entryDate: 1, createdAt: 1 })
    .lean();

  let running = opening;
  let totalIn = 0;
  let totalOut = 0;

  const invoiceIds = movements
    .filter((m) => m.sourceType === 'INVOICE' && m.sourceId)
    .map((m) => m.sourceId);
  const invoiceNumberById = new Map();
  if (invoiceIds.length) {
    const invoices = await Invoice.find({ _id: { $in: invoiceIds } })
      .select('invoiceNumber')
      .lean();
    for (const inv of invoices) {
      invoiceNumberById.set(String(inv._id), inv.invoiceNumber || null);
    }
  }

  const rows = movements.map((m) => {
    if (m.direction === 'IN') {
      totalIn = roundMoney(totalIn + m.amount);
      running = roundMoney(running + m.amount);
    } else {
      totalOut = roundMoney(totalOut + m.amount);
      running = roundMoney(running - m.amount);
    }
    const isInvoice = m.sourceType === 'INVOICE' && m.sourceId;
    return {
      ...m,
      runningBalance: running,
      invoiceId: isInvoice ? String(m.sourceId) : null,
      invoiceNumber: isInvoice ? (invoiceNumberById.get(String(m.sourceId)) || null) : null
    };
  });

  const closing = roundMoney(opening + totalIn - totalOut);
  return {
    accountType,
    opening,
    totalIn,
    totalOut,
    closing,
    movements: rows
  };
}

/**
 * Period in/out totals without loading every ledger row (fast for all-branches summary).
 */
export async function getAccountPeriodTotals({ businessId, branchId, accountType, startUtc, endUtc }) {
  const opening = await getBalanceAsOf(
    businessId,
    branchId,
    accountType,
    new Date(new Date(startUtc).getTime() - 1)
  );
  const [agg] = await MoneyLedger.aggregate([
    {
      $match: {
        businessId: bizOid(businessId),
        branchId: branchOid(branchId),
        accountType,
        entryDate: { $gte: startUtc, $lt: endUtc },
        sourceType: { $ne: 'OPENING' }
      }
    },
    {
      $group: {
        _id: null,
        totalIn: {
          $sum: { $cond: [{ $eq: ['$direction', 'IN'] }, '$amount', 0] }
        },
        totalOut: {
          $sum: { $cond: [{ $eq: ['$direction', 'OUT'] }, '$amount', 0] }
        }
      }
    }
  ]);
  const totalIn = roundMoney(agg?.totalIn || 0);
  const totalOut = roundMoney(agg?.totalOut || 0);
  return {
    accountType,
    opening,
    totalIn,
    totalOut,
    closing: roundMoney(opening + totalIn - totalOut)
  };
}

export async function getCashBankSummary({ businessId, branchId = null, startUtc, endUtc }) {
  if (branchId) {
    const [cashBook, bankBook, balances] = await Promise.all([
      getAccountPeriodTotals({ businessId, branchId, accountType: 'CASH', startUtc, endUtc }),
      getAccountPeriodTotals({ businessId, branchId, accountType: 'BANK', startUtc, endUtc }),
      getBranchBalances(businessId, branchId, endUtc)
    ]);
    return {
      scope: 'branch',
      branchId,
      current: balances,
      cashBook,
      bankBook,
      period: {
        openingTotal: roundMoney(cashBook.opening + bankBook.opening),
        totalIn: roundMoney(cashBook.totalIn + bankBook.totalIn),
        totalOut: roundMoney(cashBook.totalOut + bankBook.totalOut),
        closingTotal: roundMoney(cashBook.closing + bankBook.closing)
      }
    };
  }

  const all = await getBusinessBalances(businessId, endUtc);
  const branchSummaries = await Promise.all(
    all.branches.map(async (b) => {
      const [cashBook, bankBook] = await Promise.all([
        getAccountPeriodTotals({ businessId, branchId: b.branchId, accountType: 'CASH', startUtc, endUtc }),
        getAccountPeriodTotals({ businessId, branchId: b.branchId, accountType: 'BANK', startUtc, endUtc })
      ]);
      return {
        ...b,
        period: {
          openingTotal: roundMoney(cashBook.opening + bankBook.opening),
          totalIn: roundMoney(cashBook.totalIn + bankBook.totalIn),
          totalOut: roundMoney(cashBook.totalOut + bankBook.totalOut),
          closingTotal: roundMoney(cashBook.closing + bankBook.closing)
        }
      };
    })
  );

  return {
    scope: 'all',
    current: { cash: all.cash, bank: all.bank, total: all.total },
    branches: branchSummaries,
    period: {
      openingTotal: roundMoney(branchSummaries.reduce((s, b) => s + b.period.openingTotal, 0)),
      totalIn: roundMoney(branchSummaries.reduce((s, b) => s + b.period.totalIn, 0)),
      totalOut: roundMoney(branchSummaries.reduce((s, b) => s + b.period.totalOut, 0)),
      closingTotal: roundMoney(branchSummaries.reduce((s, b) => s + b.period.closingTotal, 0))
    }
  };
}

/** Totals for financial statements (drawings / capital introduced). */
export async function getCashBookStatementExtras(businessId, startUtc, endUtc, branchId = null) {
  if (!(await isCashAndBankEnabled(businessId))) {
    return null;
  }

  const match = {
    businessId: bizOid(businessId),
    entryDate: { $gte: startUtc, $lte: endUtc },
    sourceType: { $in: ['DEPOSIT', 'WITHDRAWAL'] }
  };
  if (branchId) match.branchId = branchOid(branchId);

  const rows = await MoneyLedger.find(match)
    .populate('movementTypeId', 'name kind isOwnerCapital')
    .lean();

  let drawings = 0;
  let capitalIntroduced = 0;
  let otherDeposits = 0;
  let otherWithdrawals = 0;
  let closingCash = 0;
  let closingBank = 0;

  for (const r of rows) {
    const isCapital = r.movementTypeId?.isOwnerCapital !== false;
    if (r.sourceType === 'WITHDRAWAL') {
      if (isCapital) drawings = roundMoney(drawings + r.amount);
      else otherWithdrawals = roundMoney(otherWithdrawals + r.amount);
    } else if (r.sourceType === 'DEPOSIT') {
      if (isCapital) capitalIntroduced = roundMoney(capitalIntroduced + r.amount);
      else otherDeposits = roundMoney(otherDeposits + r.amount);
    }
  }

  if (branchId) {
    const bal = await getBranchBalances(businessId, branchId, endUtc);
    closingCash = bal.cash;
    closingBank = bal.bank;
  } else {
    const bal = await getBusinessBalances(businessId, endUtc);
    closingCash = bal.cash;
    closingBank = bal.bank;
  }

  return {
    drawings,
    capitalIntroduced,
    otherDeposits,
    otherWithdrawals,
    closingCash,
    closingBank,
    closingTotal: roundMoney(closingCash + closingBank)
  };
}

export async function openCashDay({ businessId, branchId, sessionDateKey, countedCash = null, notes = '', userId = null }) {
  if (!(await isCashAndBankEnabled(businessId))) {
    const err = new Error('Cash & Bank is disabled');
    err.status = 403;
    throw err;
  }
  const expected = await getBalanceAsOf(businessId, branchId, 'CASH', new Date());
  const sessionDate = new Date(`${sessionDateKey}T12:00:00.000Z`);

  const session = await CashDaySession.findOneAndUpdate(
    {
      businessId: bizOid(businessId),
      branchId: branchOid(branchId),
      sessionDateKey
    },
    {
      $setOnInsert: {
        sessionDate,
        openingCashExpected: expected,
        openingCashCounted: countedCash == null ? null : roundMoney(countedCash),
        status: 'OPEN',
        openedBy: userId,
        openedAt: new Date(),
        notes: notes || ''
      }
    },
    { upsert: true, new: true }
  );
  return session;
}

export async function closeCashDay({
  businessId,
  branchId,
  sessionDateKey,
  countedCash,
  notes = '',
  userId = null,
  postVarianceAdjustment = false
}) {
  if (!(await isCashAndBankEnabled(businessId))) {
    const err = new Error('Cash & Bank is disabled');
    err.status = 403;
    throw err;
  }

  let session = await CashDaySession.findOne({
    businessId: bizOid(businessId),
    branchId: branchOid(branchId),
    sessionDateKey
  });
  if (!session) {
    session = await openCashDay({ businessId, branchId, sessionDateKey, userId });
  }

  const expectedCash = await getBalanceAsOf(businessId, branchId, 'CASH', new Date());
  const expectedBank = await getBalanceAsOf(businessId, branchId, 'BANK', new Date());
  const counted = roundMoney(Number(countedCash) || 0);
  const variance = roundMoney(counted - expectedCash);

  session.closingCashExpected = expectedCash;
  session.closingBankExpected = expectedBank;
  session.closingCashCounted = counted;
  session.varianceCash = variance;
  session.status = 'CLOSED';
  session.closedBy = userId;
  session.closedAt = new Date();
  if (notes) session.notes = notes;
  await session.save();

  if (postVarianceAdjustment && Math.abs(variance) > EPS) {
    await postLedgerEntry({
      businessId,
      branchId,
      accountType: 'CASH',
      direction: variance > 0 ? 'IN' : 'OUT',
      amount: Math.abs(variance),
      sourceType: 'DAY_CLOSE_ADJUST',
      sourceId: session._id,
      notes: `Day close variance (${sessionDateKey})`,
      createdBy: userId
    });
    session.closingCashExpected = await getBalanceAsOf(businessId, branchId, 'CASH', new Date());
    session.varianceCash = roundMoney(counted - session.closingCashExpected);
    await session.save();
  }

  return session;
}
