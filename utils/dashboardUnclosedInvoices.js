import mongoose from 'mongoose';
import Invoice from '../models/Invoice.model.js';
import { invoiceStatusFilterClause } from './invoiceListFilter.js';

/**
 * Unclosed invoices in dashboard period — same definition as Invoices list "Pending":
 * payment not received and not yet closed on credit (no amount-due / outstanding balance).
 */
export async function getDashboardUnclosedInvoices(businessId, startUtc, endUtc, limit = 10, branchId = null) {
  const businessObjectId = new mongoose.Types.ObjectId(String(businessId));
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const pendingClause = invoiceStatusFilterClause('pending');
  const query = {
    businessId: businessObjectId,
    createdAt: { $gte: startUtc, $lt: endUtc },
    ...pendingClause
  };
  if (branchId) query.branchId = new mongoose.Types.ObjectId(String(branchId));

  const rows = await Invoice.find(query)
    .populate('jobId', 'tokenNumber status directBill')
    .populate('packageId', 'name')
    .sort({ createdAt: -1 })
    .limit(cap)
    .lean();

  return rows
    .slice(0, cap)
    .map((inv) => ({
      _id: inv._id,
      invoiceNumber: inv.invoiceNumber,
      customerName: inv.customerName || '—',
      customerPhone: inv.customerPhone || '',
      vehicleNumber: inv.vehicleNumber || '',
      finalAmount: Number(inv.finalAmount) || 0,
      outstandingAmount: Number(inv.outstandingAmount) || 0,
      paymentStatus: inv.paymentStatus,
      settlementMode: inv.settlementMode,
      saleType: inv.saleType || 'JOB',
      packageName: inv.packageName || inv.packageId?.name || null,
      jobToken: inv.jobId?.tokenNumber || null,
      isProductSale: !!inv.jobId?.directBill,
      statusLabel: 'Pending',
      createdAt: inv.createdAt
    }));
}
