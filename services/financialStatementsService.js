import mongoose from 'mongoose';
import Invoice from '../models/Invoice.model.js';
import Expense from '../models/Expense.model.js';
import ExpenseType from '../models/ExpenseType.model.js';
import Job from '../models/Job.model.js';
import Business from '../models/Business.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import PlatformSettings from '../models/PlatformSettings.model.js';
import { sumExpenseChannelTotals } from '../utils/expensePayment.js';
import { roundMoney } from '../utils/invoicePayment.js';
import { invoiceSettlementCashOnline, creditCheckoutCashOnline } from '../utils/paymentChannelAmounts.js';
import { parseAiInsightsDateRange } from '../utils/aiInsightsDateRange.js';
import { buildCollectionReport, getTodayCashReceived } from './credit/creditReportsService.js';

export { parseAiInsightsDateRange as parseStatementDateRange };

const PAYMENT_EPS = 0.02;

function bizOid(id) {
  return new mongoose.Types.ObjectId(id);
}

function paidInvoiceDateFilter(start, end) {
  return {
    paymentStatus: 'RECEIVED',
    $or: [
      { paymentReceivedAt: { $gte: start, $lte: end } },
      {
        $and: [
          { $or: [{ paymentReceivedAt: { $exists: false } }, { paymentReceivedAt: null }] },
          { updatedAt: { $gte: start, $lte: end } }
        ]
      }
    ]
  };
}

function revenueInPeriodFilter(start, end) {
  return {
    $or: [
      paidInvoiceDateFilter(start, end),
      { settlementMode: 'CREDIT', saleConfirmedAt: { $gte: start, $lte: end } }
    ]
  };
}

async function getBusinessMeta(businessId) {
  const [business, settings, platform] = await Promise.all([
    Business.findById(businessId).select('businessName ownerName address phone email').lean(),
    BusinessSettings.findOne({ businessId }).select('currency gstNumber taxPercentage').lean(),
    PlatformSettings.findOne({}).select('defaultCurrency').lean()
  ]);
  return {
    businessName: business?.businessName || 'Business',
    ownerName: business?.ownerName || '',
    address: business?.address || '',
    phone: business?.phone || '',
    currency: settings?.currency || platform?.defaultCurrency || 'USD',
    gstNumber: settings?.gstNumber || ''
  };
}

async function gatherPeriodFinancials(businessId, start, end) {
  const bid = bizOid(businessId);
  const meta = await getBusinessMeta(businessId);

  const revenueInvoices = await Invoice.find({
    businessId: bid,
    ...revenueInPeriodFilter(start, end)
  }).select(
    'saleType finalAmount subtotal discount gstAmount paymentMethod paymentCashAmount paymentOnlineAmount paymentStatus advancePayment paymentReceivedAt settlementMode saleConfirmedAt outstandingAmount amountCollectedLater'
  ).lean();

  let jobSales = 0;
  let packageSales = 0;
  let salesCash = 0;
  let salesOnline = 0;
  let totalGst = 0;
  let totalDiscount = 0;
  let creditSalesInPeriod = 0;
  let creditOutstandingFromPeriod = 0;
  let cashSalesInPeriod = 0;

  for (const inv of revenueInvoices) {
    const amt = roundMoney(Number(inv.finalAmount) || 0);
    if (inv.saleType === 'PACKAGE') packageSales += amt;
    else jobSales += amt;

    const isCredit = inv.settlementMode === 'CREDIT';
    if (isCredit) {
      creditSalesInPeriod += amt;
      creditOutstandingFromPeriod += roundMoney(Number(inv.outstandingAmount) || 0);
    } else {
      cashSalesInPeriod += amt;
    }

    const pc = roundMoney(Number(inv.paymentCashAmount) || 0);
    const po = roundMoney(Number(inv.paymentOnlineAmount) || 0);
    if (pc + po > PAYMENT_EPS) {
      salesCash += pc;
      salesOnline += po;
    } else if (inv.paymentStatus === 'RECEIVED') {
      const ch = invoiceSettlementCashOnline(inv);
      salesCash += ch.cash;
      salesOnline += ch.online;
    } else if (isCredit) {
      const ch = creditCheckoutCashOnline(inv);
      salesCash += ch.cash;
      salesOnline += ch.online;
    }

    totalGst += roundMoney(Number(inv.gstAmount) || 0);
    const sub = roundMoney(Number(inv.subtotal) || 0);
    const pct = Number(inv.discount) || 0;
    totalDiscount += roundMoney(sub * (pct / 100));
  }

  jobSales = roundMoney(jobSales);
  packageSales = roundMoney(packageSales);
  const totalSales = roundMoney(jobSales + packageSales);
  salesCash = roundMoney(salesCash);
  salesOnline = roundMoney(salesOnline);
  creditSalesInPeriod = roundMoney(creditSalesInPeriod);
  creditOutstandingFromPeriod = roundMoney(creditOutstandingFromPeriod);
  cashSalesInPeriod = roundMoney(cashSalesInPeriod);

  const expenses = await Expense.find({
    businessId: bid,
    expenseDate: { $gte: start, $lte: end }
  }).populate('expenseTypeId', 'expenseName').lean();

  const expenseByCategory = {};
  for (const e of expenses) {
    const cat = e.expenseTypeId?.expenseName || 'Uncategorized';
    expenseByCategory[cat] = roundMoney((expenseByCategory[cat] || 0) + (Number(e.amount) || 0));
  }

  const expenseLines = Object.entries(expenseByCategory)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);

  const expenseTotals = sumExpenseChannelTotals(expenses);
  const totalExpenses = expenseTotals.totalAmount;

  const collectionsReport = await buildCollectionReport(businessId, start, end, false);
  const creditRecovery = roundMoney(collectionsReport.summary?.creditRecovery ?? 0);
  const collectionCash = roundMoney(collectionsReport.summary?.totalCash ?? 0);
  const collectionOnline = roundMoney(collectionsReport.summary?.totalOnline ?? 0);

  const endExclusive = new Date(end.getTime() + 1);
  const advanceRows = await Job.aggregate([
    { $match: { businessId: bid, createdAt: { $gte: start, $lte: end } } },
    {
      $addFields: {
        advCash: {
          $cond: [
            { $lte: [{ $ifNull: ['$advancePayment', 0] }, 0] },
            0,
            {
              $ifNull: [
                '$advanceCashAmount',
                { $cond: [{ $eq: ['$advancePaymentMethod', 'ONLINE'] }, 0, { $ifNull: ['$advancePayment', 0] }] }
              ]
            }
          ]
        },
        advOnline: {
          $cond: [
            { $lte: [{ $ifNull: ['$advancePayment', 0] }, 0] },
            0,
            {
              $ifNull: [
                '$advanceOnlineAmount',
                { $cond: [{ $eq: ['$advancePaymentMethod', 'ONLINE'] }, { $ifNull: ['$advancePayment', 0] }, 0] }
              ]
            }
          ]
        }
      }
    },
    { $group: { _id: null, advCash: { $sum: '$advCash' }, advOnline: { $sum: '$advOnline' } } }
  ]);
  const advCash = advanceRows[0]?.advCash ?? 0;
  const advOnline = advanceRows[0]?.advOnline ?? 0;
  const moneyInRaw = await getTodayCashReceived(businessId, start, endExclusive, advCash, advOnline);

  const cashInPeriod = roundMoney(moneyInRaw.todayCashReceivedCash);
  const bankInPeriod = roundMoney(moneyInRaw.todayCashReceivedOnline);
  const cashBalance = roundMoney(Math.max(0, cashInPeriod - expenseTotals.totalCashAmount));
  const bankBalance = roundMoney(Math.max(0, bankInPeriod - expenseTotals.totalOnlineAmount));

  const debtorsAgg = await Invoice.aggregate([
    {
      $match: {
        businessId: bid,
        settlementMode: 'CREDIT',
        outstandingAmount: { $gt: 0.01 },
        saleConfirmedAt: { $lte: end }
      }
    },
    { $group: { _id: null, total: { $sum: '$outstandingAmount' } } }
  ]);
  const debtors = roundMoney(debtorsAgg[0]?.total ?? 0);

  const netProfit = roundMoney(totalSales - totalExpenses);

  return {
    meta,
    jobSales,
    packageSales,
    totalSales,
    cashSalesInPeriod,
    creditSalesInPeriod,
    creditOutstandingFromPeriod,
    creditRecovery,
    salesCash,
    salesOnline,
    cashInPeriod,
    bankInPeriod,
    collectionCash,
    collectionOnline,
    cashBalance,
    bankBalance,
    debtors,
    totalDiscount: roundMoney(totalDiscount),
    totalGst: roundMoney(totalGst),
    expenseLines,
    expenseTotals,
    totalExpenses,
    netProfit,
    invoiceCount: revenueInvoices.length,
    expenseCount: expenses.length
  };
}

function pushTrialRow(rows, particulars, debit, credit) {
  const d = roundMoney(debit || 0);
  const c = roundMoney(credit || 0);
  if (d > 0.009 || c > 0.009) {
    rows.push({ particulars, lf: '', debit: d, credit: c });
  }
}

function balanceTrialRows(rows) {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const row of rows) {
    totalDebit += roundMoney(row.debit || 0);
    totalCredit += roundMoney(row.credit || 0);
  }
  const diff = roundMoney(totalDebit - totalCredit);
  if (Math.abs(diff) > 0.009) {
    if (diff > 0) {
      pushTrialRow(rows, 'Capital A/c', 0, diff);
    } else {
      pushTrialRow(rows, 'Capital A/c', Math.abs(diff), 0);
    }
  }
  totalDebit = 0;
  totalCredit = 0;
  for (const row of rows) {
    totalDebit += roundMoney(row.debit || 0);
    totalCredit += roundMoney(row.credit || 0);
  }
  return {
    rows,
    totalDebit: roundMoney(totalDebit),
    totalCredit: roundMoney(totalCredit)
  };
}

/**
 * Trial balance — car wash accounts (sales, expenses, credit / pay-later).
 */
export async function buildTrialBalance(businessId, range, from, to) {
  const { start, end, label } = parseAiInsightsDateRange(range, from, to);
  const data = await gatherPeriodFinancials(businessId, start, end);
  const rows = [];

  pushTrialRow(rows, 'Cash A/c', data.cashBalance, 0);
  pushTrialRow(rows, 'Bank A/c', data.bankBalance, 0);
  pushTrialRow(rows, 'Debtors A/c (Amount due / Credit)', data.debtors, 0);

  for (const line of data.expenseLines) {
    const name = line.name.toLowerCase().includes('salary')
      ? 'Salaries A/c'
      : `${line.name} A/c`;
    pushTrialRow(rows, name, line.amount, 0);
  }

  pushTrialRow(rows, 'Sales A/c (Car wash & packages)', 0, data.totalSales);

  const { rows: balancedRows, totalDebit, totalCredit } = balanceTrialRows(rows);

  return {
    type: 'trial_balance',
    period: { start, end, label },
    meta: data.meta,
    rows: balancedRows,
    totals: { debit: totalDebit, credit: totalCredit },
    notes: {
      cashReceived: data.cashInPeriod,
      onlineReceived: data.bankInPeriod,
      creditRecovery: data.creditRecovery,
      creditOutstanding: data.debtors
    },
    disclaimer: 'Derived from VashQ job & package sales, daily expenses, cash/online collections, and pay-later (credit) balances for the selected period.'
  };
}

/**
 * Trading & Profit and Loss — T-account format for car wash (no inventory).
 */
export async function buildProfitLossStatement(businessId, range, from, to) {
  const { start, end, label } = parseAiInsightsDateRange(range, from, to);
  const data = await gatherPeriodFinancials(businessId, start, end);

  const grossProfit = data.totalSales;
  const netProfit = data.netProfit;

  const tradingDebit = [
    { label: 'Gross Profit c/d', amount: grossProfit, prefix: 'To', bold: true }
  ];

  const tradingCredit = [];
  if (data.jobSales > 0.009) {
    tradingCredit.push({ label: 'Sales (Jobs & services)', amount: data.jobSales, prefix: 'By' });
  }
  if (data.packageSales > 0.009) {
    tradingCredit.push({ label: 'Sales (Packages)', amount: data.packageSales, prefix: 'By' });
  }
  if (tradingCredit.length === 0 && data.totalSales > 0.009) {
    tradingCredit.push({ label: 'Sales', amount: data.totalSales, prefix: 'By' });
  }

  const tradingDebitTotal = roundMoney(tradingDebit.reduce((s, r) => s + r.amount, 0));
  const tradingCreditTotal = roundMoney(tradingCredit.reduce((s, r) => s + r.amount, 0));

  const plDebit = data.expenseLines.map((line) => ({
    label: line.name,
    amount: line.amount,
    prefix: 'To'
  }));

  if (netProfit > 0.009) {
    plDebit.push({ label: 'Net Profit', amount: netProfit, prefix: 'To', bold: true });
  }

  const plCredit = [
    { label: 'Gross Profit b/d', amount: grossProfit, prefix: 'By', bold: true }
  ];

  if (netProfit < -0.009) {
    plCredit.push({ label: 'Net Loss', amount: Math.abs(netProfit), prefix: 'By', bold: true });
  }

  const plDebitTotal = roundMoney(plDebit.reduce((s, r) => s + r.amount, 0));
  const plCreditTotal = roundMoney(plCredit.reduce((s, r) => s + r.amount, 0));

  return {
    type: 'profit_loss',
    period: { start, end, label },
    meta: data.meta,
    trading: {
      debit: tradingDebit,
      credit: tradingCredit,
      debitTotal: tradingDebitTotal,
      creditTotal: tradingCreditTotal
    },
    profitLoss: {
      debit: plDebit,
      credit: plCredit,
      debitTotal: plDebitTotal,
      creditTotal: plCreditTotal
    },
    summary: {
      totalSales: data.totalSales,
      jobSales: data.jobSales,
      packageSales: data.packageSales,
      cashSales: data.cashSalesInPeriod,
      creditSales: data.creditSalesInPeriod,
      creditRecovery: data.creditRecovery,
      creditOutstanding: data.debtors,
      totalExpenses: data.totalExpenses,
      grossProfit,
      netProfit
    },
    disclaimer: 'Car wash service business — no opening/closing stock. Sales include paid jobs, packages, and pay-later (credit) invoices. Credit recovery shows amount-due collections in the period.'
  };
}

export async function buildSalesExpensesStatement(businessId, range, from, to) {
  const { start, end, label } = parseAiInsightsDateRange(range, from, to);
  const data = await gatherPeriodFinancials(businessId, start, end);

  return {
    type: 'sales_expenses',
    period: { start, end, label },
    meta: data.meta,
    sales: {
      jobServices: data.jobSales,
      packageSales: data.packageSales,
      total: data.totalSales,
      cashReceived: data.cashInPeriod,
      onlineReceived: data.bankInPeriod,
      creditSales: data.creditSalesInPeriod,
      creditRecovery: data.creditRecovery,
      gstCollected: data.totalGst,
      discountsGiven: data.totalDiscount,
      invoiceCount: data.invoiceCount
    },
    expenses: {
      lines: data.expenseLines,
      total: data.totalExpenses,
      cashPaid: data.expenseTotals.totalCashAmount,
      onlinePaid: data.expenseTotals.totalOnlineAmount,
      count: data.expenseCount
    },
    summary: {
      totalSales: data.totalSales,
      totalExpenses: data.totalExpenses,
      netProfit: data.netProfit,
      netMarginPct: data.totalSales > 0 ? roundMoney((data.netProfit / data.totalSales) * 100) : 0
    },
    disclaimer: 'Sales include paid invoices and pay-later (credit) sales confirmed in the period.'
  };
}

export const buildProfitAndLoss = buildSalesExpensesStatement;
