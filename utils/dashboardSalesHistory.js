import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function saleDateForJobInvoice(inv) {
  const job = inv.jobId || {};
  return job.actualDelivery || job.createdAt || inv.paymentReceivedAt || inv.createdAt;
}

function saleDateForPackageInvoice(inv) {
  return inv.paymentReceivedAt || inv.saleConfirmedAt || inv.createdAt;
}

/** Recent sales in dashboard period (jobs, product sales, packages) — newest first. */
export async function getDashboardSalesHistory(businessId, startUtc, endUtc, limit = 4) {
  const deliveryRange = { $gte: startUtc, $lt: endUtc };

  const deliveredJobIds = await Job.find({
    businessId,
    status: 'DELIVERED',
    $or: [
      { actualDelivery: deliveryRange },
      { actualDelivery: { $exists: false }, updatedAt: deliveryRange }
    ]
  }).distinct('_id');

  const [jobInvoices, packageInvoices] = await Promise.all([
    deliveredJobIds.length
      ? Invoice.find({ businessId, jobId: { $in: deliveredJobIds } })
        .populate({
          path: 'jobId',
          select: 'tokenNumber directBill actualDelivery createdAt',
          populate: { path: 'customerId', select: 'name' }
        })
        .lean()
      : [],
    Invoice.find({
      businessId,
      saleType: 'PACKAGE',
      $or: [
        { paymentStatus: 'RECEIVED', paymentReceivedAt: deliveryRange },
        { settlementMode: 'CREDIT', saleConfirmedAt: deliveryRange }
      ]
    }).lean()
  ]);

  const rows = [];

  for (const inv of jobInvoices) {
    const job = inv.jobId || {};
    const isProduct = !!job.directBill;
    rows.push({
      id: String(inv._id),
      saleType: isProduct ? 'product' : 'job',
      typeLabel: isProduct ? 'Product' : 'Job',
      ref: job.tokenNumber || inv.invoiceNumber || '—',
      customerName: inv.customerName || job.customerId?.name || '—',
      amount: roundMoney(inv.finalAmount),
      saleDate: saleDateForJobInvoice(inv)
    });
  }

  for (const inv of packageInvoices) {
    rows.push({
      id: String(inv._id),
      saleType: 'package',
      typeLabel: 'Package',
      ref: inv.invoiceNumber || '—',
      customerName: inv.customerName || '—',
      amount: roundMoney(inv.finalAmount),
      saleDate: saleDateForPackageInvoice(inv),
      detail: inv.packageName || null
    });
  }

  rows.sort((a, b) => new Date(b.saleDate || 0).getTime() - new Date(a.saleDate || 0).getTime());

  return rows.slice(0, limit).map((row) => ({
    ...row,
    saleDate: row.saleDate ? new Date(row.saleDate).toISOString() : null
  }));
}
