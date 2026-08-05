import express from 'express';
import { body, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveBranchContext, branchFilter } from '../middleware/branchContext.middleware.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import { scopedFilter, assertBranchAccess, branchIdForCreate } from '../utils/branchAccess.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Lead from '../models/Lead.model.js';
import LeadStatus from '../models/LeadStatus.model.js';
import LeadSource from '../models/LeadSource.model.js';
import {
  ensureCrmDefaults,
  getAllowedStatusTransitions,
  getFunnelTimelineStatuses,
  isTerminalStatus
} from '../utils/crmPipeline.js';
import {
  changeLeadStatus,
  createLeadRecord,
  ensureCustomerAndCarFromLead,
  listCrmMeta,
  markLeadConverted,
  parseLeadsCsv,
  pushLeadActivity
} from '../utils/crmService.js';
import { createAdminBooking } from '../services/bookingService.js';
import { isModuleEnabled } from '../services/businessModulesService.js';
import { normalizePhone, applyDefaultCountryCode } from '../utils/customer.utils.js';
import { parseBusinessDateRange, applyCreatedAtRange } from '../utils/businessDateRange.js';

const router = express.Router();

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.user?.businessId) {
    return res.status(403).json({ success: false, message: 'Business not assigned' });
  }
  req.businessId = req.user.businessId;
  next();
});
router.use(resolveBranchContext);
router.use(enforceActiveSubscription());

async function requireCrmEnabled(req, res, next) {
  try {
    const settings = await BusinessSettings.findOne({ businessId: req.businessId })
      .select('crmEnabled')
      .lean();
    if (!settings?.crmEnabled) {
      return res.status(403).json({
        success: false,
        message: 'CRM is disabled. Enable it in Settings to use leads.',
        code: 'CRM_DISABLED'
      });
    }
    await ensureCrmDefaults(req.businessId);
    next();
  } catch (e) {
    next(e);
  }
}

router.use(requireCrmEnabled);

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      message: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array()
    });
    return false;
  }
  return true;
}

async function findLead(req, id) {
  const lead = await Lead.findOne(scopedFilter(req, { _id: id }))
    .populate('statusId')
    .populate('sourceId')
    .populate('assignedTo', 'name employeeCode')
    .populate('convertedCustomerId', 'name phone')
    .populate('convertedBookingId', 'bookingDate status')
    .populate('convertedJobId', 'tokenNumber status');
  if (lead) assertBranchAccess(req, lead, { allowLegacyNull: true });
  return lead;
}

function leadFilter(req, extra = {}) {
  return { ...branchFilter(req), ...extra };
}

// ---------- Meta ----------
router.get('/meta', async (req, res) => {
  try {
    const meta = await listCrmMeta(req.businessId);
    res.json({ success: true, ...meta });
  } catch (e) {
    console.error('CRM meta error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Statuses ----------
router.get('/statuses', async (req, res) => {
  try {
    const statuses = await LeadStatus.find({ businessId: req.businessId }).sort({ sortOrder: 1, name: 1 });
    res.json({ success: true, statuses });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/statuses', [
  body('name').trim().notEmpty().withMessage('Status name is required'),
  body('sortOrder').isInt({ min: 0 }).withMessage('Sort order must be 0 or greater'),
  body('color').optional().trim().isString(),
  body('isFollowUp').optional().isBoolean(),
  body('isTerminal').optional().isBoolean()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const sortOrder = Number(req.body.sortOrder);
    const isTerminal = sortOrder === 0 || !!req.body.isTerminal;
    const status = await LeadStatus.create({
      businessId: req.businessId,
      name: req.body.name.trim(),
      sortOrder,
      color: req.body.color?.trim() || (isTerminal ? '#ef4444' : '#64748b'),
      isFollowUp: !!req.body.isFollowUp && !isTerminal,
      isTerminal,
      isActive: true,
      isSystem: false
    });
    res.status(201).json({ success: true, status });
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ success: false, message: 'A status with this name already exists' });
    }
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.put('/statuses/reorder', [
  body('orderedIds').isArray({ min: 1 }).withMessage('orderedIds required')
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const ids = req.body.orderedIds.map(String);
    const statuses = await LeadStatus.find({ businessId: req.businessId, _id: { $in: ids } });
    const byId = new Map(statuses.map((s) => [String(s._id), s]));
    let order = 1;
    for (const id of ids) {
      const s = byId.get(id);
      if (!s) continue;
      if (s.isTerminal || Number(s.sortOrder) === 0) {
        s.sortOrder = 0;
        s.isTerminal = true;
      } else {
        s.sortOrder = order++;
      }
      await s.save();
    }
    const next = await LeadStatus.find({ businessId: req.businessId }).sort({ sortOrder: 1, name: 1 });
    res.json({ success: true, statuses: next });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.put('/statuses/:id', [
  body('name').optional().trim().notEmpty(),
  body('sortOrder').optional().isInt({ min: 0 }),
  body('color').optional().trim().isString(),
  body('isFollowUp').optional().isBoolean(),
  body('isTerminal').optional().isBoolean(),
  body('isActive').optional().isBoolean()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const status = await LeadStatus.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    if (req.body.name !== undefined) status.name = req.body.name.trim();
    if (req.body.sortOrder !== undefined) status.sortOrder = Number(req.body.sortOrder);
    if (req.body.color !== undefined) status.color = req.body.color.trim();
    if (req.body.isFollowUp !== undefined) status.isFollowUp = !!req.body.isFollowUp;
    if (req.body.isTerminal !== undefined) status.isTerminal = !!req.body.isTerminal;
    if (req.body.isActive !== undefined) status.isActive = !!req.body.isActive;

    if (status.sortOrder === 0) {
      status.isTerminal = true;
      status.isFollowUp = false;
    }
    if (status.isTerminal) status.isFollowUp = false;

    await status.save();
    res.json({ success: true, status });
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ success: false, message: 'A status with this name already exists' });
    }
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.delete('/statuses/:id', async (req, res) => {
  try {
    const status = await LeadStatus.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    const remaining = await LeadStatus.countDocuments({
      businessId: req.businessId,
      _id: { $ne: status._id }
    });
    if (remaining < 1) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete the last status. Create another status first.'
      });
    }

    const leadCount = await Lead.countDocuments({
      businessId: req.businessId,
      statusId: status._id
    });

    if (leadCount > 0) {
      const moveToStatusId = req.body?.moveToStatusId || req.query?.moveToStatusId;
      if (!moveToStatusId || !mongoose.isValidObjectId(moveToStatusId)) {
        return res.status(400).json({
          success: false,
          code: 'STATUS_IN_USE',
          count: leadCount,
          message: `${leadCount} lead(s) use this status. Choose another status to move them to, then delete.`
        });
      }
      if (String(moveToStatusId) === String(status._id)) {
        return res.status(400).json({
          success: false,
          message: 'Choose a different status to move leads into'
        });
      }
      const target = await LeadStatus.findOne({ _id: moveToStatusId, businessId: req.businessId });
      if (!target) {
        return res.status(400).json({ success: false, message: 'Target status not found' });
      }
      await Lead.updateMany(
        { businessId: req.businessId, statusId: status._id },
        { $set: { statusId: target._id } }
      );
    }

    await LeadStatus.deleteOne({ _id: status._id });
    const statuses = await LeadStatus.find({ businessId: req.businessId }).sort({ sortOrder: 1, name: 1 });
    res.json({ success: true, statuses, movedLeads: leadCount });
  } catch (e) {
    console.error('Delete lead status error:', e);
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

// ---------- Sources ----------
router.get('/sources', async (req, res) => {
  try {
    const sources = await LeadSource.find({ businessId: req.businessId }).sort({ name: 1 });
    res.json({ success: true, sources });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/sources', [
  body('name').trim().notEmpty().withMessage('Source name is required')
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const source = await LeadSource.create({
      businessId: req.businessId,
      name: req.body.name.trim(),
      isActive: true,
      isSystem: false
    });
    res.status(201).json({ success: true, source });
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ success: false, message: 'A source with this name already exists' });
    }
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.put('/sources/:id', [
  body('name').optional().trim().notEmpty(),
  body('isActive').optional().isBoolean()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const source = await LeadSource.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });
    if (req.body.name !== undefined) source.name = req.body.name.trim();
    if (req.body.isActive !== undefined) source.isActive = !!req.body.isActive;
    await source.save();
    res.json({ success: true, source });
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ success: false, message: 'A source with this name already exists' });
    }
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.delete('/sources/:id', async (req, res) => {
  try {
    const source = await LeadSource.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

    const cleared = await Lead.updateMany(
      { businessId: req.businessId, sourceId: source._id },
      { $set: { sourceId: null } }
    );

    await LeadSource.deleteOne({ _id: source._id });
    const sources = await LeadSource.find({ businessId: req.businessId }).sort({ name: 1 });
    res.json({
      success: true,
      sources,
      clearedLeads: cleared?.modifiedCount || 0
    });
  } catch (e) {
    console.error('Delete lead source error:', e);
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

// ---------- Leads ----------
router.get('/leads', async (req, res) => {
  try {
    const {
      statusId,
      sourceId,
      search,
      followUpDue,
      range = 'all',
      from,
      to,
      page = '1',
      limit = '50'
    } = req.query;

    const filter = leadFilter(req);
    if (statusId && mongoose.isValidObjectId(statusId)) filter.statusId = statusId;
    if (sourceId && mongoose.isValidObjectId(sourceId)) filter.sourceId = sourceId;
    if (followUpDue === '1' || followUpDue === 'true') {
      filter.followUpAt = { $ne: null, $lte: new Date() };
      // Converted / already-booked leads must not appear as open follow-ups
      filter.convertedAt = null;
      filter.convertedBookingId = null;
      filter.convertedJobId = null;
    }
    if (search && String(search).trim()) {
      const q = String(search).trim();
      const phoneQ = normalizePhone(q) || q;
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { phone: { $regex: phoneQ, $options: 'i' } },
        { location: { $regex: q, $options: 'i' } },
        { vehicleNumber: { $regex: q, $options: 'i' } }
      ];
    }

    // Date filter (same range tokens as Reports) — filters by lead createdAt
    let rangeMeta = { rangeLabel: 'All time', start: null, end: null };
    const rangeKey = String(range || 'all').toLowerCase();
    if (rangeKey && rangeKey !== 'all') {
      const settings = await BusinessSettings.findOne({ businessId: req.businessId })
        .select('timezone')
        .lean();
      try {
        const { startUtc, endUtc, rangeLabel } = parseBusinessDateRange(
          settings?.timezone,
          rangeKey,
          from,
          to
        );
        applyCreatedAtRange(filter, startUtc, endUtc);
        rangeMeta = { rangeLabel, start: startUtc, end: endUtc };
      } catch (rangeErr) {
        return res.status(rangeErr.statusCode || 400).json({
          success: false,
          message: rangeErr.message || 'Invalid date range'
        });
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * lim;

    const [leads, total, meta] = await Promise.all([
      Lead.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(lim)
        .populate('statusId')
        .populate('sourceId')
        .populate('assignedTo', 'name')
        .lean(),
      Lead.countDocuments(filter),
      listCrmMeta(req.businessId)
    ]);

    res.json({
      success: true,
      leads,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim) || 1,
      funnel: meta.funnel,
      statuses: meta.statuses,
      sources: meta.sources,
      range: rangeKey,
      rangeLabel: rangeMeta.rangeLabel,
      start: rangeMeta.start,
      end: rangeMeta.end
    });
  } catch (e) {
    console.error('List leads error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/leads', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('phone').trim().notEmpty().withMessage('Phone is required'),
  body('location').optional().trim().isString(),
  body('statusId').optional().isMongoId(),
  body('sourceId').optional({ checkFalsy: true }).isMongoId()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    if (!req.branchId) {
      return res.status(400).json({ success: false, message: 'Select an active branch first' });
    }
    const lead = await createLeadRecord({
      businessId: req.businessId,
      branchId: branchIdForCreate(req),
      userId: req.user._id,
      body: req.body
    });
    await lead.populate('statusId');
    await lead.populate('sourceId');
    res.status(201).json({ success: true, lead });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.post('/leads/import', [
  body('csv').isString().notEmpty().withMessage('CSV content is required')
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    if (!req.branchId) {
      return res.status(400).json({ success: false, message: 'Select an active branch first' });
    }
    const rows = parseLeadsCsv(req.body.csv);
    const sources = await LeadSource.find({ businessId: req.businessId }).lean();
    const sourceByName = new Map(sources.map((s) => [s.name.toLowerCase(), s]));

    let created = 0;
    const errors = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        let sourceId = null;
        if (row.sourceName?.trim()) {
          const key = row.sourceName.trim().toLowerCase();
          let src = sourceByName.get(key);
          if (!src) {
            src = await LeadSource.create({
              businessId: req.businessId,
              name: row.sourceName.trim(),
              isActive: true
            });
            sourceByName.set(key, src);
          }
          sourceId = src._id;
        }
        await createLeadRecord({
          businessId: req.businessId,
          branchId: branchIdForCreate(req),
          userId: req.user._id,
          body: { ...row, sourceId },
          imported: true
        });
        created++;
      } catch (rowErr) {
        errors.push({ row: i + 2, message: rowErr.message || 'Failed' });
      }
    }
    res.json({ success: true, created, failed: errors.length, errors: errors.slice(0, 50) });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.get('/leads/:id', async (req, res) => {
  try {
    const lead = await findLead(req, req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    const meta = await listCrmMeta(req.businessId);
    const current = meta.statuses.find((s) => String(s._id) === String(lead.statusId?._id || lead.statusId));
    const allowedNext = getAllowedStatusTransitions(current, meta.statuses);
    res.json({
      success: true,
      lead,
      funnel: meta.funnel,
      allowedNextStatuses: allowedNext,
      isTerminal: isTerminalStatus(current),
      statuses: meta.statuses,
      sources: meta.sources
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/leads/:id', async (req, res) => {
  try {
    const lead = await Lead.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    assertBranchAccess(req, lead, { allowLegacyNull: true });

    const fields = [
      'name', 'location', 'vehicleNumber', 'vehicleBrand', 'vehicleModel',
      'vehicleColor', 'vehicleType', 'notes', 'followUpNotes'
    ];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        lead[f] = f === 'vehicleNumber'
          ? String(req.body[f] || '').trim().toUpperCase()
          : String(req.body[f] || '').trim();
      }
    }
    if (req.body.phone !== undefined) {
      const phone = applyDefaultCountryCode(normalizePhone(req.body.phone));
      if (!phone) return res.status(400).json({ success: false, message: 'Invalid phone' });
      lead.phone = phone;
    }
    if (req.body.sourceId !== undefined) {
      if (!req.body.sourceId) lead.sourceId = null;
      else {
        const src = await LeadSource.findOne({ _id: req.body.sourceId, businessId: req.businessId });
        if (!src) return res.status(400).json({ success: false, message: 'Source not found' });
        lead.sourceId = src._id;
      }
    }
    if (req.body.followUpAt !== undefined) {
      lead.followUpAt = req.body.followUpAt ? new Date(req.body.followUpAt) : null;
    }
    if (req.body.assignedTo !== undefined) {
      lead.assignedTo = req.body.assignedTo || null;
    }

    pushLeadActivity(lead, {
      type: 'UPDATED',
      note: String(req.body.updateNote || 'Lead details updated').trim(),
      createdBy: req.user._id
    });
    await lead.save();
    await lead.populate('statusId');
    await lead.populate('sourceId');
    res.json({ success: true, lead });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.post('/leads/:id/status', [
  body('statusId').isMongoId().withMessage('Status is required'),
  body('note').trim().notEmpty().withMessage('Note is required for status change'),
  body('followUpAt').optional({ checkFalsy: true }).isISO8601(),
  body('followUpNotes').optional().trim().isString()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const lead = await Lead.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    assertBranchAccess(req, lead, { allowLegacyNull: true });

    await changeLeadStatus({
      lead,
      businessId: req.businessId,
      userId: req.user._id,
      statusId: req.body.statusId,
      note: req.body.note,
      followUpAt: req.body.followUpAt,
      followUpNotes: req.body.followUpNotes
    });

    const populated = await findLead(req, lead._id);
    const meta = await listCrmMeta(req.businessId);
    const current = meta.statuses.find((s) => String(s._id) === String(populated.statusId?._id));
    res.json({
      success: true,
      lead: populated,
      allowedNextStatuses: getAllowedStatusTransitions(current, meta.statuses),
      isTerminal: isTerminalStatus(current)
    });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.post('/leads/:id/note', [
  body('note').trim().notEmpty().withMessage('Note is required')
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const lead = await Lead.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    assertBranchAccess(req, lead, { allowLegacyNull: true });
    pushLeadActivity(lead, {
      type: 'NOTE',
      note: req.body.note.trim(),
      createdBy: req.user._id
    });
    await lead.save();
    res.json({ success: true, lead: await findLead(req, lead._id) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

/** Prefill data for booking / job conversion — does NOT create a Customer. */
router.get('/leads/:id/convert-context', async (req, res) => {
  try {
    const lead = await findLead(req, req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    const missing = [];
    if (!lead.name?.trim()) missing.push('name');
    if (!lead.phone?.trim()) missing.push('phone');
    const target = String(req.query.target || 'booking');
    if (target === 'job' && !lead.vehicleNumber?.trim()) missing.push('vehicleNumber');

    const User = (await import('../models/User.model.js')).default;
    const employees = target === 'job'
      ? await User.find({
        businessId: req.businessId,
        role: 'EMPLOYEE',
        status: 'ACTIVE'
      })
        .select('name email employeeCode')
        .sort({ name: 1 })
        .lean()
      : [];

    res.json({
      success: true,
      lead: {
        _id: lead._id,
        name: lead.name,
        phone: lead.phone,
        location: lead.location,
        vehicleNumber: lead.vehicleNumber,
        vehicleBrand: lead.vehicleBrand,
        vehicleModel: lead.vehicleModel,
        vehicleColor: lead.vehicleColor,
        vehicleType: lead.vehicleType,
        notes: lead.notes
      },
      missing,
      employees,
      bookingsModule: isModuleEnabled(req.businessModules, 'bookings'),
      hasBooking: !!lead.convertedBookingId,
      hasJob: !!lead.convertedJobId,
      isConverted: !!lead.convertedAt
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Deprecated: previously created Customer before booking existed.
 * Now returns lead prefill only — customer is created on booking/job conversion.
 */
router.post('/leads/:id/prepare-customer', async (req, res) => {
  try {
    const lead = await findLead(req, req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    const overrides = req.body || {};
    const name = String(overrides.name || lead.name || '').trim();
    const phone = applyDefaultCountryCode(normalizePhone(overrides.phone || lead.phone));
    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Name and phone are required',
        missing: [...(!name ? ['name'] : []), ...(!phone ? ['phone'] : [])]
      });
    }
    res.json({
      success: true,
      deferredCustomer: true,
      message: 'Customer will be created when the booking or job is saved',
      lead: {
        _id: lead._id,
        name,
        phone,
        location: String(overrides.location ?? lead.location ?? '').trim(),
        vehicleNumber: String(overrides.vehicleNumber ?? lead.vehicleNumber ?? '').trim(),
        vehicleBrand: String(overrides.vehicleBrand ?? lead.vehicleBrand ?? '').trim(),
        vehicleModel: String(overrides.vehicleModel ?? lead.vehicleModel ?? '').trim(),
        vehicleColor: String(overrides.vehicleColor ?? lead.vehicleColor ?? '').trim(),
        vehicleType: String(overrides.vehicleType ?? lead.vehicleType ?? '').trim()
      },
      customerId: null,
      carId: null
    });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

/** Link an already-created booking to this lead (creates/links customer from booking). */
router.post('/leads/:id/link-booking', [
  body('bookingId').isMongoId().withMessage('bookingId required'),
  body('note').optional().trim().isString()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const lead = await Lead.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    assertBranchAccess(req, lead, { allowLegacyNull: true });

    if (lead.convertedBookingId) {
      return res.json({ success: true, lead: await findLead(req, lead._id), alreadyLinked: true });
    }

    const Booking = (await import('../models/Booking.model.js')).default;
    const booking = await Booking.findOne({ _id: req.body.bookingId, businessId: req.businessId });
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    lead.convertedBookingId = booking._id;
    if (booking.customerId) lead.convertedCustomerId = booking.customerId;
    pushLeadActivity(lead, {
      type: 'CONVERTED_BOOKING',
      note: String(req.body.note || 'Linked booking from CRM').trim(),
      createdBy: req.user._id
    });
    await markLeadConverted(lead, {
      businessId: req.businessId,
      userId: req.user._id,
      note: 'Auto-moved to Converted after booking'
    });
    await lead.save();
    res.json({ success: true, lead: await findLead(req, lead._id) });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.post('/leads/:id/convert-booking', async (req, res) => {
  try {
    if (!isModuleEnabled(req.businessModules, 'bookings')) {
      return res.status(403).json({ success: false, message: 'Bookings module is disabled' });
    }
    const lead = await Lead.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    assertBranchAccess(req, lead, { allowLegacyNull: true });

    if (lead.convertedBookingId) {
      return res.status(400).json({ success: false, message: 'Lead already has a booking' });
    }

    const overrides = req.body || {};
    const name = String(overrides.name || lead.name || '').trim();
    const phone = applyDefaultCountryCode(normalizePhone(overrides.phone || lead.phone));
    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Name and phone are required to create a booking',
        missing: [
          ...(!name ? ['name'] : []),
          ...(!phone ? ['phone'] : [])
        ]
      });
    }

    const { slotId, bookingDate, serviceIds } = overrides;
    if (!slotId || !bookingDate || !Array.isArray(serviceIds) || !serviceIds.length) {
      return res.status(400).json({
        success: false,
        message: 'bookingDate, slotId, and serviceIds are required',
        missing: [
          ...(!bookingDate ? ['bookingDate'] : []),
          ...(!slotId ? ['slotId'] : []),
          ...(!serviceIds?.length ? ['serviceIds'] : [])
        ]
      });
    }

    const { customer, car } = await ensureCustomerAndCarFromLead(
      lead,
      req.businessId,
      branchIdForCreate(req),
      overrides
    );

    const booking = await createAdminBooking(
      req.businessId,
      {
        customerId: customer._id,
        carId: car?._id,
        vehicleNumber: car?.carNumber || overrides.vehicleNumber || lead.vehicleNumber,
        vehicleBrand: overrides.vehicleBrand || lead.vehicleBrand,
        vehicleModel: overrides.vehicleModel || lead.vehicleModel,
        vehicleType: overrides.vehicleType || lead.vehicleType,
        slotId,
        bookingDate,
        serviceIds,
        bayNumber: overrides.bayNumber,
        notes: overrides.notes || `CRM lead: ${lead.name}`,
        deliveryMethod: overrides.deliveryMethod || 'SELF_VISIT',
        pickupAddress: overrides.pickupAddress,
        autoConfirm: overrides.autoConfirm !== false
      },
      branchIdForCreate(req)
    );

    lead.convertedBookingId = booking._id;
    lead.convertedCustomerId = customer._id;
    pushLeadActivity(lead, {
      type: 'CONVERTED_BOOKING',
      note: String(overrides.note || 'Converted to booking').trim(),
      createdBy: req.user._id
    });
    await markLeadConverted(lead, {
      businessId: req.businessId,
      userId: req.user._id,
      note: 'Auto-moved to Converted after booking'
    });

    await lead.save();
    res.status(201).json({
      success: true,
      lead: await findLead(req, lead._id),
      booking
    });
  } catch (e) {
    console.error('Lead convert booking error:', e);
    res.status(e.status || 400).json({ success: false, message: e.message || 'Failed to create booking' });
  }
});

router.post('/leads/:id/convert-job', async (req, res) => {
  try {
    const lead = await Lead.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    assertBranchAccess(req, lead, { allowLegacyNull: true });

    if (lead.convertedJobId) {
      return res.status(400).json({ success: false, message: 'Lead already has a job' });
    }

    const overrides = req.body || {};
    const name = String(overrides.name || lead.name || '').trim();
    const phone = applyDefaultCountryCode(normalizePhone(overrides.phone || lead.phone));
    const plate = String(overrides.vehicleNumber || lead.vehicleNumber || '').trim();
    const missing = [];
    if (!name) missing.push('name');
    if (!phone) missing.push('phone');
    if (!plate) missing.push('vehicleNumber');
    const hasServices = (Array.isArray(overrides.services) && overrides.services.length)
      || (Array.isArray(overrides.serviceIds) && overrides.serviceIds.length);
    if (!hasServices) missing.push('serviceIds');
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: 'Missing fields required to create a job',
        missing
      });
    }

    if (!req.branchId) {
      return res.status(400).json({ success: false, message: 'Select an active branch first' });
    }

    const { customer, car } = await ensureCustomerAndCarFromLead(
      lead,
      req.businessId,
      branchIdForCreate(req),
      {
        ...overrides,
        vehicleNumber: plate,
        vehicleBrand: overrides.vehicleBrand,
        vehicleModel: overrides.vehicleModel,
        vehicleType: overrides.vehicleType,
        vehicleColor: overrides.vehicleColor
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
    const { normalizeJobImageUrls, assertJobImageCount } = await import('../utils/jobImages.js');

    const capacityCheck = await canAcceptNewJob(req.businessId, req.branchId);
    if (!capacityCheck.canAccept) {
      return res.status(400).json({ success: false, message: capacityCheck.reason });
    }

    let lines;
    let catalogServices;
    let totalPrice;
    try {
      ({ lines, totalPrice, catalogServices } = await resolveJobServiceLines(req.businessId, {
        serviceIds: overrides.serviceIds,
        services: overrides.services
      }));
    } catch (svcErr) {
      return res.status(svcErr.status || 400).json({ success: false, message: svcErr.message });
    }

    const productOnly = catalogServices.every((s) => s.isVariable && s.skipWorkProcess);
    if (productOnly) {
      return res.status(400).json({
        success: false,
        message: 'Use a wash or visit service when converting a lead to a job'
      });
    }

    const createWithoutImages = !!overrides.createWithoutImages;
    const beforeImages = normalizeJobImageUrls(overrides.beforeImages);
    const imageLimits = await BusinessSettings.findOne({ businessId: req.businessId })
      .select('jobImagesMin jobImagesMax')
      .lean();
    try {
      assertJobImageCount(beforeImages, imageLimits, {
        allowEmpty: createWithoutImages,
        label: 'before photos'
      });
      if (createWithoutImages && beforeImages.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Remove uploaded photos or uncheck "Submit without images"'
        });
      }
    } catch (imgErr) {
      return res.status(imgErr.status || 400).json({ success: false, message: imgErr.message });
    }

    let assignedTo = overrides.assignedTo || null;
    if (assignedTo) {
      const User = (await import('../models/User.model.js')).default;
      const emp = await User.findOne({
        _id: assignedTo,
        businessId: req.businessId,
        role: 'EMPLOYEE',
        status: 'ACTIVE'
      }).select('_id').lean();
      if (!emp) assignedTo = null;
    }

    const { getCardPaymentEnabled } = await import('../utils/onlinePaymentMode.js');
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
          notes: overrides.notes || overrides.note || `CRM lead: ${lead.name}`,
          assignedTo,
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

    lead.convertedJobId = job._id;
    lead.convertedCustomerId = customer._id;
    pushLeadActivity(lead, {
      type: 'CONVERTED_JOB',
      note: String(overrides.note || `Converted to job ${job.tokenNumber}`).trim(),
      createdBy: req.user._id
    });
    await markLeadConverted(lead, {
      businessId: req.businessId,
      userId: req.user._id,
      note: 'Auto-moved to Converted after job'
    });
    await lead.save();

    await job.populate('customerId', 'name phone');
    await job.populate('carId', 'carNumber brand model');

    res.status(201).json({
      success: true,
      lead: await findLead(req, lead._id),
      job
    });
  } catch (e) {
    console.error('Lead convert job error:', e);
    res.status(e.status || 500).json({ success: false, message: e.message || 'Failed to create job' });
  }
});

export default router;
