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

/** Branch-scoped payment / GST fields for invoices & checkout. */
export const PAYMENT_BRANCH_SETTING_KEYS = [
  'upiId',
  'qrCodeImage',
  'paymentMobileNumber',
  'gstNumber',
  'taxPercentage'
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
 * Overlay branch payment/GST onto business settings (branch wins when set).
 * Empty branch values keep the main shop defaults.
 */
export function mergeBranchPaymentIntoSettings(businessSettings, branchSettings) {
  if (!branchSettings) return businessSettings || {};
  const out = { ...(businessSettings || {}) };

  for (const key of ['upiId', 'qrCodeImage', 'paymentMobileNumber', 'gstNumber']) {
    const v = String(branchSettings[key] ?? '').trim();
    if (v) out[key] = v;
  }
  if (branchSettings.taxPercentage != null && branchSettings.taxPercentage !== '') {
    const n = Number(branchSettings.taxPercentage);
    if (Number.isFinite(n)) out.taxPercentage = n;
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

export async function applyBranchPaymentSettings(businessSettings, businessId, branchId) {
  const branchSettings = await loadBranchSettingsForWhatsApp(businessId, branchId);
  return mergeBranchPaymentIntoSettings(businessSettings, branchSettings);
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

/** Sync default-branch payment/GST edits back to BusinessSettings (main shop). */
export async function syncDefaultBranchPaymentToBusiness(businessId, branchId, payload = {}) {
  const branch = await Branch.findOne({ _id: branchId, businessId }).select('isDefault').lean();
  if (!branch?.isDefault) return;

  const update = {};
  for (const key of PAYMENT_BRANCH_SETTING_KEYS) {
    if (payload[key] === undefined) continue;
    if (key === 'taxPercentage') {
      update.taxPercentage =
        payload.taxPercentage != null && payload.taxPercentage !== ''
          ? Number(payload.taxPercentage)
          : null;
    } else {
      update[key] = String(payload[key] || '').trim() || null;
    }
  }
  if (!Object.keys(update).length) return;
  await BusinessSettings.findOneAndUpdate(
    { businessId },
    { $set: update },
    { upsert: false }
  );
}

/** Keep default BranchSettings payment fields aligned when main Settings are saved. */
export async function syncBusinessPaymentToDefaultBranch(businessId, payload = {}) {
  const defaultBranch = await Branch.findOne({ businessId, isDefault: true }).select('_id').lean();
  if (!defaultBranch) return;

  const update = {};
  for (const key of PAYMENT_BRANCH_SETTING_KEYS) {
    if (payload[key] === undefined) continue;
    if (key === 'taxPercentage') {
      update.taxPercentage =
        payload.taxPercentage != null && payload.taxPercentage !== ''
          ? Number(payload.taxPercentage)
          : null;
    } else {
      update[key] = String(payload[key] || '').trim() || null;
    }
  }
  if (!Object.keys(update).length) return;
  await BranchSettings.findOneAndUpdate(
    { businessId, branchId: defaultBranch._id },
    { $set: update },
    { upsert: true, setDefaultsOnInsert: true }
  );
}
