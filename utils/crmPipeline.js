import LeadStatus from '../models/LeadStatus.model.js';
import LeadSource from '../models/LeadSource.model.js';

export function isTerminalStatus(status) {
  if (!status) return false;
  return status.isTerminal === true || Number(status.sortOrder) === 0;
}

/**
 * Statuses allowed when changing from `current`.
 * - Terminal current → only non-terminal (revive).
 * - Otherwise → all other active statuses, sorted by funnel order (incl. terminal).
 */
export function getAllowedStatusTransitions(currentStatus, allStatuses = []) {
  const list = (allStatuses || [])
    .filter((s) => s && s.isActive !== false)
    .sort((a, b) => {
      const ao = Number(a.sortOrder) || 0;
      const bo = Number(b.sortOrder) || 0;
      if (ao !== bo) return ao - bo;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

  if (!currentStatus) {
    return list.filter((s) => !isTerminalStatus(s));
  }

  const currentId = String(currentStatus._id || currentStatus);

  if (isTerminalStatus(currentStatus)) {
    return list.filter((s) => !isTerminalStatus(s) && String(s._id) !== currentId);
  }

  return list.filter((s) => String(s._id) !== currentId);
}

/** Non-terminal statuses in funnel order for timeline bar. */
export function getFunnelTimelineStatuses(allStatuses = []) {
  return (allStatuses || [])
    .filter((s) => s && s.isActive !== false && !isTerminalStatus(s))
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
}

const DEFAULT_STATUSES = [
  { name: 'Invalid number', sortOrder: 0, color: '#ef4444', isTerminal: true, isFollowUp: false },
  { name: 'Untouched', sortOrder: 1, color: '#94a3b8', isTerminal: false, isFollowUp: false },
  { name: 'Fresh lead', sortOrder: 2, color: '#3b82f6', isTerminal: false, isFollowUp: false },
  { name: 'Contacted', sortOrder: 3, color: '#8b5cf6', isTerminal: false, isFollowUp: false },
  { name: 'Follow-up', sortOrder: 4, color: '#f59e0b', isTerminal: false, isFollowUp: true },
  { name: 'Interested', sortOrder: 5, color: '#10b981', isTerminal: false, isFollowUp: false },
  { name: 'Converted', sortOrder: 6, color: '#059669', isTerminal: true, isFollowUp: false }
];

const DEFAULT_SOURCES = [
  'Walk-in',
  'Phone call',
  'WhatsApp',
  'Referral',
  'Online / Website',
  'Social media',
  'Other'
];

const crmDefaultsReady = new Set();

export async function ensureCrmDefaults(businessId) {
  const key = String(businessId || '');
  if (key && crmDefaultsReady.has(key)) {
    return {};
  }

  const existingStatuses = await LeadStatus.countDocuments({ businessId });
  if (existingStatuses === 0) {
    await LeadStatus.insertMany(
      DEFAULT_STATUSES.map((s) => ({
        businessId,
        ...s,
        isSystem: true,
        isActive: true
      }))
    );
  } else {
    // Keep Converted as a closed funnel outcome (terminal, no follow-up)
    await LeadStatus.updateMany(
      { businessId, name: /^converted$/i },
      { $set: { isTerminal: true, isFollowUp: false } }
    );
  }

  const existingSources = await LeadSource.countDocuments({ businessId });
  if (existingSources === 0) {
    await LeadSource.insertMany(
      DEFAULT_SOURCES.map((name) => ({
        businessId,
        name,
        isSystem: true,
        isActive: true
      }))
    );
  }

  const defaultStatus = await LeadStatus.findOne({
    businessId,
    isActive: true,
    sortOrder: { $gt: 0 }
  }).sort({ sortOrder: 1 }).lean();

  if (key) crmDefaultsReady.add(key);
  return { defaultStatus };
}

export async function getDefaultLeadStatus(businessId) {
  await ensureCrmDefaults(businessId);
  return LeadStatus.findOne({
    businessId,
    isActive: true,
    $or: [{ isTerminal: false }, { isTerminal: { $exists: false } }],
    sortOrder: { $gt: 0 }
  }).sort({ sortOrder: 1 });
}
