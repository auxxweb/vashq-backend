import Lead from '../models/Lead.model.js';
import LeadStatus from '../models/LeadStatus.model.js';
import LeadSource from '../models/LeadSource.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import { normalizePhone, applyDefaultCountryCode, findCustomerByPhone } from './customer.utils.js';
import {
  ensureCrmDefaults,
  getAllowedStatusTransitions,
  getDefaultLeadStatus,
  getFunnelTimelineStatuses,
  isTerminalStatus
} from './crmPipeline.js';

export function pushLeadActivity(lead, entry) {
  if (!lead.activity) lead.activity = [];
  lead.activity.push({
    ...entry,
    createdAt: entry.createdAt || new Date()
  });
  if (lead.activity.length > 200) {
    lead.activity = lead.activity.slice(-200);
  }
}

/** Clear open follow-up schedule and log FOLLOW_UP_DONE when one was set. */
export function closeLeadFollowUps(lead, userId, note = 'Follow-up closed') {
  if (!lead) return false;
  const hadFollowUp = !!(lead.followUpAt || String(lead.followUpNotes || '').trim());
  if (!hadFollowUp) {
    lead.followUpAt = null;
    lead.followUpNotes = '';
    return false;
  }
  pushLeadActivity(lead, {
    type: 'FOLLOW_UP_DONE',
    note: String(note || 'Follow-up closed').trim(),
    followUpAt: lead.followUpAt || null,
    createdBy: userId || null
  });
  lead.followUpAt = null;
  lead.followUpNotes = '';
  return true;
}

/** Ensure a Converted status exists (terminal — closed funnel outcome). */
export async function getOrCreateConvertedStatus(businessId) {
  await ensureCrmDefaults(businessId);
  let status = await LeadStatus.findOne({
    businessId,
    name: /^converted$/i,
    isActive: true
  });
  if (!status) {
    status = await LeadStatus.create({
      businessId,
      name: 'Converted',
      sortOrder: 6,
      color: '#059669',
      isTerminal: true,
      isFollowUp: false,
      isSystem: true,
      isActive: true
    });
  } else if (!status.isTerminal || status.isFollowUp) {
    status.isTerminal = true;
    status.isFollowUp = false;
    await status.save();
  }
  return status;
}

/**
 * Move lead to Converted, close follow-ups, stamp convertedAt.
 * Safe to call multiple times (idempotent status/follow-up clear).
 */
export async function markLeadConverted(lead, { businessId, userId, note } = {}) {
  if (!lead) return lead;
  closeLeadFollowUps(lead, userId, 'Follow-up closed on conversion');

  const convertedStatus = await getOrCreateConvertedStatus(businessId || lead.businessId);
  if (convertedStatus && String(lead.statusId) !== String(convertedStatus._id)) {
    const prev = lead.statusId
      ? await LeadStatus.findById(lead.statusId).lean()
      : null;
    pushLeadActivity(lead, {
      type: 'STATUS_CHANGE',
      note: String(note || 'Auto-moved to Converted').trim(),
      fromStatusId: prev?._id || null,
      fromStatusName: prev?.name || '',
      toStatusId: convertedStatus._id,
      toStatusName: convertedStatus.name,
      createdBy: userId || null
    });
    lead.statusId = convertedStatus._id;
  }
  lead.convertedAt = lead.convertedAt || new Date();
  return lead;
}

export async function listCrmMeta(businessId) {
  await ensureCrmDefaults(businessId);
  const [statuses, sources] = await Promise.all([
    LeadStatus.find({ businessId }).sort({ sortOrder: 1, name: 1 }).lean(),
    LeadSource.find({ businessId }).sort({ name: 1 }).lean()
  ]);
  return {
    statuses,
    sources,
    funnel: getFunnelTimelineStatuses(statuses)
  };
}

export async function createLeadRecord({
  businessId,
  branchId,
  userId,
  body,
  imported = false
}) {
  await ensureCrmDefaults(businessId);
  const name = String(body.name || '').trim();
  const phone = applyDefaultCountryCode(normalizePhone(body.phone));
  if (!name) {
    const err = new Error('Customer name is required');
    err.status = 400;
    throw err;
  }
  if (!phone) {
    const err = new Error('Phone number is required');
    err.status = 400;
    throw err;
  }

  let status;
  if (body.statusId) {
    status = await LeadStatus.findOne({ _id: body.statusId, businessId, isActive: true });
  }
  if (!status) {
    status = await getDefaultLeadStatus(businessId);
  }
  if (!status) {
    const err = new Error('No lead status configured');
    err.status = 400;
    throw err;
  }

  let sourceId = null;
  if (body.sourceId) {
    const src = await LeadSource.findOne({ _id: body.sourceId, businessId, isActive: true });
    if (src) sourceId = src._id;
  }

  const lead = await Lead.create({
    businessId,
    branchId: branchId || null,
    name,
    phone,
    location: String(body.location || '').trim(),
    vehicleNumber: String(body.vehicleNumber || '').trim().toUpperCase(),
    vehicleBrand: String(body.vehicleBrand || '').trim(),
    vehicleModel: String(body.vehicleModel || '').trim(),
    vehicleColor: String(body.vehicleColor || '').trim(),
    vehicleType: String(body.vehicleType || '').trim(),
    notes: String(body.notes || '').trim(),
    statusId: status._id,
    sourceId,
    followUpAt: body.followUpAt ? new Date(body.followUpAt) : null,
    followUpNotes: String(body.followUpNotes || '').trim(),
    assignedTo: body.assignedTo || null,
    createdBy: userId || null,
    activity: [{
      type: imported ? 'IMPORTED' : 'CREATED',
      note: imported ? 'Imported from CSV' : 'Lead created',
      toStatusId: status._id,
      toStatusName: status.name,
      createdBy: userId || null,
      createdAt: new Date()
    }]
  });

  return lead;
}

export async function changeLeadStatus({
  lead,
  businessId,
  userId,
  statusId,
  note,
  followUpAt,
  followUpNotes
}) {
  const [allStatuses, nextStatus] = await Promise.all([
    LeadStatus.find({ businessId, isActive: true }).lean(),
    LeadStatus.findOne({ _id: statusId, businessId, isActive: true })
  ]);
  if (!nextStatus) {
    const err = new Error('Status not found');
    err.status = 404;
    throw err;
  }

  const current = allStatuses.find((s) => String(s._id) === String(lead.statusId));
  const allowed = getAllowedStatusTransitions(current, allStatuses);
  if (!allowed.some((s) => String(s._id) === String(nextStatus._id))) {
    const err = new Error(
      isTerminalStatus(current)
        ? 'This lead is closed. You can only move it back to an active funnel status.'
        : 'That status change is not allowed'
    );
    err.status = 400;
    throw err;
  }

  const noteText = String(note || '').trim();
  if (!noteText) {
    const err = new Error('A note is required when changing lead status');
    err.status = 400;
    throw err;
  }

  const leavingFollowUp = !!current?.isFollowUp && !nextStatus.isFollowUp;
  if (leavingFollowUp) {
    closeLeadFollowUps(lead, userId, 'Follow-up closed on status change');
  }

  if (nextStatus.isFollowUp) {
    if (!followUpAt || Number.isNaN(Date.parse(followUpAt))) {
      const err = new Error('Follow-up date is required for this status');
      err.status = 400;
      throw err;
    }
    lead.followUpAt = new Date(followUpAt);
    lead.followUpNotes = String(followUpNotes || noteText).trim();
  }

  const fromName = current?.name || '';
  pushLeadActivity(lead, {
    type: 'STATUS_CHANGE',
    note: noteText,
    fromStatusId: current?._id || null,
    fromStatusName: fromName,
    toStatusId: nextStatus._id,
    toStatusName: nextStatus.name,
    followUpAt: nextStatus.isFollowUp ? lead.followUpAt : null,
    createdBy: userId || null
  });

  if (nextStatus.isFollowUp) {
    pushLeadActivity(lead, {
      type: 'FOLLOW_UP_SET',
      note: lead.followUpNotes || noteText,
      followUpAt: lead.followUpAt,
      toStatusId: nextStatus._id,
      toStatusName: nextStatus.name,
      createdBy: userId || null
    });
  }

  lead.statusId = nextStatus._id;

  // Manual move to Converted also closes follow-ups and stamps conversion time
  if (/^converted$/i.test(String(nextStatus.name || ''))) {
    closeLeadFollowUps(lead, userId, 'Follow-up closed — lead converted');
    lead.convertedAt = lead.convertedAt || new Date();
  }

  await lead.save();
  return lead;
}

/**
 * Find or create Customer (+ optional Car) from lead fields / override body.
 * Only call this when converting to a booking or job — not on lead create / handoff.
 */
export async function ensureCustomerAndCarFromLead(lead, businessId, branchId, overrides = {}) {
  const name = String(overrides.name || lead.name || '').trim();
  const phone = applyDefaultCountryCode(normalizePhone(overrides.phone || lead.phone));
  if (!name || !phone) {
    const err = new Error('Customer name and phone are required');
    err.status = 400;
    throw err;
  }

  let customer = lead.convertedCustomerId
    ? await Customer.findOne({ _id: lead.convertedCustomerId, businessId })
    : null;

  if (!customer) {
    customer = await findCustomerByPhone(businessId, phone, branchId || null);
  }
  if (!customer) {
    customer = await Customer.create({
      businessId,
      branchId: branchId || null,
      name,
      phone,
      whatsappNumber: phone,
      address: String(overrides.location || lead.location || '').trim() || undefined,
      notes: lead.notes || undefined
    });
  }

  const plate = String(overrides.vehicleNumber || lead.vehicleNumber || '').trim().toUpperCase();
  let car = null;
  if (plate) {
    car = await Car.findOne({ businessId, carNumber: plate, customerId: customer._id });
    if (!car) {
      car = await Car.create({
        businessId,
        branchId: branchId || null,
        customerId: customer._id,
        carNumber: plate,
        brand: String(overrides.vehicleBrand || lead.vehicleBrand || '').trim() || undefined,
        model: String(overrides.vehicleModel || lead.vehicleModel || '').trim() || undefined,
        color: String(overrides.vehicleColor || lead.vehicleColor || '').trim() || undefined,
        vehicleType: String(overrides.vehicleType || lead.vehicleType || '').trim() || undefined
      });
    } else {
      let dirty = false;
      const brand = String(overrides.vehicleBrand || '').trim();
      const model = String(overrides.vehicleModel || '').trim();
      const color = String(overrides.vehicleColor || '').trim();
      const vehicleType = String(overrides.vehicleType || '').trim();
      if (brand && car.brand !== brand) { car.brand = brand; dirty = true; }
      if (model && car.model !== model) { car.model = model; dirty = true; }
      if (color && car.color !== color) { car.color = color; dirty = true; }
      if (vehicleType && car.vehicleType !== vehicleType) { car.vehicleType = vehicleType; dirty = true; }
      if (dirty) await car.save();
    }
  }

  lead.convertedCustomerId = customer._id;
  if (overrides.name) lead.name = name;
  if (overrides.phone) lead.phone = phone;
  if (overrides.location != null) lead.location = String(overrides.location).trim();
  if (overrides.vehicleNumber != null) lead.vehicleNumber = plate;
  if (overrides.vehicleBrand != null) lead.vehicleBrand = String(overrides.vehicleBrand).trim();
  if (overrides.vehicleModel != null) lead.vehicleModel = String(overrides.vehicleModel).trim();
  if (overrides.vehicleColor != null) lead.vehicleColor = String(overrides.vehicleColor).trim();
  if (overrides.vehicleType != null) lead.vehicleType = String(overrides.vehicleType).trim();

  return { customer, car };
}

export function parseLeadsCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    const err = new Error('CSV must include a header row and at least one lead');
    err.status = 400;
    throw err;
  }

  const split = (line) => {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = !inQ;
      } else if ((ch === ',' || ch === '\t') && !inQ) {
        cols.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  };

  const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const idx = (aliases) => {
    for (const a of aliases) {
      const i = headers.indexOf(a);
      if (i >= 0) return i;
    }
    return -1;
  };

  const nameI = idx(['name', 'customer_name', 'customer', 'full_name']);
  const phoneI = idx(['phone', 'mobile', 'phone_number', 'mobile_number']);
  const locI = idx(['location', 'address', 'area', 'city']);
  const plateI = idx(['vehicle_number', 'car_number', 'vehicle', 'registration']);
  const brandI = idx(['vehicle_brand', 'brand', 'make']);
  const modelI = idx(['vehicle_model', 'model']);
  const colorI = idx(['vehicle_color', 'color']);
  const notesI = idx(['notes', 'note', 'remark', 'remarks']);
  const sourceI = idx(['source', 'lead_source']);

  if (nameI < 0 || phoneI < 0) {
    const err = new Error('CSV header must include name and phone columns');
    err.status = 400;
    throw err;
  }

  const rows = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = split(lines[r]);
    const name = cols[nameI] || '';
    const phone = cols[phoneI] || '';
    if (!String(name).trim() && !String(phone).trim()) continue;
    rows.push({
      name,
      phone,
      location: locI >= 0 ? cols[locI] : '',
      vehicleNumber: plateI >= 0 ? cols[plateI] : '',
      vehicleBrand: brandI >= 0 ? cols[brandI] : '',
      vehicleModel: modelI >= 0 ? cols[modelI] : '',
      vehicleColor: colorI >= 0 ? cols[colorI] : '',
      notes: notesI >= 0 ? cols[notesI] : '',
      sourceName: sourceI >= 0 ? cols[sourceI] : ''
    });
  }
  return rows;
}
