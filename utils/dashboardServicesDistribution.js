import mongoose from 'mongoose';
import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';
import { withBranchOid } from './branchQuery.js';

/**
 * Service mix for dashboard: wash jobs, product sales, variable lines (custom names), and package sales.
 */
export async function getDashboardServicesDistribution(businessId, startUtc, endUtc, branchId = null) {
  const businessObjectId = new mongoose.Types.ObjectId(String(businessId));

  const deliveredInRangeMatch = withBranchOid({
    businessId: businessObjectId,
    status: 'DELIVERED',
    $or: [
      { actualDelivery: { $gte: startUtc, $lt: endUtc } },
      { actualDelivery: { $exists: false }, updatedAt: { $gte: startUtc, $lt: endUtc } }
    ]
  }, branchId);

  const jobLines = await Job.aggregate([
    { $match: deliveredInRangeMatch },
    { $unwind: '$services' },
    {
      $lookup: {
        from: 'services',
        localField: 'services.serviceId',
        foreignField: '_id',
        as: 'svc'
      }
    },
    { $unwind: { path: '$svc', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        lineName: {
          $let: {
            vars: {
              cn: { $trim: { input: { $ifNull: ['$services.customName', ''] } } }
            },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: '$$cn' }, 0] },
                '$$cn',
                { $ifNull: ['$svc.name', 'Other'] }
              ]
            }
          }
        }
      }
    },
    {
      $group: {
        _id: '$lineName',
        count: { $sum: 1 },
        revenue: { $sum: { $ifNull: ['$services.price', 0] } }
      }
    },
    {
      $project: {
        _id: 0,
        name: '$_id',
        count: 1,
        revenue: { $round: [{ $ifNull: ['$revenue', 0] }, 2] },
        value: '$count'
      }
    }
  ]);

  const packageLines = await Invoice.aggregate([
    {
      $match: withBranchOid({
        businessId: businessObjectId,
        saleType: 'PACKAGE',
        createdAt: { $gte: startUtc, $lt: endUtc }
      }, branchId)
    },
    {
      $group: {
        _id: { $ifNull: ['$packageName', 'Package sale'] },
        count: { $sum: 1 },
        revenue: { $sum: { $ifNull: ['$finalAmount', 0] } }
      }
    },
    {
      $project: {
        _id: 0,
        name: '$_id',
        count: 1,
        revenue: { $round: [{ $ifNull: ['$revenue', 0] }, 2] },
        value: '$count'
      }
    }
  ]);

  const merged = new Map();
  for (const row of [...jobLines, ...packageLines]) {
    const key = String(row.name || 'Other');
    const prev = merged.get(key) || { name: key, count: 0, revenue: 0, value: 0 };
    prev.count += Number(row.count) || 0;
    prev.revenue = Math.round((prev.revenue + (Number(row.revenue) || 0)) * 100) / 100;
    prev.value = prev.count;
    merged.set(key, prev);
  }

  return Array.from(merged.values()).sort(
    (a, b) => b.revenue - a.revenue || b.count - a.count || a.name.localeCompare(b.name)
  );
}
