import { DateTime } from 'luxon';
import NumberSequence from '../models/NumberSequence.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';

export const DEFAULT_JOB_TOKEN_SETTINGS = {
  prefix: '',
  datePart: 'NONE',
  sequenceScope: 'DAILY',
  padLength: 3,
  separator: '-'
};

export const DEFAULT_INVOICE_NUMBER_SETTINGS = {
  prefix: 'INV',
  datePart: 'NONE',
  sequenceScope: 'GLOBAL',
  padLength: 4,
  separator: '-'
};

export function sanitizeNumberPrefix(raw, { maxLen = 10, fallback = '' } = {}) {
  const cleaned = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, maxLen);
  return cleaned || fallback;
}

export function sanitizeSeparator(raw, fallback = '-') {
  const s = String(raw ?? fallback).slice(0, 2);
  if (!s || /[A-Za-z0-9]/.test(s)) return fallback;
  return s;
}

export function clampPadLength(n, { min = 1, max = 8, fallback = 3 } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function normalizeJobTokenSettings(raw = {}) {
  return {
    prefix: sanitizeNumberPrefix(raw.prefix, { maxLen: 10, fallback: '' }),
    datePart: ['NONE', 'DDMM', 'YYYYMMDD'].includes(raw.datePart) ? raw.datePart : 'NONE',
    sequenceScope: ['DAILY', 'MONTHLY', 'GLOBAL'].includes(raw.sequenceScope)
      ? raw.sequenceScope
      : 'DAILY',
    padLength: clampPadLength(raw.padLength, { min: 1, max: 6, fallback: 3 }),
    separator: sanitizeSeparator(raw.separator, '-')
  };
}

export function normalizeInvoiceNumberSettings(raw = {}) {
  return {
    prefix: sanitizeNumberPrefix(raw.prefix, { maxLen: 10, fallback: 'INV' }),
    datePart: ['NONE', 'DDMM', 'YYYYMMDD'].includes(raw.datePart) ? raw.datePart : 'NONE',
    sequenceScope: ['DAILY', 'MONTHLY', 'GLOBAL'].includes(raw.sequenceScope)
      ? raw.sequenceScope
      : 'GLOBAL',
    padLength: clampPadLength(raw.padLength, { min: 1, max: 8, fallback: 4 }),
    separator: sanitizeSeparator(raw.separator, '-')
  };
}

function nowInTimezone(timezone) {
  const tz = timezone || 'Asia/Kolkata';
  const dt = DateTime.now().setZone(tz);
  return dt.isValid ? dt : DateTime.now().setZone('Asia/Kolkata');
}

export function buildScopeKey(sequenceScope, timezone) {
  const dt = nowInTimezone(timezone);
  if (sequenceScope === 'DAILY') return dt.toFormat('yyyy-MM-dd');
  if (sequenceScope === 'MONTHLY') return dt.toFormat('yyyy-MM');
  return 'GLOBAL';
}

export function buildDatePart(datePart, timezone) {
  if (!datePart || datePart === 'NONE') return '';
  const dt = nowInTimezone(timezone);
  if (datePart === 'DDMM') return dt.toFormat('ddMM');
  if (datePart === 'YYYYMMDD') return dt.toFormat('yyyyMMdd');
  return '';
}

export function formatSequentialNumber(cfg, sequenceValue, timezone) {
  const parts = [];
  if (cfg.prefix) parts.push(cfg.prefix);
  const dateStr = buildDatePart(cfg.datePart, timezone);
  if (dateStr) parts.push(dateStr);
  const pad = clampPadLength(cfg.padLength, { min: 1, max: 8, fallback: 3 });
  const seq = String(Math.max(1, Number(sequenceValue) || 1)).padStart(pad, '0');
  parts.push(seq);
  const sep = sanitizeSeparator(cfg.separator, '-');
  return parts.join(sep);
}

/** Preview helper for Settings UI (no DB). */
export function previewSequentialNumber(cfg, { sequenceValue = 1, timezone = 'Asia/Kolkata' } = {}) {
  return formatSequentialNumber(cfg, sequenceValue, timezone);
}

/**
 * Atomically allocate the next sequence value for a business(+branch) scope.
 */
export async function nextSequenceValue({
  businessId,
  branchId = null,
  kind,
  scopeKey
}) {
  const doc = await NumberSequence.findOneAndUpdate(
    {
      businessId,
      branchId: branchId || null,
      kind,
      scopeKey: String(scopeKey || 'GLOBAL')
    },
    { $inc: { nextValue: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return Math.max(1, Number(doc?.nextValue) || 1);
}

export async function loadNumberingSettings(businessId) {
  const settings = await BusinessSettings.findOne({ businessId })
    .select('timezone customJobTokenEnabled jobTokenSettings customInvoiceNumberEnabled invoiceNumberSettings')
    .lean();
  return {
    timezone: settings?.timezone || 'Asia/Kolkata',
    customJobTokenEnabled: settings?.customJobTokenEnabled === true,
    jobTokenSettings: normalizeJobTokenSettings(
      settings?.jobTokenSettings || DEFAULT_JOB_TOKEN_SETTINGS
    ),
    customInvoiceNumberEnabled: settings?.customInvoiceNumberEnabled === true,
    invoiceNumberSettings: normalizeInvoiceNumberSettings(
      settings?.invoiceNumberSettings || DEFAULT_INVOICE_NUMBER_SETTINGS
    )
  };
}
