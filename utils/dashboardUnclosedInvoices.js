import mongoose from 'mongoose';
import Invoice from '../models/Invoice.model.js';

function isUnclosedInvoice(doc) {
  const outstanding = Number(doc.outstandingAmount) || 0;
  if (outstanding > 0.02) return true;
  return doc.paymentStatus !== 'RECEIVED';
}

function statusLabelFor(invoice) {
  if (invoice.paymentStatus === 'RECEIVED' && (Number(invoice.outstandingAmount) || 0) <= 0.02) {
    return 'Paid';
  }
  const outstanding = Number(invoice.outstandingAmount) || 0;
  if (outstanding > 0.02) {
    const collected =
      (Number(invoice.amountCollectedAtCheckout) || 0) + (Number(invoice.amountCollectedLater) || 0);
    if (collected > 0.02) return 'Partially paid';
    return 'Amount due';
  }
  if (invoice.paymentStatus === 'PENDING') {
    if (invoice.settlementMode === 'CREDIT' && !invoice.saleConfirmedAt) return 'Awaiting checkout';
    return 'Payment pending';
  }
  return 'Open';
}

/**
 * Unclosed invoices in dashboard period (created in range, payment not fully received).
 */
export async function getDashboardUnclosedInvoices(businessId, startUtc, endUtc, limit = 10, branchId = null) {
  const businessObjectId = new mongoose.Types.ObjectId(String(businessId));
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const query = {
    businessId: businessObjectId,
    createdAt: { $gte: startUtc, $lt: endUtc },
    $or: [
      { paymentStatus: 'PENDING' },
      { outstandingAmount: { $gt: 0.02 } }
    ]
  };
  if (branchId) query.branchId = new mongoose.Types.ObjectId(String(branchId));

  const rows = await Invoice.find(query)
    .populate('jobId', 'tokenNumber status directBill')
    .populate('packageId', 'name')
    .sort({ createdAt: -1 })
    .limit(cap * 2)
    .lean();

  return rows
    .filter(isUnclosedInvoice)
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
      statusLabel: statusLabelFor(inv),
      createdAt: inv.createdAt
    }));
}
