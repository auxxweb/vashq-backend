import express from 'express';
import mongoose from 'mongoose';
import Estimate from '../models/Estimate.model.js';
import Lead from '../models/Lead.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import { scopedFilter, assertBranchAccess, branchIdForCreate } from '../utils/branchAccess.js';
import { parseBusinessDateRange, applyCreatedAtRange } from '../utils/businessDateRange.js';
import { isAdminPanelRole } from '../utils/adminRoles.js';
import {
  applySalesEstimateScope,
  assertSalesCanAccessEstimate,
  applyCompanySnapshot,
  computeEstimateTotals,
  nextEstimateNumber,
  normalizeEstimateCustomerPhone,
  markLeadEstimateShared,
  ensureCustomerFromEstimate,
  estimateToJobServicePayload,
  resolveCatalogItemMeta
} from '../utils/estimateService.js';
import { pushLeadActivity, markLeadConverted } from '../utils/crmService.js';
import { createAdminBooking } from '../services/bookingService.js';
import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';

const router = express.Router();

function populateEstimate(q) {
  return q
    .populate('leadId', 'name phone statusId assignedTo')
    .populate('assignedTo', 'name employeeCode')
    .populate('createdBy', 'name employeeCode')
    .populate('customerId', 'name phone');
}

async function findEstimate(req, id) {
  const filter = applySalesEstimateScope(req.user, scopedFilter(req, { _id: id }));
  const estimate = await populateEstimate(Estimate.findOne(filter));
  return estimate;
}

function parseItemsInput(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map((row) => ({
    serviceId: row.serviceId || null,
    name: row.name,
    itemType: row.itemType,
    unitPrice: row.unitPrice ?? row.price ?? row.servicePrice,
    quantity: row.quantity,
    notes: row.notes
  }));
}

async function enrichItemsFromCatalog(businessId, items) {
  const out = [];
  for (const item of items) {
    if (item.serviceId && (!item.name || item.unitPrice == null)) {
      const meta = await resolveCatalogItemMeta(businessId, item.serviceId);
      if (meta) {
        out.push({
          ...item,
          name: item.name || meta.name,
          unitPrice: item.unitPrice != null ? item.unitPrice : meta.unitPrice,
          itemType: item.itemType || meta.itemType
        });
        continue;
      }
    }
    if (item.serviceId && !item.itemType) {
      const meta = await resolveCatalogItemMeta(businessId, item.serviceId);
      if (meta) item.itemType = meta.itemType;
    }
    out.push(item);
  }
  return out;
}

// GET /estimates
router.get('/estimates', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const status = String(req.query.status || '').trim().toUpperCase();
    const search = String(req.query.search || '').trim();
    const leadId = String(req.query.leadId || '').trim();

    const base = applySalesEstimateScope(req.user, scopedFilter(req, {}));
    const and = [];
    if (base.$or) {
      and.push({ $or: base.$or });
      const { $or, ...rest } = base;
      Object.assign(base, rest);
      delete base.$or;
    }
    let filter = { ...base };
    if (status && ['DRAFT', 'SHARED', 'CONVERTED', 'CANCELLED'].includes(status)) {
      filter.status = status;
    }
    if (leadId && mongoose.Types.ObjectId.isValid(leadId)) {
      filter.leadId = leadId;
    }
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      and.push({
        $or: [
          { estimateNumber: rx },
          { customerName: rx },
          { customerPhone: rx },
          { vehicleNumber: rx }
        ]
      });
    }
    if (and.length) filter = { ...filter, $and: and };

    const settings = await BusinessSettings.findOne({ businessId: req.businessId })
      .select('timezone')
      .lean();
    const rangeKey = req.query.range || req.query.dateRange || 'all';
    const { startUtc, endUtc } = parseBusinessDateRange(
      settings?.timezone,
      rangeKey,
      req.query.from,
      req.query.to
    );
    applyCreatedAtRange(filter, startUtc, endUtc);

    const [items, total] = await Promise.all([
      populateEstimate(
        Estimate.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      ).lean(),
      Estimate.countDocuments(filter)
    ]);

    res.json({
      success: true,
      estimates: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (e) {
    console.error('List estimates error:', e);
    res.status(500).json({ success: false, message: 'Failed to list estimates' });
  }
});

// GET /estimates/:id
router.get('/estimates/:id', async (req, res) => {
  try {
    const estimate = await findEstimate(req, req.params.id);
    if (!estimate) return res.status(404).json({ success: false, message: 'Estimate not found' });
    assertBranchAccess(req, estimate, { allowLegacyNull: true });
    res.json({ success: true, estimate });
  } catch (e) {
    console.error('Get estimate error:', e);
    res.status(e.status || 500).json({ success: false, message: e.message || 'Failed to load estimate' });
  }
});

// POST /estimates
router.post('/estimates', async (req, res) => {
  try {
    const body = req.body || {};
    const phone = normalizeEstimateCustomerPhone(body.customerPhone || body.phone);
    const name = String(body.customerName || body.name || '').trim();
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Customer name and phone are required' });
    }

    let lead = null;
    if (body.leadId && mongoose.Types.ObjectId.isValid(body.leadId)) {
      lead = await Lead.findOne(scopedFilter(req, { _id: body.leadId }));
      if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
      assertBranchAccess(req, lead, { allowLegacyNull: true });
    }

    const rawItems = await enrichItemsFromCatalog(req.businessId, parseItemsInput(body.items));
    const totals = computeEstimateTotals({
      items: rawItems,
      discountType: body.discountType,
      discount: body.discount,
      taxPercentage: body.taxPercentage
    });

    const status = String(body.status || 'DRAFT').toUpperCase() === 'SHARED' ? 'SHARED' : 'DRAFT';
    const estimate = new Estimate({
      businessId: req.businessId,
      branchId: branchIdForCreate(req),
      estimateNumber: await nextEstimateNumber(req.businessId),
      status,
      leadId: lead?._id || null,
      customerId: body.customerId || lead?.convertedCustomerId || null,
      customerName: name,
      customerPhone: phone,
      customerEmail: String(body.customerEmail || '').trim(),
      customerLocation: String(body.customerLocation || body.location || lead?.location || '').trim(),
      vehicleNumber: String(body.vehicleNumber || lead?.vehicleNumber || '').trim().toUpperCase(),
      vehicleBrand: String(body.vehicleBrand || lead?.vehicleBrand || '').trim(),
      vehicleModel: String(body.vehicleModel || lead?.vehicleModel || '').trim(),
      vehicleType: String(body.vehicleType || lead?.vehicleType || '').trim(),
      vehicleColor: String(body.vehicleColor || lead?.vehicleColor || '').trim(),
      ...totals,
      budgetAmount: body.budgetAmount != null && body.budgetAmount !== ''
        ? Math.max(0, Number(body.budgetAmount))
        : null,
      budgetLabel: String(body.budgetLabel || '').trim(),
      notes: String(body.notes || '').trim(),
      terms: String(body.terms || '').trim(),
      title: String(body.title || 'Estimate').trim() || 'Estimate',
      validUntil: body.validUntil ? new Date(body.validUntil) : null,
      assignedTo: body.assignedTo || lead?.assignedTo || (req.user?._id || null),
      createdBy: req.user._id
    });

    await applyCompanySnapshot(estimate, req.businessId);

    if (status === 'SHARED') {
      estimate.ensureShareToken();
      estimate.sharedAt = new Date();
    }

    await estimate.save();

    if (lead) {
      pushLeadActivity(lead, {
        type: 'ESTIMATE_CREATED',
        note: `Estimate ${estimate.estimateNumber} created`,
        createdBy: req.user._id
      });
      if (status === 'SHARED') {
        await markLeadEstimateShared(lead, {
          businessId: req.businessId,
          userId: req.user._id,
          estimateNumber: estimate.estimateNumber
        });
      } else {
        await lead.save();
      }
    }

    const saved = await findEstimate(req, estimate._id);
    res.status(201).json({ success: true, estimate: saved });
  } catch (e) {
    console.error('Create estimate error:', e);
    res.status(e.status || 500).json({ success: false, message: e.message || 'Failed to create estimate' });
  }
});

// PUT /estimates/:id
router.put('/estimates/:id', async (req, res) => {
  try {
    const estimate = await Estimate.findOne(
      applySalesEstimateScope(req.user, scopedFilter(req, { _id: req.params.id }))
    );
    if (!estimate) return res.status(404).json({ success: false, message: 'Estimate not found' });
    assertBranchAccess(req, estimate, { allowLegacyNull: true });
    assertSalesCanAccessEstimate(req.user, estimate);

    if (estimate.status === 'CONVERTED') {
      return res.status(400).json({ success: false, message: 'Converted estimates cannot be edited' });
    }
    if (estimate.status === 'CANCELLED') {
      return res.status(400).json({ success: false, message: 'Cancelled estimates cannot be edited' });
    }

    const body = req.body || {};
    if (body.customerName != null) estimate.customerName = String(body.customerName).trim();
    if (body.customerPhone != null || body.phone != null) {
      estimate.customerPhone = normalizeEstimateCustomerPhone(body.customerPhone || body.phone);
    }
    if (body.customerEmail != null) estimate.customerEmail = String(body.customerEmail).trim();
    if (body.customerLocation != null || body.location != null) {
      estimate.customerLocation = String(body.customerLocation || body.location || '').trim();
    }
    if (body.vehicleNumber != null) estimate.vehicleNumber = String(body.vehicleNumber).trim().toUpperCase();
    if (body.vehicleBrand != null) estimate.vehicleBrand = String(body.vehicleBrand).trim();
    if (body.vehicleModel != null) estimate.vehicleModel = String(body.vehicleModel).trim();
    if (body.vehicleType != null) estimate.vehicleType = String(body.vehicleType).trim();
    if (body.vehicleColor != null) estimate.vehicleColor = String(body.vehicleColor).trim();
    if (body.notes != null) estimate.notes = String(body.notes).trim();
    if (body.terms != null) estimate.terms = String(body.terms).trim();
    if (body.title != null) estimate.title = String(body.title).trim() || 'Estimate';
    if (body.validUntil !== undefined) {
      estimate.validUntil = body.validUntil ? new Date(body.validUntil) : null;
    }
    if (body.budgetAmount !== undefined) {
      estimate.budgetAmount =
        body.budgetAmount != null && body.budgetAmount !== ''
          ? Math.max(0, Number(body.budgetAmount))
          : null;
    }
    if (body.budgetLabel != null) estimate.budgetLabel = String(body.budgetLabel).trim();
    if (body.assignedTo !== undefined && isAdminPanelRole(req.user?.role)) {
      estimate.assignedTo = body.assignedTo || null;
    }

    if (Array.isArray(body.items)) {
      const rawItems = await enrichItemsFromCatalog(req.businessId, parseItemsInput(body.items));
      const totals = computeEstimateTotals({
        items: rawItems,
        discountType: body.discountType ?? estimate.discountType,
        discount: body.discount != null ? body.discount : estimate.discount,
        taxPercentage: body.taxPercentage != null ? body.taxPercentage : estimate.taxPercentage
      });
      Object.assign(estimate, totals);
    } else if (
      body.discountType != null ||
      body.discount != null ||
      body.taxPercentage != null
    ) {
      const totals = computeEstimateTotals({
        items: estimate.items,
        discountType: body.discountType ?? estimate.discountType,
        discount: body.discount != null ? body.discount : estimate.discount,
        taxPercentage: body.taxPercentage != null ? body.taxPercentage : estimate.taxPercentage
      });
      Object.assign(estimate, totals);
    }

    if (!estimate.customerName || !estimate.customerPhone) {
      return res.status(400).json({ success: false, message: 'Customer name and phone are required' });
    }

    await applyCompanySnapshot(estimate, req.businessId);
    await estimate.save();

    const saved = await findEstimate(req, estimate._id);
    res.json({ success: true, estimate: saved });
  } catch (e) {
    console.error('Update estimate error:', e);
    res.status(e.status || 500).json({ success: false, message: e.message || 'Failed to update estimate' });
  }
});

// POST /estimates/:id/share — mark shared + return token/url payload
router.post('/estimates/:id/share', async (req, res) => {
  try {
    const estimate = await Estimate.findOne(
      applySalesEstimateScope(req.user, scopedFilter(req, { _id: req.params.id }))
    );
    if (!estimate) return res.status(404).json({ success: false, message: 'Estimate not found' });
    assertBranchAccess(req, estimate, { allowLegacyNull: true });
    assertSalesCanAccessEstimate(req.user, estimate);

    if (estimate.status === 'CANCELLED') {
      return res.status(400).json({ success: false, message: 'Cannot share a cancelled estimate' });
    }
    if (!(estimate.items || []).length) {
      return res.status(400).json({ success: false, message: 'Add at least one service or product before sharing' });
    }

    const token = estimate.ensureShareToken();
    const wasDraft = estimate.status === 'DRAFT';
    if (estimate.status === 'DRAFT') {
      estimate.status = 'SHARED';
      estimate.sharedAt = new Date();
    } else if (!estimate.sharedAt) {
      estimate.sharedAt = new Date();
    }
    await estimate.save();

    if (estimate.leadId && wasDraft) {
      const lead = await Lead.findOne({ _id: estimate.leadId, businessId: req.businessId });
      if (lead) {
        await markLeadEstimateShared(lead, {
          businessId: req.businessId,
          userId: req.user._id,
          estimateNumber: estimate.estimateNumber
        });
      }
    }

    res.json({
      success: true,
      shareToken: token,
      status: estimate.status,
      estimate: await findEstimate(req, estimate._id)
    });
  } catch (e) {
    console.error('Share estimate error:', e);
    res.status(e.status || 500).json({ success: false, message: e.message || 'Failed to share estimate' });
  }
});

// GET /estimates/:id/share-url
router.get('/estimates/:id/share-url', async (req, res) => {
  try {
    const estimate = await Estimate.findOne(
      applySalesEstimateScope(req.user, scopedFilter(req, { _id: req.params.id }))
    );
    if (!estimate) return res.status(404).json({ success: false, message: 'Estimate not found' });
    assertBranchAccess(req, estimate, { allowLegacyNull: true });
    assertSalesCanAccessEstimate(req.user, estimate);

    const token = estimate.ensureShareToken();
    await estimate.save();
    res.json({ success: true, shareToken: token, estimateNumber: estimate.estimateNumber });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Failed to get share link' });
  }
});

// POST /estimates/:id/cancel
router.post('/estimates/:id/cancel', async (req, res) => {
  try {
    const estimate = await Estimate.findOne(
      applySalesEstimateScope(req.user, scopedFilter(req, { _id: req.params.id }))
    );
    if (!estimate) return res.status(404).json({ success: false, message: 'Estimate not found' });
    assertBranchAccess(req, estimate, { allowLegacyNull: true });
    assertSalesCanAccessEstimate(req.user, estimate);
    if (estimate.status === 'CONVERTED') {
      return res.status(400).json({ success: false, message: 'Converted estimates cannot be cancelled' });
    }
    estimate.status = 'CANCELLED';
    await estimate.save();
    res.json({ success: true, estimate: await findEstimate(req, estimate._id) });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Failed to cancel' });
  }
});

// POST /estimates/:id/link-booking — after AdminBookingNew creates a booking
router.post('/estimates/:id/link-booking', async (req, res) => {
  try {
    const estimate = await Estimate.findOne(
      applySalesEstimateScope(req.user, scopedFilter(req, { _id: req.params.id }))
    );
    if (!estimate) return res.status(404).json({ success: false, message: 'Estimate not found' });
    assertBranchAccess(req, estimate, { allowLegacyNull: true });
    assertSalesCanAccessEstimate(req.user, estimate);

    const bookingId = req.body?.bookingId;
    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, message: 'bookingId is required' });
    }
    if (estimate.convertedBookingId) {
      return res.status(400).json({ success: false, message: 'Estimate already linked to a booking' });
    }

    estimate.convertedBookingId = bookingId;
    estimate.convertedAt = estimate.convertedAt || new Date();
    estimate.status = 'CONVERTED';
    await estimate.save();

    if (estimate.leadId) {
      const lead = await Lead.findOne({ _id: estimate.leadId, businessId: req.businessId });
      if (lead && !lead.convertedBookingId) {
        lead.convertedBookingId = bookingId;
        pushLeadActivity(lead, {
          type: 'CONVERTED_BOOKING',
          note: String(req.body?.note || `Converted from estimate ${estimate.estimateNumber}`).trim(),
          createdBy: req.user._id
        });
        await markLeadConverted(lead, {
          businessId: req.businessId,
          userId: req.user._id,
          note: 'Auto-moved to Converted after booking from estimate'
        });
        await lead.save();
      }
    }

    res.json({ success: true, estimate: await findEstimate(req, estimate._id) });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Failed to link booking' });
  }
});

// POST /estimates/:id/convert-booking
router.post('/estimates/:id/convert-booking', async (req, res) => {
  try {
    const modules = req.businessModules || await getBusinessModules(req.businessId);
    if (!isModuleEnabled(modules, 'bookings')) {
      return res.status(403).json({ success: false, message: 'Bookings module is disabled' });
    }

    const estimate = await Estimate.findOne(
      applySalesEstimateScope(req.user, scopedFilter(req, { _id: req.params.id }))
    );
    if (!estimate) return res.status(404).json({ success: false, message: 'Estimate not found' });
    assertBranchAccess(req, estimate, { allowLegacyNull: true });
    assertSalesCanAccessEstimate(req.user, estimate);

    if (estimate.convertedBookingId) {
      return res.status(400).json({ success: false, message: 'Estimate already has a booking' });
    }
    if (estimate.status === 'CANCELLED') {
      return res.status(400).json({ success: false, message: 'Cannot convert a cancelled estimate' });
    }

    const overrides = req.body || {};
    const name = String(overrides.name || estimate.customerName || '').trim();
    const phone = normalizeEstimateCustomerPhone(overrides.phone || estimate.customerPhone);
    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Name and phone are required to create a booking',
        missing: [...(!name ? ['name'] : []), ...(!phone ? ['phone'] : [])]
      });
    }

    const { slotId, bookingDate, serviceIds } = overrides;
    const fromEstimate = estimateToJobServicePayload(estimate);
    const resolvedServiceIds =
      Array.isArray(serviceIds) && serviceIds.length ? serviceIds : fromEstimate.serviceIds;

    if (!slotId || !bookingDate || !resolvedServiceIds.length) {
      return res.status(400).json({
        success: false,
        message: 'bookingDate, slotId, and serviceIds are required',
        missing: [
          ...(!bookingDate ? ['bookingDate'] : []),
          ...(!slotId ? ['slotId'] : []),
          ...(!resolvedServiceIds.length ? ['serviceIds'] : [])
        ],
        estimateDefaults: {
          name,
          phone,
          vehicleNumber: estimate.vehicleNumber,
          serviceIds: fromEstimate.serviceIds
        }
      });
    }

    const { customer, car } = await ensureCustomerFromEstimate(
      estimate,
      req.businessId,
      branchIdForCreate(req),
      { ...overrides, name, phone }
    );

    const booking = await createAdminBooking(
      req.businessId,
      {
        customerId: customer._id,
        carId: car?._id,
        vehicleNumber: car?.carNumber || overrides.vehicleNumber || estimate.vehicleNumber,
        vehicleBrand: overrides.vehicleBrand || estimate.vehicleBrand,
        vehicleModel: overrides.vehicleModel || estimate.vehicleModel,
        vehicleType: overrides.vehicleType || estimate.vehicleType,
        slotId,
        bookingDate,
        serviceIds: resolvedServiceIds,
        bayNumber: overrides.bayNumber,
        notes: overrides.notes || `CRM estimate: ${estimate.estimateNumber}`,
        deliveryMethod: overrides.deliveryMethod || 'SELF_VISIT',
        pickupAddress: overrides.pickupAddress,
        autoConfirm: overrides.autoConfirm !== false
      },
      branchIdForCreate(req)
    );

    estimate.convertedBookingId = booking._id;
    estimate.convertedAt = estimate.convertedAt || new Date();
    estimate.customerId = customer._id;
    estimate.status = 'CONVERTED';
    await estimate.save();

    if (estimate.leadId) {
      const lead = await Lead.findOne({ _id: estimate.leadId, businessId: req.businessId });
      if (lead) {
        lead.convertedBookingId = booking._id;
        lead.convertedCustomerId = customer._id;
        pushLeadActivity(lead, {
          type: 'CONVERTED_BOOKING',
          note: `Converted from estimate ${estimate.estimateNumber}`,
          createdBy: req.user._id
        });
        await markLeadConverted(lead, {
          businessId: req.businessId,
          userId: req.user._id,
          note: 'Auto-moved to Converted after booking from estimate'
        });
        await lead.save();
      }
    }

    res.status(201).json({
      success: true,
      booking,
      estimate: await findEstimate(req, estimate._id)
    });
  } catch (e) {
    console.error('Estimate convert booking error:', e);
    res.status(e.status || 400).json({ success: false, message: e.message || 'Failed to create booking' });
  }
});

// POST /estimates/:id/convert-job
router.post('/estimates/:id/convert-job', async (req, res) => {
  try {
    const estimate = await Estimate.findOne(
      applySalesEstimateScope(req.user, scopedFilter(req, { _id: req.params.id }))
    );
    if (!estimate) return res.status(404).json({ success: false, message: 'Estimate not found' });
    assertBranchAccess(req, estimate, { allowLegacyNull: true });
    assertSalesCanAccessEstimate(req.user, estimate);

    if (estimate.convertedJobId) {
      return res.status(400).json({ success: false, message: 'Estimate already has a job' });
    }
    if (estimate.status === 'CANCELLED') {
      return res.status(400).json({ success: false, message: 'Cannot convert a cancelled estimate' });
    }
    if (!req.branchId) {
      return res.status(400).json({ success: false, message: 'Select an active branch first' });
    }

    const overrides = req.body || {};
    const name = String(overrides.name || estimate.customerName || '').trim();
    const phone = normalizeEstimateCustomerPhone(overrides.phone || estimate.customerPhone);
    const plate = String(overrides.vehicleNumber || estimate.vehicleNumber || '').trim();
    const fromEstimate = estimateToJobServicePayload(estimate);

    const hasServices =
      (Array.isArray(overrides.services) && overrides.services.length) ||
      (Array.isArray(overrides.serviceIds) && overrides.serviceIds.length) ||
      (fromEstimate.services && fromEstimate.services.length);

    const missing = [];
    if (!name) missing.push('name');
    if (!phone) missing.push('phone');
    if (!plate) missing.push('vehicleNumber');
    if (!hasServices) missing.push('serviceIds');
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: 'Missing fields required to create a job',
        missing,
        estimateDefaults: {
          name,
          phone,
          vehicleNumber: plate,
          vehicleBrand: estimate.vehicleBrand,
          vehicleModel: estimate.vehicleModel,
          vehicleType: estimate.vehicleType,
          vehicleColor: estimate.vehicleColor,
          ...fromEstimate
        }
      });
    }

    const { customer, car } = await ensureCustomerFromEstimate(
      estimate,
      req.businessId,
      branchIdForCreate(req),
      {
        ...overrides,
        name,
        phone,
        vehicleNumber: plate,
        vehicleBrand: overrides.vehicleBrand || estimate.vehicleBrand,
        vehicleModel: overrides.vehicleModel || estimate.vehicleModel,
        vehicleType: overrides.vehicleType || estimate.vehicleType,
        vehicleColor: overrides.vehicleColor || estimate.vehicleColor
      }
    );
    if (!car) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle number is required to create a wash job',
        missing: ['vehicleNumber']
      });
    }

    const Job = (await import('../models/Job.model.js')).default;
    const { resolveJobServiceLines } = await import('../utils/jobServiceLines.js');
    const { generateTokenNumber, calculateETA, canAcceptNewJob } = await import('../utils/job.utils.js');
    const { workCatalogServices } = await import('../utils/jobCart.js');
    const { normalizeJobAdvanceForCreate } = await import('../utils/jobAdvance.js');
    const { normalizeJobImageUrls, assertJobImageCount, resolveJobImageLimits } = await import('../utils/jobImages.js');
    const { getCardPaymentEnabled } = await import('../utils/onlinePaymentMode.js');

    const capacityCheck = await canAcceptNewJob(req.businessId, req.branchId);
    if (!capacityCheck.canAccept) {
      return res.status(400).json({ success: false, message: capacityCheck.reason });
    }

    let lines;
    let catalogServices;
    let totalPrice;
    try {
      ({ lines, totalPrice, catalogServices } = await resolveJobServiceLines(req.businessId, {
        serviceIds: overrides.serviceIds?.length ? overrides.serviceIds : fromEstimate.serviceIds,
        services: overrides.services?.length ? overrides.services : fromEstimate.services
      }));
    } catch (svcErr) {
      return res.status(svcErr.status || 400).json({ success: false, message: svcErr.message });
    }

    const productOnly = catalogServices.every((s) => s.isVariable && s.skipWorkProcess);
    if (productOnly) {
      return res.status(400).json({
        success: false,
        message: 'Use a wash or visit service when converting an estimate to a job'
      });
    }

    const createWithoutImages = !!overrides.createWithoutImages;
    const beforeImages = normalizeJobImageUrls(overrides.beforeImages);
    const imageSettings = await BusinessSettings.findOne({ businessId: req.businessId })
      .select('jobImagesMin jobImagesMax')
      .lean();
    const imageLimits = resolveJobImageLimits(imageSettings);
    try {
      assertJobImageCount(beforeImages, imageLimits, {
        allowEmpty: createWithoutImages,
        label: 'before photos'
      });
    } catch (imgErr) {
      return res.status(imgErr.status || 400).json({ success: false, message: imgErr.message });
    }

    const cardEnabled = await getCardPaymentEnabled(req.businessId);
    const advanceFields = normalizeJobAdvanceForCreate({ advancePayment: 0 }, 0, { cardEnabled });

    let job;
    let attempts = 0;
    while (attempts < 5) {
      try {
        const tokenNumber = await generateTokenNumber(req.businessId, req.branchId);
        job = await Job.create({
          businessId: req.businessId,
          branchId: req.branchId,
          customerId: customer._id,
          carId: car._id,
          tokenNumber,
          totalPrice,
          ...advanceFields,
          estimatedDelivery: calculateETA(workCatalogServices(catalogServices)),
          beforeImages: createWithoutImages ? [] : beforeImages,
          notes: overrides.notes || `CRM estimate: ${estimate.estimateNumber}`,
          assignedTo: overrides.assignedTo || null,
          services: lines,
          statusHistory: [{ status: 'RECEIVED', changedAt: new Date() }]
        });
        break;
      } catch (createError) {
        if (createError.code === 11000 && attempts < 4) {
          attempts++;
          continue;
        }
        throw createError;
      }
    }

    estimate.convertedJobId = job._id;
    estimate.convertedAt = estimate.convertedAt || new Date();
    estimate.customerId = customer._id;
    estimate.status = 'CONVERTED';
    await estimate.save();

    if (estimate.leadId) {
      const lead = await Lead.findOne({ _id: estimate.leadId, businessId: req.businessId });
      if (lead) {
        lead.convertedJobId = job._id;
        lead.convertedCustomerId = customer._id;
        pushLeadActivity(lead, {
          type: 'CONVERTED_JOB',
          note: `Converted from estimate ${estimate.estimateNumber} → job ${job.tokenNumber}`,
          createdBy: req.user._id
        });
        await markLeadConverted(lead, {
          businessId: req.businessId,
          userId: req.user._id,
          note: 'Auto-moved to Converted after job from estimate'
        });
        await lead.save();
      }
    }

    await job.populate('customerId', 'name phone');
    await job.populate('carId', 'carNumber brand model');

    res.status(201).json({
      success: true,
      job,
      estimate: await findEstimate(req, estimate._id)
    });
  } catch (e) {
    console.error('Estimate convert job error:', e);
    res.status(e.status || 500).json({ success: false, message: e.message || 'Failed to create job' });
  }
});

export default router;
