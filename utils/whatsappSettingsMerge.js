import Branch from '../models/Branch.model.js';
import BranchSettings from '../models/BranchSettings.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import { normalizeWhatsappTemplates } from './whatsappTemplates.js';

/** Branch-scoped fields used for job/invoice WhatsApp actions. */
export const WHATSAPP_BRANCH_SETTING_KEYS = [
  'shopWhatsappNumber',
  'googleReviewLink',
  'whatsappTemplates'
];

/**
 * Overlay branch WhatsApp settings onto business settings (branch wins when set).
 */
export function mergeBranchWhatsAppIntoSettings(businessSettings, branchSettings) {
  if (!branchSettings) return businessSettings || {};
  const out = { ...(businessSettings || {}) };

  const shop = String(branchSettings.shopWhatsappNumber || '').trim();
  if (shop) out.shopWhatsappNumber = shop;

  const review = String(branchSettings.googleReviewLink || '').trim();
  if (review) out.googleReviewLink = review;

  if (branchSettings.whatsappTemplates && typeof branchSettings.whatsappTemplates === 'object') {
    out.whatsappTemplates = normalizeWhatsappTemplates({
      ...(businessSettings?.whatsappTemplates || {}),
      ...branchSettings.whatsappTemplates
    });
  }

  return out;
}

/**
 * Resolve which branch's WhatsApp settings to apply.
 * Priority: explicit query param → request branch context → default branch.
 */
export async function resolveWhatsAppBranchId(businessId, { queryBranchId, requestBranchId } = {}) {
  if (queryBranchId) return queryBranchId;
  if (requestBranchId) return requestBranchId;

  const defaultBranch = await Branch.findOne({ businessId, isDefault: true }).select('_id').lean();
  return defaultBranch?._id || null;
}

export async function loadBranchSettingsForWhatsApp(businessId, branchId) {
  if (!branchId) return null;
  return BranchSettings.findOne({ businessId, branchId }).lean();
}

export async function applyBranchWhatsAppSettings(businessSettings, businessId, branchId) {
  const branchSettings = await loadBranchSettingsForWhatsApp(businessId, branchId);
  return mergeBranchWhatsAppIntoSettings(businessSettings, branchSettings);
}

/**
 * Keep business-level settings in sync when the default branch WhatsApp config changes.
 * Ensures legacy callers of GET /admin/settings without branchId still work.
 */
export async function syncDefaultBranchWhatsAppToBusiness(businessId, branchId, payload = {}) {
  const branch = await Branch.findOne({ _id: branchId, businessId }).select('isDefault').lean();
  if (!branch?.isDefault) return;

  const update = {};
  if (payload.shopWhatsappNumber !== undefined) {
    update.shopWhatsappNumber = String(payload.shopWhatsappNumber || '').trim() || null;
  }
  if (payload.googleReviewLink !== undefined) {
    update.googleReviewLink = String(payload.googleReviewLink || '').trim() || null;
  }
  if (payload.whatsappTemplates !== undefined) {
    const existing = await BusinessSettings.findOne({ businessId }).select('whatsappTemplates').lean();
    update.whatsappTemplates = normalizeWhatsappTemplates({
      ...(existing?.whatsappTemplates || {}),
      ...(payload.whatsappTemplates || {})
    });
  }

  if (!Object.keys(update).length) return;
  await BusinessSettings.findOneAndUpdate(
    { businessId },
    { $set: update },
    { upsert: false }
  );
}
