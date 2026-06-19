import mongoose from 'mongoose';
import PaymentCollection from '../../models/PaymentCollection.model.js';
import Invoice from '../../models/Invoice.model.js';
import Customer from '../../models/Customer.model.js';
import User from '../../models/User.model.js';
import { roundMoney } from '../../utils/creditPayment.js';
import { invoiceSettlementAggregationStages } from '../../utils/paymentChannelAmounts.js';
import { deriveCollectionDisplayStatus, getTotalCollected } from './outstandingService.js';

function roundSummary(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export async function buildCollectionReport(businessId, start, end, exclusiveEnd = true) {
  const bizOid = new mongoose.Types.ObjectId(String(businessId));
  const dateRange = exclusiveEnd ? { $gte: start, $lt: end } : { $gte: start, $lte: end };

  const [collections, creditCheckouts] = await Promise.all([
    PaymentCollection.find({
      businessId: bizOid,
      collectionDate: dateRange
    })
      .populate('customerId', 'name phone')
      .populate('collectedBy', 'name email')
      .sort({ collectionDate: -1, createdAt: -1 })
      .lean(),
    Invoice.find({
      businessId: bizOid,
      settlementMode: 'CREDIT',
      saleConfirmedAt: dateRange,
      $or: [
        { paymentCashAmount: { $gt: 0.01 } },
        { paymentOnlineAmount: { $gt: 0.01 } }
      ]
    })
      .select('invoiceNumber customerId customerName customerPhone saleConfirmedAt amountCollectedAtCheckout paymentMethod paymentCashAmount paymentOnlineAmount finalAmount outstandingAmount advancePayment')
      .sort({ saleConfirmedAt: -1 })
      .lean()
  ]);

  const checkoutSettlement = (inv) =>
    roundMoney((Number(inv.paymentCashAmount) || 0) + (Number(inv.paymentOnlineAmount) || 0));

  const recoveryRows = collections.map((c) => ({
    rowType: 'credit_recovery',
    _id: c._id,
    date: c.collectionDate,
    customerId: c.customerId?._id || c.customerId,
    customerName: c.customerId?.name || '',
    customerPhone: c.customerId?.phone || '',
    amount: roundMoney(c.amount),
    paymentMethod: c.paymentMethod,
    paymentCashAmount: roundMoney(c.paymentCashAmount),
    paymentOnlineAmount: roundMoney(c.paymentOnlineAmount),
    allocationMode: c.allocationMode,
    invoicesAffected: (c.allocations || []).map((a) => a.invoiceNumber).filter(Boolean).join(', '),
    notes: c.notes || '',
    collectedBy: c.collectedBy?.name || c.collectedBy?.email || ''
  }));

  const checkoutRows = creditCheckouts.map((inv) => ({
    rowType: 'credit_checkout',
    _id: inv._id,
    date: inv.saleConfirmedAt,
    customerId: inv.customerId,
    customerName: inv.customerName || '',
    customerPhone: inv.customerPhone || '',
    amount: checkoutSettlement(inv),
    paymentMethod: inv.paymentMethod,
    paymentCashAmount: roundMoney(inv.paymentCashAmount),
    paymentOnlineAmount: roundMoney(inv.paymentOnlineAmount),
    allocationMode: 'CHECKOUT',
    invoicesAffected: inv.invoiceNumber || '',
    notes: '',
    collectedBy: ''
  }));

  const data = [...recoveryRows, ...checkoutRows].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  let totalCash = 0;
  let totalOnline = 0;
  let creditRecovery = 0;
  let checkoutCollection = 0;

  for (const c of collections) {
    creditRecovery += Number(c.amount) || 0;
    totalCash += Number(c.paymentCashAmount) || 0;
    totalOnline += Number(c.paymentOnlineAmount) || 0;
  }
  for (const inv of creditCheckouts) {
    const settled = checkoutSettlement(inv);
    checkoutCollection += settled;
    totalCash += Number(inv.paymentCashAmount) || 0;
    totalOnline += Number(inv.paymentOnlineAmount) || 0;
  }

  const totalCollection = creditRecovery + checkoutCollection;

  return {
    data,
    summary: {
      totalRecords: data.length,
      totalCollection: roundSummary(totalCollection),
      totalCash: roundSummary(totalCash),
      totalOnline: roundSummary(totalOnline),
      creditRecovery: roundSummary(creditRecovery),
      checkoutCollection: roundSummary(checkoutCollection)
    },
    start,
    end
  };
}

export async function buildOutstandingReport(businessId, filters = {}) {
  const bizOid = new mongoose.Types.ObjectId(String(businessId));
  const now = new Date();
  const minAmount = Math.max(0, Number(filters.minAmount) || 0);
  const overdueOnly = filters.overdueOnly === 'true' || filters.overdueOnly === true;
  const customerId = filters.customerId;

  const invoiceQuery = {
    businessId: bizOid,
    settlementMode: 'CREDIT',
    saleConfirmedAt: { $ne: null },
    outstandingAmount: { $gt: 0.01 }
  };
  if (customerId && mongoose.isValidObjectId(String(customerId))) {
    invoiceQuery.customerId = new mongoose.Types.ObjectId(String(customerId));
  }
  if (minAmount > 0) {
    invoiceQuery.outstandingAmount = { $gte: minAmount };
  }

  const invoices = await Invoice.find(invoiceQuery)
    .select('invoiceNumber customerId customerName customerPhone saleConfirmedAt creditDueDate finalAmount outstandingAmount paymentStatus amountCollectedAtCheckout amountCollectedLater advancePayment paymentCashAmount paymentOnlineAmount')
    .sort({ saleConfirmedAt: 1, createdAt: 1 })
    .lean();

  const filtered = invoices.filter((inv) => {
    if (!overdueOnly) return true;
    return inv.creditDueDate && new Date(inv.creditDueDate) < now;
  });

  const customerIds = [...new Set(filtered.map((i) => String(i.customerId)).filter(Boolean))];
  const customers = customerIds.length
    ? await Customer.find({ _id: { $in: customerIds }, businessId: bizOid }).select('name phone').lean()
    : [];
  const customerMap = new Map(customers.map((c) => [String(c._id), c]));

  const byCustomer = new Map();
  for (const inv of filtered) {
    const cid = String(inv.customerId || '');
    if (!cid) continue;
    if (!byCustomer.has(cid)) {
      const cust = customerMap.get(cid);
      byCustomer.set(cid, {
        customerId: inv.customerId,
        customerName: cust?.name || inv.customerName || '—',
        customerPhone: cust?.phone || inv.customerPhone || '',
        outstandingAmount: 0,
        openInvoiceCount: 0,
        oldestDueDate: null,
        oldestSaleDate: null,
        invoices: []
      });
    }
    const row = byCustomer.get(cid);
    row.outstandingAmount = roundSummary(row.outstandingAmount + (Number(inv.outstandingAmount) || 0));
    row.openInvoiceCount += 1;
    const saleDate = inv.saleConfirmedAt ? new Date(inv.saleConfirmedAt) : null;
    if (saleDate && (!row.oldestSaleDate || saleDate < row.oldestSaleDate)) {
      row.oldestSaleDate = saleDate;
    }
    const dueDate = inv.creditDueDate ? new Date(inv.creditDueDate) : null;
    if (dueDate && (!row.oldestDueDate || dueDate < row.oldestDueDate)) {
      row.oldestDueDate = dueDate;
    }
    row.invoices.push({
      _id: inv._id,
      invoiceNumber: inv.invoiceNumber,
      saleConfirmedAt: inv.saleConfirmedAt,
      creditDueDate: inv.creditDueDate,
      finalAmount: inv.finalAmount,
      paidAmount: getTotalCollected(inv),
      outstandingAmount: inv.outstandingAmount,
      collectionStatus: deriveCollectionDisplayStatus(inv),
      isOverdue: !!(dueDate && dueDate < now)
    });
  }

  const data = Array.from(byCustomer.values()).sort(
    (a, b) => b.outstandingAmount - a.outstandingAmount
  );

  let totalOutstanding = 0;
  let overdueAmount = 0;
  let overdueCustomers = 0;
  const overdueCustomerSet = new Set();

  for (const row of data) {
    totalOutstanding += row.outstandingAmount;
    const hasOverdue = row.invoices.some((i) => i.isOverdue);
    if (hasOverdue) {
      overdueCustomers += 1;
      overdueCustomerSet.add(String(row.customerId));
      overdueAmount += row.invoices.filter((i) => i.isOverdue).reduce((s, i) => s + (Number(i.outstandingAmount) || 0), 0);
    }
  }

  return {
    data,
    summary: {
      customerCount: data.length,
      totalOutstanding: roundSummary(totalOutstanding),
      openInvoiceCount: filtered.length,
      overdueCustomerCount: overdueCustomers,
      overdueAmount: roundSummary(overdueAmount)
    }
  };
}

/** Unified cash-in for the period: advances + full-pay checkout + credit checkout + credit recovery (no double count). */
export async function getTodayCashReceived(businessId, startUtc, endUtc, advanceCash = 0, advanceOnline = 0) {
  const bizOid = new mongoose.Types.ObjectId(String(businessId));

  const paidInWindow = {
    paymentStatus: 'RECEIVED',
    settlementMode: { $ne: 'CREDIT' },
    $or: [
      { paymentReceivedAt: { $gte: startUtc, $lt: endUtc } },
      {
        $and: [
          { $or: [{ paymentReceivedAt: { $exists: false } }, { paymentReceivedAt: null }] },
          { updatedAt: { $gte: startUtc, $lt: endUtc } }
        ]
      }
    ]
  };

  const [fullPayJobAgg, fullPayPackageAgg, collections, creditCheckoutAgg] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          businessId: bizOid,
          jobId: { $exists: true, $ne: null },
          saleType: { $nin: ['PACKAGE'] },
          ...paidInWindow
        }
      },
      {
        $lookup: {
          from: 'jobs',
          let: { jid: '$jobId' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$_id', '$$jid'] },
                businessId: bizOid,
                status: 'DELIVERED'
              }
            },
            { $limit: 1 }
          ],
          as: 'job'
        }
      },
      { $match: { job: { $ne: [] } } },
      ...invoiceSettlementAggregationStages(),
      { $group: { _id: null, cash: { $sum: '$settleCash' }, online: { $sum: '$settleOnline' } } }
    ]),
    Invoice.aggregate([
      {
        $match: {
          businessId: bizOid,
          saleType: 'PACKAGE',
          ...paidInWindow
        }
      },
      ...invoiceSettlementAggregationStages(),
      { $group: { _id: null, cash: { $sum: '$settleCash' }, online: { $sum: '$settleOnline' } } }
    ]),
    PaymentCollection.find({
      businessId: bizOid,
      collectionDate: { $gte: startUtc, $lt: endUtc }
    }).select('amount paymentCashAmount paymentOnlineAmount').lean(),
    Invoice.aggregate([
      {
        $match: {
          businessId: bizOid,
          settlementMode: 'CREDIT',
          saleConfirmedAt: { $gte: startUtc, $lt: endUtc },
          $or: [
            { paymentCashAmount: { $gt: 0.01 } },
            { paymentOnlineAmount: { $gt: 0.01 } }
          ]
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $add: [{ $ifNull: ['$paymentCashAmount', 0] }, { $ifNull: ['$paymentOnlineAmount', 0] }] } },
          cash: { $sum: '$paymentCashAmount' },
          online: { $sum: '$paymentOnlineAmount' }
        }
      }
    ])
  ]);

  let todayCreditRecovery = 0;
  let recoveryCash = 0;
  let recoveryOnline = 0;
  for (const c of collections) {
    todayCreditRecovery += Number(c.amount) || 0;
    recoveryCash += Number(c.paymentCashAmount) || 0;
    recoveryOnline += Number(c.paymentOnlineAmount) || 0;
  }

  const fullPayCash = (fullPayJobAgg[0]?.cash ?? 0) + (fullPayPackageAgg[0]?.cash ?? 0);
  const fullPayOnline = (fullPayJobAgg[0]?.online ?? 0) + (fullPayPackageAgg[0]?.online ?? 0);
  const checkout = creditCheckoutAgg[0] || { total: 0, cash: 0, online: 0 };
  const creditCheckoutCash = checkout.cash || 0;
  const creditCheckoutOnline = checkout.online || 0;

  const advCash = roundSummary(advanceCash);
  const advOnline = roundSummary(advanceOnline);
  const todayCashReceivedCash = roundSummary(advCash + fullPayCash + creditCheckoutCash + recoveryCash);
  const todayCashReceivedOnline = roundSummary(advOnline + fullPayOnline + creditCheckoutOnline + recoveryOnline);

  return {
    todayCashReceived: roundSummary(todayCashReceivedCash + todayCashReceivedOnline),
    todayCashReceivedCash,
    todayCashReceivedOnline,
    todayFullPayCheckout: roundSummary(fullPayCash + fullPayOnline),
    todayCreditCheckout: roundSummary(checkout.total || 0),
    todayCreditRecovery: roundSummary(todayCreditRecovery),
    todayAdvances: roundSummary(advCash + advOnline)
  };
}

export async function getCreditDashboardStats(businessId, startUtc, endUtc) {
  const bizOid = new mongoose.Types.ObjectId(String(businessId));
  const now = new Date();

  const [openInvoices, topAgg] = await Promise.all([
    Invoice.find({
      businessId: bizOid,
      settlementMode: 'CREDIT',
      saleConfirmedAt: { $ne: null },
      outstandingAmount: { $gt: 0.01 }
    }).select('customerId outstandingAmount creditDueDate').lean(),
    Invoice.aggregate([
      {
        $match: {
          businessId: bizOid,
          settlementMode: 'CREDIT',
          outstandingAmount: { $gt: 0.01 },
          saleConfirmedAt: { $ne: null }
        }
      },
      {
        $group: {
          _id: '$customerId',
          totalOutstanding: { $sum: '$outstandingAmount' },
          invoiceCount: { $sum: 1 }
        }
      },
      { $sort: { totalOutstanding: -1 } },
      { $limit: 5 }
    ])
  ]);

  let totalOutstandingReceivables = 0;
  let overdueOutstandingAmount = 0;
  let overdueOutstandingCount = 0;

  for (const inv of openInvoices) {
    totalOutstandingReceivables += Number(inv.outstandingAmount) || 0;
    if (inv.creditDueDate && new Date(inv.creditDueDate) < now) {
      overdueOutstandingAmount += Number(inv.outstandingAmount) || 0;
      overdueOutstandingCount += 1;
    }
  }

  const topIds = topAgg.map((r) => r._id).filter(Boolean);
  const topCustomers = topIds.length
    ? await Customer.find({ _id: { $in: topIds }, businessId: bizOid }).select('name phone').lean()
    : [];
  const topMap = new Map(topCustomers.map((c) => [String(c._id), c]));

  const topOutstandingCustomers = topAgg.map((row) => ({
    customerId: row._id,
    customerName: topMap.get(String(row._id))?.name || '—',
    customerPhone: topMap.get(String(row._id))?.phone || '',
    outstandingAmount: roundSummary(row.totalOutstanding),
    openInvoiceCount: row.invoiceCount
  }));

  return {
    totalOutstandingReceivables: roundSummary(totalOutstandingReceivables),
    overdueOutstandingAmount: roundSummary(overdueOutstandingAmount),
    overdueOutstandingCount,
    topOutstandingCustomers
  };
}
