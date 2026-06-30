import { PRODUCT_SALE_FILTER, WASH_JOB_FILTER } from './directBillJob.js';

const VALID_SOURCES = new Set(['all', 'wash', 'jobs', 'products', 'product', 'variable', 'packages']);

/** Normalize sales report source query param. */
export function normalizeSalesReportSource(source) {
  const s = String(source || 'all').toLowerCase();
  if (!VALID_SOURCES.has(s)) return 'all';
  if (s === 'jobs') return 'wash';
  if (s === 'product') return 'products';
  return s;
}

export function shouldIncludeJobSales(source) {
  return normalizeSalesReportSource(source) !== 'packages';
}

export function shouldIncludePackageSales(source, hasServiceFilter) {
  const normalized = normalizeSalesReportSource(source);
  if (normalized === 'packages') return true;
  return normalized === 'all' && !hasServiceFilter;
}

/**
 * Build Job.find filter for delivered jobs in sales report.
 * Returns null when variable source has no variable services (empty result).
 */
export async function buildDeliveredJobSalesFilter(businessId, {
  source,
  deliveryRange,
  serviceObjectIds = [],
  ServiceModel
}) {
  const normalized = normalizeSalesReportSource(source);
  const filter = {
    businessId,
    status: 'DELIVERED',
    $or: [
      { actualDelivery: deliveryRange },
      { updatedAt: deliveryRange, actualDelivery: { $exists: false } }
    ]
  };

  if (normalized === 'products') {
    Object.assign(filter, PRODUCT_SALE_FILTER);
  } else if (normalized === 'wash' || normalized === 'variable') {
    Object.assign(filter, WASH_JOB_FILTER);
  }

  const serviceClauses = [];
  if (serviceObjectIds.length) {
    serviceClauses.push({
      services: { $elemMatch: { serviceId: { $in: serviceObjectIds } } }
    });
  }

  if (normalized === 'variable') {
    const variableServiceIds = await ServiceModel.find({ businessId, isVariable: true }).distinct('_id');
    if (!variableServiceIds.length) return null;
    serviceClauses.push({
      services: { $elemMatch: { serviceId: { $in: variableServiceIds } } }
    });
  }

  if (serviceClauses.length === 1) {
    Object.assign(filter, serviceClauses[0]);
  } else if (serviceClauses.length > 1) {
    filter.$and = [...(filter.$and || []), ...serviceClauses];
  }

  return filter;
}

export function classifyJobInvoiceSale(inv) {
  const job = inv.jobId;
  if (job?.directBill) return 'product';
  const hasVariable = (job?.services || []).some((s) => s.serviceId?.isVariable);
  if (hasVariable) return 'variable';
  return 'wash';
}

export function mapJobInvoiceForSalesReport(inv) {
  const saleSubType = classifyJobInvoiceSale(inv);
  return { ...inv, saleType: 'job', saleSubType };
}
