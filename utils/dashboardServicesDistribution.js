import mongoose from 'mongoose';
import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';
import { withBranchOid } from './branchQuery.js';

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Service mix for dashboard: wash jobs, product sales, variable lines (custom names), and package sales.
 * Job-line revenue is scaled to invoice.finalAmount so GST (when enabled) matches billed sales.
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

  const jobs = await Job.find(deliveredInRangeMatch)
    .select('_id services totalPrice')
    .lean();

  const jobIds = jobs.map((j) => j._id);
  const invoices = jobIds.length
    ? await Invoice.find(
      withBranchOid(
        {
          businessId: businessObjectId,
          jobId: { $in: jobIds }
        },
        branchId
      )
    )
      .select('jobId finalAmount gstAmount subtotal')
      .lean()
    : [];

  const invoiceByJobId = new Map(invoices.map((inv) => [String(inv.jobId), inv]));

  const serviceCatalogIds = [];
  for (const job of jobs) {
    for (const row of job.services || []) {
      const sid = row.serviceId?._id || row.serviceId;
      if (sid) serviceCatalogIds.push(sid);
    }
  }

  let nameByServiceId = new Map();
  if (serviceCatalogIds.length) {
    const Service = (await import('../models/Service.model.js')).default;
    const catalog = await Service.find({ _id: { $in: serviceCatalogIds } })
      .select('name')
      .lean();
    nameByServiceId = new Map(catalog.map((s) => [String(s._id), s.name]));
  }

  const jobLineTotals = new Map();
  for (const job of jobs) {
    const lines = Array.isArray(job.services) ? job.services : [];
    const lineBases = lines.map((row) => {
      const qty = Math.max(1, Number(row.quantity) || 1);
      const unit = Number(row.price) || 0;
      const custom = String(row.customName || '').trim();
      const sid = String(row.serviceId?._id || row.serviceId || '');
      const name = custom || nameByServiceId.get(sid) || 'Other';
      return { name, base: roundMoney(unit * qty) };
    });
    const linesBaseTotal = roundMoney(lineBases.reduce((s, l) => s + l.base, 0));
    const inv = invoiceByJobId.get(String(job._id));
    const billed = inv
      ? roundMoney(Number(inv.finalAmount) || 0)
      : roundMoney(Number(job.totalPrice) || linesBaseTotal);

    // Allocate billed (GST-inclusive when GST on) across lines by pre-tax line share
    if (!lineBases.length) continue;
    if (linesBaseTotal <= 0) {
      const share = roundMoney(billed / lineBases.length);
      for (const line of lineBases) {
        const prev = jobLineTotals.get(line.name) || { name: line.name, count: 0, revenue: 0 };
        prev.count += 1;
        prev.revenue = roundMoney(prev.revenue + share);
        jobLineTotals.set(line.name, prev);
      }
      continue;
    }

    let allocated = 0;
    lineBases.forEach((line, idx) => {
      const isLast = idx === lineBases.length - 1;
      const share = isLast
        ? roundMoney(billed - allocated)
        : roundMoney((billed * line.base) / linesBaseTotal);
      if (!isLast) allocated = roundMoney(allocated + share);
      const qty = Math.max(1, Number(lines[idx]?.quantity) || 1);
      const prev = jobLineTotals.get(line.name) || { name: line.name, count: 0, revenue: 0 };
      prev.count += qty;
      prev.revenue = roundMoney(prev.revenue + share);
      jobLineTotals.set(line.name, prev);
    });
  }

  const jobLines = Array.from(jobLineTotals.values()).map((row) => ({
    name: row.name,
    count: row.count,
    revenue: roundMoney(row.revenue),
    value: row.count
  }));

  const packageLines = await Invoice.aggregate([
    {
      $match: withBranchOid({
        businessId: businessObjectId,
        saleType: 'PACKAGE',
        $or: [
          { paymentStatus: 'RECEIVED', paymentReceivedAt: { $gte: startUtc, $lt: endUtc } },
          { settlementMode: 'CREDIT', saleConfirmedAt: { $gte: startUtc, $lt: endUtc } }
        ]
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
    prev.revenue = roundMoney(prev.revenue + (Number(row.revenue) || 0));
    prev.value = prev.count;
    merged.set(key, prev);
  }

  return Array.from(merged.values()).sort(
    (a, b) => b.revenue - a.revenue || b.count - a.count || a.name.localeCompare(b.name)
  );
}
