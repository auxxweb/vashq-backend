import mongoose from 'mongoose';
import Estimate from '../models/Estimate.model.js';
import Service from '../models/Service.model.js';
import Lead from '../models/Lead.model.js';
import LeadStatus from '../models/LeadStatus.model.js';
import { getInvoiceCompanySnapshot } from './invoiceCompany.js';
import { normalizePhone, applyDefaultCountryCode } from './customer.utils.js';
import { isSalesEmployee } from './employeeType.js';
import { changeLeadStatus, pushLeadActivity } from './crmService.js';
import { ensureCustomerAndCarFromLead } from './crmService.js';

export function applySalesEstimateScope(user, filter = {}) {
  if (!isSalesEmployee(user)) return filter;
  const uid = user._id;
  return {
    ...filter,
    $or: [{ createdBy: uid }, { assignedTo: uid }]
  };
}

export function assertSalesCanAccessEstimate(user, estimate) {
  if (!isSalesEmployee(user)) return;
  const uid = String(user._id);
  const ok =
    String(estimate.createdBy?._id || estimate.createdBy) === uid ||
    String(estimate.assignedTo?._id || estimate.assignedTo || '') === uid;
  if (!ok) {
    const err = new Error('You do not have access to this estimate');
    err.status = 403;
    throw err;
  }
}

export function computeEstimateTotals({
  items = [],
  discountType = 'PERCENT',
  discount = 0,
  taxPercentage = 0
}) {
  const normalizedItems = (items || []).map((raw) => {
    const qty = Math.max(0.01, Number(raw.quantity) || 1);
    const unitPrice = Math.max(0, Number(raw.unitPrice) || 0);
    const amount = Math.round(qty * unitPrice * 100) / 100;
    let itemType = String(raw.itemType || 'SERVICE').toUpperCase();
    if (!['SERVICE', 'PRODUCT', 'CUSTOM'].includes(itemType)) itemType = 'SERVICE';
    return {
      serviceId: raw.serviceId || null,
      name: String(raw.name || '').trim(),
      itemType,
      unitPrice,
      quantity: qty,
      amount,
      notes: String(raw.notes || '').trim()
    };
  }).filter((i) => i.name);

  const subtotal = Math.round(normalizedItems.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  const dtype = String(discountType || 'PERCENT').toUpperCase() === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
  let discountAmount = 0;
  if (dtype === 'AMOUNT') {
    discountAmount = Math.min(subtotal, Math.max(0, Number(discount) || 0));
  } else {
    const pct = Math.min(100, Math.max(0, Number(discount) || 0));
    discountAmount = Math.round((subtotal * (pct / 100)) * 100) / 100;
  }
  const taxPct = Math.min(100, Math.max(0, Number(taxPercentage) || 0));
  const taxable = Math.max(0, subtotal - discountAmount);
  const taxAmount = Math.round((taxable * (taxPct / 100)) * 100) / 100;
  const finalAmount = Math.round((taxable + taxAmount) * 100) / 100;

  return {
    items: normalizedItems,
    subtotal,
    discountType: dtype,
    discount: dtype === 'PERCENT' ? Math.min(100, Math.max(0, Number(discount) || 0)) : discountAmount,
    discountAmount,
    taxPercentage: taxPct,
    taxAmount,
    finalAmount
  };
}

export async function nextEstimateNumber(businessId) {
  const year = new Date().getFullYear();
  const prefix = `EST-${year}-`;
  const latest = await Estimate.findOne({
    businessId,
    estimateNumber: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  })
    .sort({ estimateNumber: -1 })
    .select('estimateNumber')
    .lean();

  let seq = 1;
  if (latest?.estimateNumber) {
    const part = String(latest.estimateNumber).slice(prefix.length);
    const n = parseInt(part, 10);
    if (Number.isFinite(n) && n >= 1) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

export async function applyCompanySnapshot(estimate, businessId) {
  const snap = await getInvoiceCompanySnapshot(businessId);
  if (!snap) return estimate;
  estimate.companyName = snap.businessName || '';
  estimate.companyOwnerName = snap.ownerName || '';
  estimate.companyAddress = [snap.address, snap.location].filter(Boolean).join(', ');
  estimate.companyPhone = snap.phone || snap.whatsappNumber || '';
  estimate.companyEmail = snap.email || '';
  estimate.companyGst = snap.gstNumber || '';
  estimate.companyLogo = snap.logo || '';
  return estimate;
}

export async function resolveCatalogItemMeta(businessId, serviceId) {
  if (!serviceId || !mongoose.Types.ObjectId.isValid(String(serviceId))) return null;
  const svc = await Service.findOne({ _id: serviceId, businessId, isActive: { $ne: false } }).lean();
  if (!svc) return null;
  const isProduct = !!(svc.isVariable && svc.skipWorkProcess);
  return {
    serviceId: svc._id,
    name: svc.name,
    unitPrice: Number(svc.price) || 0,
    itemType: isProduct ? 'PRODUCT' : 'SERVICE'
  };
}

export async function markLeadEstimateShared(lead, { businessId, userId, estimateNumber }) {
  if (!lead) return;
  const note = estimateNumber ? `Estimate ${estimateNumber} shared` : 'Estimate shared with client';
  const status = await LeadStatus.findOne({
    businessId,
    isActive: true,
    name: /^estimate shared$/i
  }).lean();

  const alreadyConverted = !!(lead.convertedJobId || lead.convertedBookingId);
  if (status && !alreadyConverted && String(lead.statusId) !== String(status._id)) {
    try {
      await changeLeadStatus({
        lead,
        businessId,
        userId,
        statusId: status._id,
        note
      });
      return;
    } catch {
      // Fall through to activity-only if transition not allowed
    }
  }

  pushLeadActivity(lead, {
    type: 'ESTIMATE_SHARED',
    note,
    createdBy: userId
  });
  await lead.save();
}

export async function ensureCustomerFromEstimate(estimate, businessId, branchId, overrides = {}) {
  const fakeLead = {
    name: overrides.name || estimate.customerName,
    phone: overrides.phone || estimate.customerPhone,
    location: overrides.location || estimate.customerLocation,
    vehicleNumber: overrides.vehicleNumber || estimate.vehicleNumber,
    vehicleBrand: overrides.vehicleBrand || estimate.vehicleBrand,
    vehicleModel: overrides.vehicleModel || estimate.vehicleModel,
    vehicleType: overrides.vehicleType || estimate.vehicleType,
    vehicleColor: overrides.vehicleColor || estimate.vehicleColor,
    convertedCustomerId: estimate.customerId || null,
    convertedCarId: null
  };
  const result = await ensureCustomerAndCarFromLead(fakeLead, businessId, branchId, overrides);
  if (result?.customer?._id) {
    estimate.customerId = result.customer._id;
  }
  return result;
}

export function estimateToJobServicePayload(estimate) {
  const lines = (estimate.items || [])
    .filter((i) => i.serviceId || i.itemType !== 'CUSTOM')
    .map((i) => {
      if (i.serviceId) {
        return {
          serviceId: i.serviceId,
          quantity: i.quantity || 1,
          unitPrice: i.unitPrice
        };
      }
      return null;
    })
    .filter(Boolean);

  const serviceIds = lines.map((l) => l.serviceId);
  const services = lines.map((l) => ({
    serviceId: l.serviceId,
    quantity: l.quantity,
    price: l.unitPrice
  }));
  return { serviceIds, services };
}

export function normalizeEstimateCustomerPhone(phone) {
  return applyDefaultCountryCode(normalizePhone(phone || ''));
}

export async function findLeadForEstimate(estimate, businessId) {
  if (!estimate.leadId) return null;
  return Lead.findOne({ _id: estimate.leadId, businessId });
}
