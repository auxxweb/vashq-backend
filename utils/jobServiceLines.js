import mongoose from 'mongoose';
import Service from '../models/Service.model.js';
import Job from '../models/Job.model.js';

/**
 * Build validated job service lines from either:
 * - services: [{ serviceId, price?, customName? }]  (supports variable pricing)
 * - serviceIds: [id, ...]                         (legacy fixed catalog prices)
 */
export async function resolveJobServiceLines(businessId, input = {}) {
  const { serviceIds, services: linesInput } = input;
  const businessIdObj = typeof businessId === 'string'
    ? new mongoose.Types.ObjectId(businessId)
    : businessId;

  let requestedLines = [];

  if (Array.isArray(linesInput) && linesInput.length > 0) {
    requestedLines = linesInput.map((row, index) => {
      const id = row?.serviceId;
      if (!id) {
        const err = new Error(`Service line ${index + 1}: serviceId is required`);
        err.status = 400;
        throw err;
      }
      let oid;
      try {
        oid = new mongoose.Types.ObjectId(id);
      } catch {
        const err = new Error(`Service line ${index + 1}: invalid service ID`);
        err.status = 400;
        throw err;
      }
      return {
        serviceId: oid,
        price: row.price != null && row.price !== '' ? Number(row.price) : null,
        customName: row.customName != null ? String(row.customName).trim() : ''
      };
    });
  } else if (Array.isArray(serviceIds) && serviceIds.length > 0) {
    requestedLines = serviceIds.map((id) => {
      let oid;
      try {
        oid = new mongoose.Types.ObjectId(id);
      } catch {
        const err = new Error('Invalid service ID format');
        err.status = 400;
        throw err;
      }
      return { serviceId: oid, price: null, customName: '' };
    });
  } else {
    const err = new Error('At least one service is required');
    err.status = 400;
    throw err;
  }

  const uniqueIds = [...new Set(requestedLines.map((l) => l.serviceId.toString()))]
    .map((id) => new mongoose.Types.ObjectId(id));

  const catalog = await Service.find({
    _id: { $in: uniqueIds },
    businessId: businessIdObj,
    isActive: { $ne: false }
  }).lean();

  if (catalog.length !== uniqueIds.length) {
    const found = new Set(catalog.map((s) => s._id.toString()));
    const missing = uniqueIds.filter((id) => !found.has(id.toString())).map(String);
    const err = new Error('One or more services not found. Ensure services exist, are active, and belong to your business.');
    err.status = 400;
    err.missingServiceIds = missing;
    throw err;
  }

  const catalogMap = new Map(catalog.map((s) => [s._id.toString(), s]));

  const lines = requestedLines.map((row, index) => {
    const svc = catalogMap.get(row.serviceId.toString());
    if (!svc) {
      const err = new Error(`Service line ${index + 1}: service not found`);
      err.status = 400;
      throw err;
    }

    let price;
    if (svc.isVariable) {
      if (row.price == null || row.price === '') {
        price = 0;
      } else if (!Number.isFinite(row.price) || row.price < 0) {
        const err = new Error(`"${svc.name}" has an invalid price — enter 0 or more, or leave blank to set when editing the open invoice`);
        err.status = 400;
        throw err;
      } else {
        price = Math.round(Number(row.price) * 100) / 100;
      }
    } else {
      price = Number(svc.price) || 0;
      if (price < 0) {
        const err = new Error(`Service "${svc.name}" has invalid catalog price`);
        err.status = 400;
        throw err;
      }
    }

    const customName = row.customName?.trim() || '';
    return {
      serviceId: svc._id,
      price,
      ...(customName ? { customName } : {})
    };
  });

  const totalPrice = Math.round(lines.reduce((sum, l) => sum + l.price, 0) * 100) / 100;
  const catalogOrdered = requestedLines.map((l) => catalogMap.get(l.serviceId.toString())).filter(Boolean);

  return { lines, totalPrice, catalogServices: catalogOrdered };
}

export function jobLinesToInvoiceItems(jobServices = [], nameByServiceId = null) {
  return (jobServices || []).map((s) => {
    const sid = s.serviceId?._id || s.serviceId;
    const catalogName = (nameByServiceId instanceof Map
      ? nameByServiceId.get(String(sid))
      : nameByServiceId?.[String(sid)]) || s.serviceId?.name || '';
    return {
      serviceId: sid,
      serviceName: s.customName || catalogName || 'Service',
      servicePrice: s.price ?? 0
    };
  });
}

export async function syncDraftInvoiceFromJob(invoice, job) {
  if (!invoice || !job || invoice.paymentStatus === 'RECEIVED') return false;
  if (invoice.settlementMode === 'CREDIT' && invoice.saleConfirmedAt) return false;

  const items = jobLinesToInvoiceItems(job.services || []);
  const subtotal = job.totalPrice ?? items.reduce((sum, i) => sum + (Number(i.servicePrice) || 0), 0);

  invoice.items = items;
  invoice.subtotal = subtotal;

  const discountPct = Number(invoice.discount) || 0;
  const afterDiscount = subtotal * (1 - discountPct / 100);
  const gst = Number(invoice.gstAmount) || 0;
  const loyaltyAmt = Number(invoice.loyaltyRedeemedAmount) || 0;
  invoice.finalAmount = Math.max(0, Math.round((afterDiscount + gst - loyaltyAmt) * 100) / 100);

  await invoice.save();
  return true;
}

export function recalculateInvoiceFinalAmount(invoice) {
  const subtotal = Number(invoice.subtotal) || 0;
  const discountPct = Number(invoice.discount) || 0;
  const afterDiscount = subtotal * (1 - discountPct / 100);
  const gst = Number(invoice.gstAmount) || 0;
  const loyaltyAmt = Number(invoice.loyaltyRedeemedAmount) || 0;
  invoice.finalAmount = Math.max(0, Math.round((afterDiscount + gst - loyaltyAmt) * 100) / 100);
  return invoice.finalAmount;
}

export async function syncJobFromInvoiceItems(jobId, businessId, items, subtotal) {
  if (!jobId) return false;
  const job = await Job.findOne({ _id: jobId, businessId });
  if (!job || job.status === 'CANCELLED') return false;
  const editableDirectSale = job.directBill === true && job.status === 'DELIVERED';
  const editableOpenJob = job.status !== 'DELIVERED';
  if (!editableOpenJob && !editableDirectSale) return false;

  const catalogIds = (items || []).map((i) => i.serviceId).filter(Boolean);
  const catalog = catalogIds.length
    ? await Service.find({ _id: { $in: catalogIds }, businessId }).select('name').lean()
    : [];
  const nameById = new Map(catalog.map((s) => [s._id.toString(), s.name]));

  job.services = (items || [])
    .filter((i) => i.serviceId)
    .map((i) => {
      const sid = i.serviceId?._id || i.serviceId;
      const catalogName = nameById.get(String(sid)) || '';
      const customName = i.serviceName && i.serviceName !== catalogName ? String(i.serviceName).trim() : '';
      return {
        serviceId: sid,
        price: Math.round((Number(i.servicePrice) || 0) * 100) / 100,
        ...(customName ? { customName } : {})
      };
    });

  job.totalPrice = Math.round((Number(subtotal) || 0) * 100) / 100;
  await job.save();
  return true;
}

/**
 * Update variable-service line prices on an open invoice (same line count; no add/remove).
 */
export async function applyInvoiceItemPriceUpdates(invoice, itemsInput, businessId) {
  if (itemsInput === undefined) return false;
  if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
    const err = new Error('At least one line item is required');
    err.status = 400;
    throw err;
  }
  const existing = invoice.items || [];
  if (itemsInput.length !== existing.length) {
    const err = new Error('Line items cannot be added or removed on the invoice');
    err.status = 403;
    throw err;
  }

  const serviceIds = existing.map((row) => row.serviceId).filter(Boolean);
  const catalog = serviceIds.length
    ? await Service.find({ _id: { $in: serviceIds }, businessId }).select('isVariable').lean()
    : [];
  const variableById = new Map(catalog.map((s) => [s._id.toString(), !!s.isVariable]));

  const updatedItems = existing.map((row, index) => {
    const incoming = itemsInput[index] || {};
    const sid = String(row.serviceId || incoming.serviceId || '');
    const isVariable = variableById.get(sid);
    const base = typeof row.toObject === 'function' ? row.toObject() : { ...row };
    if (!isVariable) return base;

    const raw = incoming.servicePrice;
    const price = Math.round((Number(raw) || 0) * 100) / 100;
    if (!Number.isFinite(price) || price < 0) {
      const err = new Error('Line item prices must be 0 or more');
      err.status = 400;
      throw err;
    }
    return { ...base, servicePrice: price };
  });

  invoice.items = updatedItems;
  invoice.subtotal = Math.round(
    updatedItems.reduce((sum, i) => sum + (Number(i.servicePrice) || 0), 0) * 100
  ) / 100;
  recalculateInvoiceFinalAmount(invoice);

  if (invoice.jobId) {
    await syncJobFromInvoiceItems(invoice.jobId, businessId, updatedItems, invoice.subtotal);
  }
  return true;
}
