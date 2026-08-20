import mongoose from 'mongoose';
import BusinessSettings from '../models/BusinessSettings.model.js';
import OtherRevenue from '../models/OtherRevenue.model.js';
import { expensePaidAmountAggregationExpr } from './expensePayment.js';

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function bizOid(businessId) {
  return new mongoose.Types.ObjectId(String(businessId));
}

function branchClause(branchId) {
  return branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};
}

export async function isOtherRevenueEnabled(businessId) {
  const settings = await BusinessSettings.findOne({ businessId: bizOid(businessId) })
    .select('otherRevenueEnabled')
    .lean();
  return !!settings?.otherRevenueEnabled;
}

/**
 * Other revenue billed in period (full entry amount by revenueDate).
 */
export async function sumOtherRevenueBilled(businessId, startUtc, endUtc, branchId = null) {
  const rows = await OtherRevenue.aggregate([
    {
      $match: {
        businessId: bizOid(businessId),
        ...branchClause(branchId),
        revenueDate: { $gte: startUtc, $lt: endUtc }
      }
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  return roundMoney(rows[0]?.total ?? 0);
}

/**
 * Other revenue cash/online collected in period (same paid-amount rules as expenses).
 */
export async function sumOtherRevenueCollectedChannels(businessId, startUtc, endUtc, branchId = null) {
  const rows = await OtherRevenue.aggregate([
    {
      $match: {
        businessId: bizOid(businessId),
        ...branchClause(branchId),
        revenueDate: { $gte: startUtc, $lt: endUtc }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: expensePaidAmountAggregationExpr() },
        cash: { $sum: { $ifNull: ['$paymentCashAmount', 0] } },
        online: { $sum: { $ifNull: ['$paymentOnlineAmount', 0] } }
      }
    }
  ]);
  const cash = roundMoney(rows[0]?.cash ?? 0);
  const online = roundMoney(rows[0]?.online ?? 0);
  const total = roundMoney(rows[0]?.total ?? cash + online);
  return { total, cash, online };
}

/**
 * Load other-revenue rows for sales report (mapped to a sales-like shape).
 */
export async function loadOtherRevenueSalesRows(businessId, startUtc, endUtc, branchId = null) {
  const query = {
    businessId: bizOid(businessId),
    ...branchClause(branchId),
    revenueDate: { $gte: startUtc, $lt: endUtc }
  };
  const rows = await OtherRevenue.find(query)
    .populate('otherRevenueTypeId', 'revenueName')
    .populate('createdBy', 'name email')
    .sort({ revenueDate: -1, createdAt: -1 })
    .lean();

  return rows.map((row) => ({
    _id: row._id,
    saleType: 'other-revenue',
    saleSubType: 'other-revenue',
    finalAmount: roundMoney(Number(row.amount) || 0),
    subtotal: roundMoney(Number(row.amount) || 0),
    revenueDate: row.revenueDate,
    paymentReceivedAt: row.revenueDate,
    createdAt: row.createdAt,
    paymentMethod: row.paymentMethod || 'CASH',
    paymentCashAmount: roundMoney(Number(row.paymentCashAmount) || 0),
    paymentOnlineAmount: roundMoney(Number(row.paymentOnlineAmount) || 0),
    settlementMode: row.settlementMode || 'FULL',
    outstandingAmount: roundMoney(Number(row.outstandingAmount) || 0),
    paymentStatus: row.paymentStatus || 'PAID',
    creditDueDate: row.creditDueDate || null,
    notes: row.notes || '',
    receiptImage: row.receiptImage || '',
    otherRevenueTypeName: row.otherRevenueTypeId?.revenueName || '',
    otherRevenueTypeId: row.otherRevenueTypeId,
    createdBy: row.createdBy,
    customerName: row.otherRevenueTypeId?.revenueName || 'Other revenue'
  }));
}
