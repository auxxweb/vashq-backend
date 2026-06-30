import mongoose from 'mongoose';
import Invoice from '../models/Invoice.model.js';

/** Dashboard KPIs for package template sales (saleType PACKAGE invoices). */
export async function getPackageSalesDashboardStats(businessId, startUtc, endUtc, branchId = null) {
  const businessObjectId = new mongoose.Types.ObjectId(String(businessId));
  const createdRange = { $gte: startUtc, $lt: endUtc };
  const packageMatch = {
    businessId: businessObjectId,
    saleType: 'PACKAGE',
    ...(branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {})
  };

  const [packageSalesCount, revenueAgg, collectedAgg, pendingCount] = await Promise.all([
    Invoice.countDocuments({ ...packageMatch, createdAt: createdRange }),
    Invoice.aggregate([
      { $match: { ...packageMatch, createdAt: createdRange } },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } }
    ]),
    Invoice.aggregate([
      {
        $match: {
          ...packageMatch,
          $or: [
            { paymentStatus: 'RECEIVED', paymentReceivedAt: createdRange },
            { settlementMode: 'CREDIT', saleConfirmedAt: createdRange }
          ]
        }
      },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } }
    ]),
    Invoice.countDocuments({
      ...packageMatch,
      createdAt: createdRange,
      paymentStatus: 'PENDING',
      $or: [{ settlementMode: { $ne: 'CREDIT' } }, { saleConfirmedAt: null }]
    })
  ]);

  return {
    packageSalesCount,
    packageSalesRevenue: Math.round((revenueAgg[0]?.total ?? 0) * 100) / 100,
    packageSalesCollected: Math.round((collectedAgg[0]?.total ?? 0) * 100) / 100,
    packageSalesPending: pendingCount
  };
}
