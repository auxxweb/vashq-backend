import crypto from 'node:crypto';
import Job from '../models/Job.model.js';
import { escapeRegex } from './searchUtils.js';

export const JOB_FORM_FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select'];

export const JOB_FORM_LOCKED_KEYS = new Set(['customer', 'vehicle', 'services']);

export const JOB_FORM_LOCKED_SUBKEYS = new Set([
  'customerName',
  'customerPhone'
]);

export const JOB_FORM_SYSTEM_KEYS = new Set([
  'customer',
  'vehicle',
  'assignment',
  'services',
  'advance',
  'estimatedDelivery',
  'photos',
  'notes'
]);

export function defaultJobFormSubFields(sectionKey) {
  switch (sectionKey) {
    case 'customer':
      return [
        { key: 'customerName', label: 'Name', required: true, locked: true, hidden: false, placeholder: '' },
        { key: 'customerPhone', label: 'Mobile number', required: true, locked: true, hidden: false, placeholder: '' }
      ];
    case 'vehicle':
      return [
        { key: 'vehicleNumber', label: 'Vehicle number', required: true, locked: false, hidden: false, placeholder: '' },
        { key: 'vehicleBrand', label: 'Brand', required: false, locked: false, hidden: false, placeholder: '' },
        { key: 'vehicleModel', label: 'Model', required: false, locked: false, hidden: false, placeholder: '' },
        { key: 'vehicleColor', label: 'Color', required: false, locked: false, hidden: false, placeholder: '' }
      ];
    case 'assignment':
      return [
        { key: 'assignees', label: 'Assigned to', required: false, locked: false, hidden: false, placeholder: '' }
      ];
    case 'advance':
      return [
        { key: 'advanceAmount', label: 'Advance payment', required: false, locked: false, hidden: false, placeholder: '' }
      ];
    case 'estimatedDelivery':
      return [
        { key: 'eta', label: 'Date and time', required: false, locked: false, hidden: false, placeholder: '' }
      ];
    case 'notes':
      return [
        { key: 'notesText', label: 'Notes', required: false, locked: false, hidden: false, placeholder: 'Optional notes' }
      ];
    default:
      return [];
  }
}

function cloneSubFields(list) {
  return (list || []).map((f) => ({ ...f }));
}

export function normalizeJobFormSubFields(sectionKey, input) {
  const defaults = defaultJobFormSubFields(sectionKey);
  if (!defaults.length) return [];
  const defaultByKey = new Map(defaults.map((f) => [f.key, f]));
  const source = Array.isArray(input) && input.length ? input : defaults;
  const seen = new Set();
  const fields = [];
  for (const raw of source) {
    const key = String(raw?.key || '');
    if (!defaultByKey.has(key) || seen.has(key)) continue;
    seen.add(key);
    const def = defaultByKey.get(key);
    const locked = JOB_FORM_LOCKED_SUBKEYS.has(key) || !!def.locked;
    fields.push({
      key,
      label: String(raw.label || def.label || key).trim().slice(0, 80) || def.label,
      required: locked ? true : !!raw.required,
      locked,
      hidden: locked ? false : raw.hidden === true,
      placeholder: String(raw.placeholder ?? def.placeholder ?? '').slice(0, 120)
    });
  }
  for (const d of defaults) {
    if (!seen.has(d.key)) fields.push({ ...d });
  }
  return fields;
}

export function defaultJobFormFields() {
  return [
    {
      id: 'fld_customer',
      key: 'customer',
      label: 'Customer',
      type: 'text',
      required: true,
      placeholder: '',
      options: [],
      locked: true,
      hidden: false,
      subFields: defaultJobFormSubFields('customer')
    },
    {
      id: 'fld_vehicle',
      key: 'vehicle',
      label: 'Vehicle',
      type: 'text',
      required: true,
      placeholder: '',
      options: [],
      locked: true,
      hidden: false,
      subFields: defaultJobFormSubFields('vehicle')
    },
    {
      id: 'fld_assignment',
      key: 'assignment',
      label: 'Assignment',
      type: 'text',
      required: false,
      placeholder: '',
      options: [],
      locked: false,
      hidden: false,
      subFields: defaultJobFormSubFields('assignment')
    },
    {
      id: 'fld_services',
      key: 'services',
      label: 'Services',
      type: 'text',
      required: true,
      placeholder: '',
      options: [],
      locked: true,
      hidden: false,
      subFields: []
    },
    {
      id: 'fld_advance',
      key: 'advance',
      label: 'Advance payment',
      type: 'number',
      required: false,
      placeholder: '',
      options: [],
      locked: false,
      hidden: false,
      subFields: defaultJobFormSubFields('advance')
    },
    {
      id: 'fld_estimatedDelivery',
      key: 'estimatedDelivery',
      label: 'Estimated delivery',
      type: 'datetime',
      required: false,
      placeholder: '',
      options: [],
      locked: false,
      hidden: false,
      subFields: defaultJobFormSubFields('estimatedDelivery')
    },
    {
      id: 'fld_photos',
      key: 'photos',
      label: 'Before photos',
      type: 'text',
      required: true,
      placeholder: '',
      options: [],
      locked: false,
      hidden: false,
      subFields: []
    },
    {
      id: 'fld_notes',
      key: 'notes',
      label: 'Notes',
      type: 'textarea',
      required: false,
      placeholder: 'Optional notes',
      options: [],
      locked: false,
      hidden: true,
      subFields: defaultJobFormSubFields('notes')
    }
  ];
}

function slugifyKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function newFieldId() {
  return `fld_${crypto.randomBytes(6).toString('hex')}`;
}

export function isCustomJobFormKey(key) {
  return String(key || '').startsWith('custom_');
}

export function isJobFormFieldVisible(field) {
  return !!field && field.hidden !== true;
}

/**
 * Normalize owner-saved job form fields. Always re-injects locked system fields.
 * Empty input → defaults (for the editor). Callers that want “no custom layout”
 * should check the raw array length before normalizing.
 */
export function normalizeJobFormFields(input) {
  const defaults = defaultJobFormFields();
  const defaultByKey = new Map(defaults.map((f) => [f.key, f]));
  const source = Array.isArray(input) && input.length ? input : defaults;

  const seenKeys = new Set();
  const fields = [];

  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    let key = String(raw.key || '').trim();
    if (!key && raw.label) key = `custom_${slugifyKey(raw.label)}`;
    if (!key) continue;
    if (!JOB_FORM_SYSTEM_KEYS.has(key) && !key.startsWith('custom_')) {
      key = `custom_${slugifyKey(key)}`;
    }
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const def = defaultByKey.get(key);
    const locked = JOB_FORM_LOCKED_KEYS.has(key) || def?.locked === true;
    const allowedTypes = [...JOB_FORM_FIELD_TYPES, 'datetime'];
    const type = allowedTypes.includes(raw.type)
      ? raw.type
      : (def?.type || 'text');
    const options = Array.isArray(raw.options)
      ? raw.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 40)
      : (def?.options || []);

    fields.push({
      id: String(raw.id || def?.id || newFieldId()),
      key,
      label: String(raw.label || def?.label || key).trim().slice(0, 80) || key,
      type,
      required: locked ? true : !!raw.required,
      unique: !locked && isCustomJobFormKey(key) ? raw.unique === true : false,
      placeholder: String(raw.placeholder ?? def?.placeholder ?? '').slice(0, 120),
      options,
      locked,
      hidden: locked ? false : raw.hidden === true,
      subFields: normalizeJobFormSubFields(key, raw.subFields ?? def?.subFields)
    });
  }

  const missingLocked = defaults.filter((d) => d.locked && !seenKeys.has(d.key));
  if (missingLocked.length) {
    fields.unshift(...missingLocked.map((d) => ({
      ...d,
      options: [...(d.options || [])],
      subFields: cloneSubFields(d.subFields)
    })));
  }

  return fields.slice(0, 40);
}

export function formAnswersObject(raw) {
  if (!raw) return {};
  if (raw instanceof Map) return Object.fromEntries(raw.entries());
  if (typeof raw.toObject === 'function') {
    try {
      return formAnswersObject(raw.toObject());
    } catch {
      /* fall through */
    }
  }
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      raw
        .filter((row) => Array.isArray(row) && row[0])
        .map(([k, v]) => [String(k), v == null ? '' : String(v)])
    );
  }
  if (typeof raw === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('$') || k === '_id') continue;
      out[k] = v == null ? '' : (typeof v === 'object' ? String(v.value ?? v) : String(v));
    }
    return out;
  }
  return {};
}

export function formAnswersSearchText(raw) {
  return Object.values(formAnswersObject(raw))
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 2000);
}

/** Match any custom form-answer value stored on the job (Map / object). */
export function formAnswersSearchClause(escapedTerm) {
  const term = String(escapedTerm || '').trim();
  if (!term) return null;
  return {
    $expr: {
      $gt: [
        {
          $size: {
            $filter: {
              input: { $objectToArray: { $ifNull: ['$formAnswers', {}] } },
              as: 'kv',
              cond: {
                $regexMatch: {
                  input: { $toString: { $ifNull: ['$$kv.v', ''] } },
                  regex: term,
                  options: 'i'
                }
              }
            }
          }
        },
        0
      ]
    }
  };
}

/**
 * Validate custom field answers. Throws Error with status 400.
 * System sections are validated by existing job-create logic.
 */
export function validateJobFormAnswers(fieldsInput, answersInput = {}) {
  const fields = normalizeJobFormFields(fieldsInput);
  const answers = answersInput && typeof answersInput === 'object' && !Array.isArray(answersInput)
    ? answersInput
    : {};
  const formAnswers = {};

  for (const field of fields) {
    if (!isCustomJobFormKey(field.key)) continue;
    if (!isJobFormFieldVisible(field)) continue;
    const raw = answers[field.key];
    const value = raw == null ? '' : String(raw).trim();
    if (field.required && !value) {
      const err = new Error(`${field.label || field.key} is required`);
      err.status = 400;
      throw err;
    }
    if (field.type === 'select' && value) {
      const opts = (field.options || []).map((o) => String(o));
      if (opts.length && !opts.includes(value)) {
        const err = new Error(`Invalid value for ${field.label || field.key}`);
        err.status = 400;
        throw err;
      }
    }
    if (value) formAnswers[field.key] = value.slice(0, 500);
  }

  return formAnswers;
}

/**
 * Reject values that already exist on another non-cancelled job for unique custom fields.
 */
export async function assertUniqueJobFormAnswers({
  businessId,
  fieldsInput,
  answers = {},
  excludeJobId = null
}) {
  const fields = normalizeJobFormFields(fieldsInput);
  const uniqueFields = fields.filter(
    (field) => isCustomJobFormKey(field.key) && isJobFormFieldVisible(field) && field.unique
  );
  if (!uniqueFields.length) return;

  for (const field of uniqueFields) {
    const value = String(answers[field.key] ?? '').trim();
    if (!value) continue;
    const filter = {
      businessId,
      status: { $ne: 'CANCELLED' },
      [`formAnswers.${field.key}`]: { $regex: `^${escapeRegex(value)}$`, $options: 'i' }
    };
    if (excludeJobId) filter._id = { $ne: excludeJobId };
    const existing = await Job.findOne(filter).select('tokenNumber').lean();
    if (existing) {
      const token = existing.tokenNumber ? ` on job ${existing.tokenNumber}` : '';
      const err = new Error(`${field.label || field.key} “${value}” is already used${token}`);
      err.status = 400;
      throw err;
    }
  }
}
