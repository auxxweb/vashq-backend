import mongoose from 'mongoose';
import Service from '../models/Service.model.js';
import Job from '../models/Job.model.js';
import { lineQuantity } from './serviceCatalog.js';
import { assertSufficientStock, deductServiceStockForSale, restoreServiceStock } from './serviceInventory.js';
import { isProductCatalogService } from './jobCart.js';

async function serviceNameMapForLines(businessId, jobServices = []) {
  const serviceIds = (jobServices || [])
    .map((s) => s.serviceId?._id || s.serviceId)
    .filter(Boolean);
  if (!serviceIds.length) return new Map();
  const catalog = await Service.find({ businessId, _id: { $in: serviceIds } })
    .select('name')
    .lean();
  return new Map(catalog.map((s) => [String(s._id), s.name]));
}

/**
 * Build validated job service lines from either:
 * - services: [{ serviceId, price?, customName?, quantity? }]  (supports variable pricing)
 * - serviceIds: [id, ...]                         (legacy fixed catalog prices)
 */
export async function resolveJobServiceLines(businessId, input = {}) {
  const { serviceIds, services: linesInput, checkStock = true } = input;
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
        customName: row.customName != null ? String(row.customName).trim() : '',
        quantity: row.quantity != null && row.quantity !== '' ? Number(row.quantity) : 1
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
      return { serviceId: oid, price: null, customName: '', quantity: 1 };
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
        const catalogDefault = Number(svc.price) || 0;
        price = (svc.skipWorkProcess && catalogDefault > 0) ? catalogDefault : 0;
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
    const quantity = lineQuantity(row.quantity);
    const isProduct = !!svc.isVariable && !!svc.skipWorkProcess;
    if (!isProduct && quantity !== 1) {
      const err = new Error(`Quantity is only supported for product sales ("${svc.name}")`);
      err.status = 400;
      throw err;
    }

    return {
      serviceId: svc._id,
      price,
      quantity,
      ...(customName ? { customName } : {})
    };
  });

  if (checkStock) {
    assertSufficientStock(lines, catalog);
  }

  const totalPrice = Math.round(
    lines.reduce((sum, l) => sum + l.price * lineQuantity(l.quantity), 0) * 100
  ) / 100;
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
      servicePrice: s.price ?? 0,
      quantity: lineQuantity(s.quantity)
    };
  });
}

export async function syncDraftInvoiceFromJob(invoice, job) {
  if (!invoice || !job || invoice.paymentStatus === 'RECEIVED') return false;
  if (invoice.settlementMode === 'CREDIT' && invoice.saleConfirmedAt) return false;

  const businessId = job.businessId || invoice.businessId;
  const nameByServiceId = await serviceNameMapForLines(businessId, job.services || []);
  // Prefer existing invoice labels (custom names) when catalog/customName are missing
  const previousNameById = new Map(
    (invoice.items || [])
      .filter((i) => i?.serviceId && i?.serviceName && i.serviceName !== 'Service')
      .map((i) => [String(i.serviceId?._id || i.serviceId), String(i.serviceName)])
  );
  // Keep variable/open amounts already set on the invoice when job lines still have 0
  const previousPriceById = new Map(
    (invoice.items || [])
      .filter((i) => i?.serviceId && Number(i.servicePrice) > 0)
      .map((i) => [
        String(i.serviceId?._id || i.serviceId),
        Math.round(Number(i.servicePrice) * 100) / 100
      ])
  );

  const items = jobLinesToInvoiceItems(job.services || [], nameByServiceId).map((item) => {
    let next = { ...item };
    if (!(next.serviceName && next.serviceName !== 'Service')) {
      const prevName = previousNameById.get(String(next.serviceId));
      if (prevName) next.serviceName = prevName;
    }
    const jobPrice = Number(next.servicePrice) || 0;
    if (!(jobPrice > 0)) {
      const prevPrice = previousPriceById.get(String(next.serviceId));
      if (prevPrice > 0) next.servicePrice = prevPrice;
    }
    return next;
  });

  // Always derive from merged items so preserved variable amounts are included
  const subtotal = Math.round(
    items.reduce(
      (sum, i) => sum + (Number(i.servicePrice) || 0) * lineQuantity(i.quantity),
      0
    ) * 100
  ) / 100;

  invoice.items = items;
  invoice.subtotal = subtotal;

  const discountPct = Number(invoice.discount) || 0;
  const afterDiscount = subtotal * (1 - discountPct / 100);
  const gst = Number(invoice.gstAmount) || 0;
  const loyaltyAmt = Number(invoice.loyaltyRedeemedAmount) || 0;
  invoice.finalAmount = Math.max(0, Math.round((afterDiscount + gst - loyaltyAmt) * 100) / 100);

  await invoice.save();

  // Keep job line prices aligned (closed wash jobs often still have 0 for variable visits)
  if (job && typeof job.save === 'function' && Array.isArray(job.services)) {
    const priceBySid = new Map(
      items.map((i) => [String(i.serviceId), Math.round((Number(i.servicePrice) || 0) * 100) / 100])
    );
    let changed = false;
    for (let i = 0; i < job.services.length; i += 1) {
      const row = job.services[i];
      const sid = String(row.serviceId?._id || row.serviceId || '');
      if (!priceBySid.has(sid)) continue;
      const invPrice = priceBySid.get(sid);
      const current = Math.round((Number(row.price) || 0) * 100) / 100;
      if (current !== invPrice) {
        job.services[i].price = invPrice;
        changed = true;
      }
    }
    const currentTotal = Math.round((Number(job.totalPrice) || 0) * 100) / 100;
    if (changed || currentTotal !== subtotal) {
      job.totalPrice = subtotal;
      if (typeof job.markModified === 'function') job.markModified('services');
      await job.save();
    }
  }

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
  // Allow price sync for DELIVERED wash jobs that still have an open invoice
  // (variable amounts are often entered after delivery, before payment).

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
        quantity: lineQuantity(i.quantity),
        ...(customName ? { customName } : {})
      };
    });

  job.totalPrice = Math.round((Number(subtotal) || 0) * 100) / 100;
  await job.save();
  return true;
}

/**
 * Variable visit services (not retail products) must have a positive amount on the invoice.
 */
export async function assertVariableVisitAmountsRequired(invoice, businessId) {
  const items = invoice?.items || [];
  if (!items.length) return;

  const serviceIds = items.map((row) => row.serviceId).filter(Boolean);
  if (!serviceIds.length) return;

  const catalog = await Service.find({ _id: { $in: serviceIds }, businessId })
    .select('name isVariable skipWorkProcess')
    .lean();
  const byId = new Map(catalog.map((s) => [s._id.toString(), s]));

  for (const row of items) {
    const sid = String(row.serviceId || '');
    const svc = byId.get(sid);
    const isVariableVisit = !!(svc?.isVariable && !svc?.skipWorkProcess);
    if (!isVariableVisit) continue;

    const price = Math.round((Number(row.servicePrice) || 0) * 100) / 100;
    if (!Number.isFinite(price) || price <= 0) {
      const label = row.serviceName || svc?.name || 'variable service';
      const err = new Error(`Enter an amount for "${label}"`);
      err.status = 400;
      throw err;
    }
  }
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
    ? await Service.find({ _id: { $in: serviceIds }, businessId })
      .select('name isVariable skipWorkProcess')
      .lean()
    : [];
  const catalogById = new Map(catalog.map((s) => [s._id.toString(), s]));

  const updatedItems = existing.map((row, index) => {
    const incoming = itemsInput[index] || {};
    const sid = String(row.serviceId || incoming.serviceId || '');
    const svc = catalogById.get(sid);
    const isVariable = !!svc?.isVariable;
    const isVariableVisit = isVariable && !svc?.skipWorkProcess;
    const base = typeof row.toObject === 'function' ? row.toObject() : { ...row };
    if (!isVariable) return base;

    const raw = incoming.servicePrice;
    if (isVariableVisit && (raw === '' || raw == null)) {
      const label = base.serviceName || svc?.name || 'variable service';
      const err = new Error(`Enter an amount for "${label}"`);
      err.status = 400;
      throw err;
    }
    const price = Math.round((Number(raw) || 0) * 100) / 100;
    if (!Number.isFinite(price) || price < 0) {
      const err = new Error('Line item prices must be 0 or more');
      err.status = 400;
      throw err;
    }
    if (isVariableVisit && price <= 0) {
      const label = base.serviceName || svc?.name || 'variable service';
      const err = new Error(`Enter an amount for "${label}"`);
      err.status = 400;
      throw err;
    }
    return { ...base, servicePrice: price };
  });

  invoice.items = updatedItems;
  invoice.subtotal = Math.round(
    updatedItems.reduce(
      (sum, i) => sum + (Number(i.servicePrice) || 0) * lineQuantity(i.quantity),
      0
    ) * 100
  ) / 100;
  recalculateInvoiceFinalAmount(invoice);

  if (invoice.jobId) {
    await syncJobFromInvoiceItems(invoice.jobId, businessId, updatedItems, invoice.subtotal);
  }
  return true;
}

/**
 * Append product catalog lines to an open wash-job or product-sale invoice.
 */
export async function addProductLinesToOpenInvoice(invoice, businessId, productLinesInput = []) {
  if (!invoice?.jobId) {
    const err = new Error('Invoice is not linked to a job');
    err.status = 400;
    throw err;
  }
  if (invoice.paymentStatus === 'RECEIVED') {
    const err = new Error('Cannot add products to a paid invoice');
    err.status = 403;
    throw err;
  }
  if (invoice.settlementMode === 'CREDIT' && invoice.saleConfirmedAt) {
    const err = new Error('Cannot add products to a closed credit invoice');
    err.status = 403;
    throw err;
  }
  if (!Array.isArray(productLinesInput) || productLinesInput.length === 0) {
    const err = new Error('Select at least one product');
    err.status = 400;
    throw err;
  }

  const job = await Job.findOne({ _id: invoice.jobId, businessId });
  if (!job) {
    const err = new Error('Job not found');
    err.status = 404;
    throw err;
  }
  if (job.status === 'CANCELLED') {
    const err = new Error('Products cannot be added to a cancelled job');
    err.status = 400;
    throw err;
  }

  const { lines: newLines, catalogServices } = await resolveJobServiceLines(businessId, {
    services: productLinesInput,
    checkStock: true
  });

  const nonProducts = catalogServices.filter((s) => !(s.isVariable && s.skipWorkProcess));
  if (nonProducts.length) {
    const err = new Error('Only product catalog items can be added here');
    err.status = 400;
    throw err;
  }

  const existing = Array.isArray(job.services) ? [...job.services] : [];
  // Merge quantity into an existing product line when same serviceId
  for (const line of newLines) {
    const sid = String(line.serviceId);
    const idx = existing.findIndex((row) => String(row.serviceId?._id || row.serviceId) === sid);
    if (idx >= 0) {
      const prevQty = lineQuantity(existing[idx].quantity);
      const addQty = lineQuantity(line.quantity);
      const prev = typeof existing[idx].toObject === 'function' ? existing[idx].toObject() : { ...existing[idx] };
      existing[idx] = {
        ...prev,
        serviceId: line.serviceId,
        // Keep the unit price already on the job; only increase quantity
        price: Number(prev.price) || line.price,
        quantity: prevQty + addQty
      };
    } else {
      existing.push(line);
    }
  }

  const totalPrice = Math.round(
    existing.reduce((sum, l) => sum + (Number(l.price) || 0) * lineQuantity(l.quantity), 0) * 100
  ) / 100;

  const advanceOnJob = Math.max(0, Number(job.advancePayment) || 0);
  if (advanceOnJob > totalPrice + 1e-6) {
    const err = new Error('Job advance exceeds the new total. Adjust advance before changing services.');
    err.status = 400;
    throw err;
  }

  // Stock: product sales (and wash jobs already delivered) deducted earlier —
  // only assert/deduct the newly added lines. Open wash jobs assert full cart; deduct on delivery.
  const alreadyDeducted = !!job.directBill || !!job.productStockDeductedAt || job.status === 'DELIVERED';
  const allIds = existing.map((l) => l.serviceId).filter(Boolean);
  const catalog = await Service.find({ _id: { $in: allIds }, businessId }).lean();
  if (alreadyDeducted) {
    assertSufficientStock(newLines, catalogServices);
  } else {
    assertSufficientStock(existing, catalog);
  }

  job.services = existing;
  job.totalPrice = totalPrice;
  await job.save();

  if (alreadyDeducted) {
    await deductServiceStockForSale(businessId, newLines, catalogServices);
  }

  await syncDraftInvoiceFromJob(invoice, job);
  return { job, invoice };
}

/**
 * Remove a retail product line from an open wash-job or product-sale invoice.
 */
export async function removeProductLineFromOpenInvoice(invoice, businessId, { serviceId } = {}) {
  if (!invoice?.jobId) {
    const err = new Error('Invoice is not linked to a job');
    err.status = 400;
    throw err;
  }
  if (invoice.paymentStatus === 'RECEIVED') {
    const err = new Error('Cannot remove products from a paid invoice');
    err.status = 403;
    throw err;
  }
  if (invoice.settlementMode === 'CREDIT' && invoice.saleConfirmedAt) {
    const err = new Error('Cannot remove products from a closed credit invoice');
    err.status = 403;
    throw err;
  }
  if (!serviceId) {
    const err = new Error('Product is required');
    err.status = 400;
    throw err;
  }

  const job = await Job.findOne({ _id: invoice.jobId, businessId });
  if (!job) {
    const err = new Error('Job not found');
    err.status = 404;
    throw err;
  }
  if (job.status === 'CANCELLED') {
    const err = new Error('Products cannot be removed from a cancelled job');
    err.status = 400;
    throw err;
  }

  const targetId = String(serviceId);
  const existing = Array.isArray(job.services) ? [...job.services] : [];
  const idx = existing.findIndex((row) => String(row.serviceId?._id || row.serviceId) === targetId);
  if (idx < 0) {
    const err = new Error('Product line not found on this invoice');
    err.status = 404;
    throw err;
  }

  const allIds = existing.map((l) => l.serviceId).filter(Boolean);
  const catalog = allIds.length
    ? await Service.find({ _id: { $in: allIds }, businessId }).lean()
    : [];
  const catalogById = new Map(catalog.map((s) => [String(s._id), s]));
  const removedRow = typeof existing[idx].toObject === 'function'
    ? existing[idx].toObject()
    : { ...existing[idx] };
  const removedSvc = catalogById.get(targetId);
  if (!isProductCatalogService(removedSvc)) {
    const err = new Error('Only product lines can be removed here');
    err.status = 400;
    throw err;
  }
  if (existing.length <= 1) {
    const err = new Error('Cannot remove the last item from the invoice');
    err.status = 400;
    throw err;
  }

  const removedQty = lineQuantity(removedRow.quantity);
  existing.splice(idx, 1);

  const totalPrice = Math.round(
    existing.reduce((sum, l) => sum + (Number(l.price) || 0) * lineQuantity(l.quantity), 0) * 100
  ) / 100;

  const advanceOnJob = Math.max(0, Number(job.advancePayment) || 0);
  if (advanceOnJob > totalPrice + 1e-6) {
    const err = new Error('Job advance exceeds the new total. Adjust advance before changing services.');
    err.status = 400;
    throw err;
  }

  const alreadyDeducted = !!job.directBill || !!job.productStockDeductedAt || job.status === 'DELIVERED';
  job.services = existing;
  job.totalPrice = totalPrice;
  await job.save();

  if (alreadyDeducted && removedQty > 0) {
    await restoreServiceStock(businessId, [{ serviceId: removedSvc._id, quantity: removedQty }]);
  }

  await syncDraftInvoiceFromJob(invoice, job);
  return { job, invoice };
}
