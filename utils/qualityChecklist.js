/**
 * Quality checklist helpers (Option A: checklist defined on each Service).
 * Additive: when qualityCheckEnabled is off, or a service has no items, existing COMPLETED flow is unchanged.
 */

import mongoose from 'mongoose';

export const QUALITY_CHECK_EPS = 0;

/** Normalize checklist payload from create/update service body. */
export function normalizeServiceQualityChecklist(raw) {
  if (raw == null) {
    return { name: '', items: [] };
  }
  const name = String(raw.name || raw.title || '').trim().slice(0, 120);
  const itemsIn = Array.isArray(raw.items) ? raw.items : [];
  const items = [];
  const seen = new Set();
  for (const row of itemsIn) {
    const label = String(row?.label ?? row?.name ?? '').trim().slice(0, 200);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { label };
    if (row?._id && mongoose.isValidObjectId(String(row._id))) {
      entry._id = new mongoose.Types.ObjectId(String(row._id));
    }
    items.push(entry);
    if (items.length >= 50) break;
  }
  return { name, items };
}

export function serviceHasQualityChecklist(service) {
  return Array.isArray(service?.qualityChecklist?.items) && service.qualityChecklist.items.length > 0;
}

/**
 * Build required checklist groups for a job from its services + catalog docs.
 * @returns {{ required: boolean, groups: Array }}
 */
export function buildJobQualityChecklistGroups(job, serviceDocsById) {
  const groups = [];
  for (const line of job?.services || []) {
    const sid = String(line.serviceId?._id || line.serviceId || '');
    if (!sid) continue;
    const svc = serviceDocsById.get(sid) || (line.serviceId && typeof line.serviceId === 'object' ? line.serviceId : null);
    if (!svc || !serviceHasQualityChecklist(svc)) continue;
    // Direct-sale / product lines skip wash workflow — no QC at Mark Completed
    if (svc.skipWorkProcess) continue;
    const serviceName =
      (line.customName && String(line.customName).trim()) ||
      svc.name ||
      line.serviceId?.name ||
      'Service';
    const checklistName = String(svc.qualityChecklist?.name || '').trim() || 'Quality checklist';
    groups.push({
      serviceId: sid,
      serviceName,
      checklistName,
      items: (svc.qualityChecklist.items || []).map((it) => ({
        id: String(it._id),
        label: it.label,
      })),
    });
  }
  return {
    required: groups.length > 0,
    groups,
  };
}

/**
 * Validate submitted qualityChecks against required groups.
 * @returns {{ ok: true, snapshot: Array } | { ok: false, message: string }}
 */
export function validateAndSnapshotQualityChecks(groups, qualityChecksBody) {
  if (!groups?.length) {
    return { ok: true, snapshot: [] };
  }
  const submitted = Array.isArray(qualityChecksBody) ? qualityChecksBody : null;
  if (!submitted) {
    return {
      ok: false,
      message: 'Complete the quality checklist for all services before marking this job completed',
    };
  }

  const byService = new Map();
  for (const row of submitted) {
    const sid = String(row?.serviceId || '');
    if (!sid) continue;
    byService.set(sid, row);
  }

  const snapshot = [];
  for (const group of groups) {
    const row = byService.get(String(group.serviceId));
    if (!row) {
      return {
        ok: false,
        message: `Quality checklist incomplete for ${group.serviceName}`,
      };
    }
    const checkedMap = new Map();
    for (const it of row.items || []) {
      checkedMap.set(String(it.itemId || it.id || ''), !!it.checked);
    }
    const snapItems = [];
    for (const item of group.items) {
      if (!checkedMap.get(String(item.id))) {
        return {
          ok: false,
          message: `Please check all items for ${group.serviceName} before completing`,
        };
      }
      snapItems.push({
        itemId: item.id,
        label: item.label,
        checked: true,
      });
    }
    snapshot.push({
      serviceId: group.serviceId,
      serviceName: group.serviceName,
      checklistName: group.checklistName,
      items: snapItems,
    });
  }

  return { ok: true, snapshot };
}
