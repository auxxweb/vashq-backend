import mongoose from 'mongoose';
import Invoice from '../models/Invoice.model.js';
import { invoiceCollectedAmountExpression } from './dashboardFinancialSync.js';

/** Dashboard KPIs for package template sales (saleType PACKAGE invoices). */
export async function getPackageSalesDashboardStats(businessId, startUtc, endUtc, branchId = null) {
  const businessObjectId = new mongoose.Types.ObjectId(String(businessId));
  const createdRange = { $gte: startUtc, $lt: endUtc };
  const packageMatch = {
    businessId: businessObjectId,
    saleType: 'PACKAGE',
    createdAt: createdRange,
    ...(branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {})
  };

  const [packageSalesCount, revenueAgg, collectedAgg, pendingCount] = await Promise.all([
    Invoice.countDocuments(packageMatch),
    Invoice.aggregate([
      { $match: packageMatch },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } }
    ]),
    Invoice.aggregate([
      { $match: packageMatch },
      { $group: { _id: null, total: { $sum: invoiceCollectedAmountExpression() } } }
    ]),
    Invoice.countDocuments({
      ...packageMatch,
      $or: [
        { outstandingAmount: { $gt: 0.01 } },
        {
          paymentStatus: 'PENDING',
          $or: [
            { settlementMode: { $ne: 'CREDIT' } },
            { saleConfirmedAt: null }
          ]
        }
      ]
    })
  ]);

  return {
    packageSalesCount,
    packageSalesRevenue: Math.round((revenueAgg[0]?.total ?? 0) * 100) / 100,
    packageSalesCollected: Math.round((collectedAgg[0]?.total ?? 0) * 100) / 100,
    packageSalesPending: pendingCount
  };
}
