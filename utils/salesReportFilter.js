import mongoose from 'mongoose';
import { PRODUCT_SALE_FILTER, WASH_JOB_FILTER } from './directBillJob.js';

const VALID_SOURCES = new Set(['all', 'wash', 'jobs', 'products', 'product', 'variable', 'packages', 'other-revenue', 'other-revenues']);

/** Parse categoryId / categoryIds query into unique valid ObjectId strings. */
export function parseCategoryIdsFromQuery(query = {}) {
  const raw = query.categoryIds ?? query.categoryId;
  if (raw == null || raw === '' || raw === 'ALL') return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(',');
  return [
    ...new Set(
      parts
        .map((s) => String(s).trim())
        .filter(Boolean)
        .filter((id) => mongoose.isValidObjectId(id))
    )
  ];
}

/**
 * Resolve explicit serviceIds + optional categoryIds into job line-item service ObjectIds.
 * When categories are selected (and feature enabled), empty resolution means no matching sales.
 */
export async function resolveSalesReportServiceFilter(businessId, {
  serviceObjectIds = [],
  categoryIdStrings = [],
  serviceCategoriesEnabled = false,
  ServiceModel
}) {
  const explicitIds = Array.isArray(serviceObjectIds) ? serviceObjectIds : [];
  const useCategory = !!serviceCategoriesEnabled && categoryIdStrings.length > 0;

  if (!useCategory) {
    return {
      serviceObjectIds: explicitIds,
      hasServiceFilter: explicitIds.length > 0,
      forceEmpty: false
    };
  }

  const categoryOids = categoryIdStrings.map((id) => new mongoose.Types.ObjectId(id));
  const fromCategory = await ServiceModel.find({
    businessId,
    categoryId: { $in: categoryOids }
  }).distinct('_id');

  let resolved;
  if (explicitIds.length) {
    const allowed = new Set(fromCategory.map((id) => String(id)));
    resolved = explicitIds.filter((id) => allowed.has(String(id)));
  } else {
    resolved = fromCategory;
  }

  return {
    serviceObjectIds: resolved,
    hasServiceFilter: true,
    forceEmpty: resolved.length === 0
  };
}

/** Normalize sales report source query param. */
export function normalizeSalesReportSource(source) {
  const s = String(source || 'all').toLowerCase();
  if (!VALID_SOURCES.has(s)) return 'all';
  if (s === 'jobs') return 'wash';
  if (s === 'product') return 'products';
  if (s === 'other-revenues') return 'other-revenue';
  return s;
}

export function shouldIncludeJobSales(source) {
  const normalized = normalizeSalesReportSource(source);
  return normalized !== 'packages' && normalized !== 'other-revenue';
}

export function shouldIncludePackageSales(source, hasServiceFilter) {
  const normalized = normalizeSalesReportSource(source);
  if (normalized === 'packages') return true;
  if (normalized === 'other-revenue') return false;
  return normalized === 'all' && !hasServiceFilter;
}

export function shouldIncludeOtherRevenueSales(source, hasServiceFilter) {
  const normalized = normalizeSalesReportSource(source);
  if (normalized === 'other-revenue') return true;
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
