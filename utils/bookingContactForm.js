import crypto from 'node:crypto';

export const BOOKING_CONTACT_FIELD_TYPES = [
  'text',
  'tel',
  'email',
  'textarea',
  'number',
  'date',
  'time',
  'datetime',
  'select',
  'chips'
];

/** Built-in keys mapped onto Booking / Customer documents. */
export const BOOKING_CONTACT_SYSTEM_KEYS = new Set([
  'customerName',
  'customerPhone',
  'customerEmail',
  'vehicleNumber',
  'vehicleBrand',
  'vehicleModel',
  'vehicleType',
  'deliveryMethod',
  'pickupAddress',
  'pickupLandmark',
  'pickupNotes',
  'notes'
]);

const VEHICLE_TYPE_OPTIONS = ['Hatchback', 'Sedan', 'SUV', 'MUV', 'Luxury', 'Bike', 'Other'];
const DELIVERY_OPTIONS = [
  { value: 'SELF_VISIT', label: 'Self visit' },
  { value: 'PICKUP_DROP', label: 'Pickup & drop' }
];

export function defaultBookingContactFormFields() {
  return [
    {
      id: 'fld_customerName',
      key: 'customerName',
      label: 'Full name',
      type: 'text',
      required: true,
      placeholder: 'Your name',
      options: [],
      locked: true,
      section: 'contact'
    },
    {
      id: 'fld_customerPhone',
      key: 'customerPhone',
      label: 'Mobile number',
      type: 'tel',
      required: true,
      placeholder: 'Mobile number',
      options: [],
      locked: true,
      section: 'contact'
    },
    {
      id: 'fld_vehicleNumber',
      key: 'vehicleNumber',
      label: 'Vehicle number',
      type: 'text',
      required: false,
      placeholder: 'e.g. KA 01 AB 1234',
      options: [],
      locked: false,
      section: 'vehicle'
    },
    {
      id: 'fld_vehicleBrand',
      key: 'vehicleBrand',
      label: 'Brand',
      type: 'text',
      required: false,
      placeholder: 'Maruti, Hyundai…',
      options: [],
      locked: false,
      section: 'vehicle'
    },
    {
      id: 'fld_vehicleModel',
      key: 'vehicleModel',
      label: 'Model',
      type: 'text',
      required: false,
      placeholder: 'Swift, Creta…',
      options: [],
      locked: false,
      section: 'vehicle'
    },
    {
      id: 'fld_vehicleType',
      key: 'vehicleType',
      label: 'Vehicle type',
      type: 'chips',
      required: false,
      placeholder: '',
      options: [...VEHICLE_TYPE_OPTIONS],
      locked: false,
      section: 'vehicle'
    },
    {
      id: 'fld_deliveryMethod',
      key: 'deliveryMethod',
      label: 'How will you visit?',
      type: 'chips',
      required: true,
      placeholder: '',
      options: DELIVERY_OPTIONS.map((o) => o.value),
      optionLabels: Object.fromEntries(DELIVERY_OPTIONS.map((o) => [o.value, o.label])),
      locked: false,
      section: 'visit'
    },
    {
      id: 'fld_pickupAddress',
      key: 'pickupAddress',
      label: 'Full address',
      type: 'textarea',
      required: false,
      placeholder: 'House no., street, area',
      options: [],
      locked: false,
      section: 'visit',
      showWhen: { key: 'deliveryMethod', equals: 'PICKUP_DROP' }
    },
    {
      id: 'fld_pickupLandmark',
      key: 'pickupLandmark',
      label: 'Landmark',
      type: 'text',
      required: false,
      placeholder: 'Near metro, mall, etc.',
      options: [],
      locked: false,
      section: 'visit',
      showWhen: { key: 'deliveryMethod', equals: 'PICKUP_DROP' }
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

function normalizeShowWhen(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const key = String(raw.key || '').trim();
  const equals = String(raw.equals ?? '').trim();
  if (!key || !equals) return undefined;
  return { key, equals };
}

export function normalizeBookingContactFormFields(input) {
  const defaults = defaultBookingContactFormFields();
  const defaultByKey = new Map(defaults.map((f) => [f.key, f]));
  const source = Array.isArray(input) && input.length ? input : defaults;

  const seenKeys = new Set();
  const fields = [];

  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    let key = String(raw.key || '').trim();
    if (!key && raw.label) key = `custom_${slugifyKey(raw.label)}`;
    if (!key) continue;
    if (!BOOKING_CONTACT_SYSTEM_KEYS.has(key) && !key.startsWith('custom_')) {
      key = `custom_${slugifyKey(key)}`;
    }
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const def = defaultByKey.get(key);
    const type = BOOKING_CONTACT_FIELD_TYPES.includes(raw.type) ? raw.type : (def?.type || 'text');
    const locked = key === 'customerName' || key === 'customerPhone' || raw.locked === true || def?.locked === true;
    const options = Array.isArray(raw.options)
      ? raw.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 40)
      : (def?.options || []);
    const optionLabels =
      raw.optionLabels && typeof raw.optionLabels === 'object' && !Array.isArray(raw.optionLabels)
        ? Object.fromEntries(
          Object.entries(raw.optionLabels)
            .map(([k, v]) => [String(k), String(v)])
            .filter(([k, v]) => k && v)
        )
        : (def?.optionLabels || undefined);

    const field = {
      id: String(raw.id || def?.id || newFieldId()),
      key,
      label: String(raw.label || def?.label || key).trim().slice(0, 80) || key,
      type,
      required: locked ? true : !!raw.required,
      placeholder: String(raw.placeholder ?? def?.placeholder ?? '').slice(0, 120),
      options,
      locked,
      section: ['contact', 'vehicle', 'visit', 'other'].includes(raw.section)
        ? raw.section
        : (def?.section || 'other')
    };
    if (optionLabels && Object.keys(optionLabels).length) field.optionLabels = optionLabels;
    const showWhen = normalizeShowWhen(raw.showWhen) || def?.showWhen;
    if (showWhen) field.showWhen = showWhen;
    fields.push(field);
  }

  // Always ensure locked system fields exist
  for (const must of defaults.filter((d) => d.locked)) {
    if (!seenKeys.has(must.key)) {
      fields.unshift({ ...must });
      seenKeys.add(must.key);
    }
  }

  return fields.slice(0, 40);
}

export function isContactFieldVisible(field, answers = {}) {
  if (!field?.showWhen?.key) return true;
  return String(answers[field.showWhen.key] ?? '') === String(field.showWhen.equals);
}

/**
 * Validate answers against template. Throws Error with status 400.
 * Returns { mapped, contactAnswers } for booking create.
 */
export function validateBookingContactAnswers(fieldsInput, answersInput = {}) {
  const fields = normalizeBookingContactFormFields(fieldsInput);
  const answers = answersInput && typeof answersInput === 'object' ? answersInput : {};
  const mapped = {};
  const contactAnswers = {};

  for (const field of fields) {
    if (!isContactFieldVisible(field, answers)) continue;
    const raw = answers[field.key];
    const value = raw == null ? '' : String(raw).trim();

    let required = !!field.required;
    // Pickup address is mandatory when pickup is selected, even if not marked required
    if (
      field.key === 'pickupAddress' &&
      String(answers.deliveryMethod || mapped.deliveryMethod || '') === 'PICKUP_DROP'
    ) {
      required = true;
    }

    if (required && !value) {
      const err = new Error(`${field.label || field.key} is required`);
      err.status = 400;
      throw err;
    }

    if (!value) continue;

    if (field.type === 'email' && value && !/^\S+@\S+\.\S+$/.test(value)) {
      const err = new Error(`Enter a valid email for ${field.label || field.key}`);
      err.status = 400;
      throw err;
    }

    if (field.type === 'date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const err = new Error(`Enter a valid date for ${field.label || field.key}`);
      err.status = 400;
      throw err;
    }

    if (field.type === 'time' && value && !/^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
      const err = new Error(`Enter a valid time for ${field.label || field.key}`);
      err.status = 400;
      throw err;
    }

    if (
      field.type === 'datetime' &&
      value &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)
    ) {
      const err = new Error(`Enter a valid date & time for ${field.label || field.key}`);
      err.status = 400;
      throw err;
    }

    if (BOOKING_CONTACT_SYSTEM_KEYS.has(field.key)) {
      mapped[field.key] = value;
    } else {
      contactAnswers[field.key] = value;
    }
  }

  if (!String(mapped.customerName || '').trim() || !String(mapped.customerPhone || '').trim()) {
    const err = new Error('Customer name and phone are required');
    err.status = 400;
    throw err;
  }

  if (!mapped.deliveryMethod) mapped.deliveryMethod = 'SELF_VISIT';
  if (mapped.deliveryMethod !== 'PICKUP_DROP') {
    mapped.deliveryMethod = 'SELF_VISIT';
    delete mapped.pickupAddress;
    delete mapped.pickupLandmark;
    delete mapped.pickupNotes;
  }

  return { mapped, contactAnswers, fields };
}
