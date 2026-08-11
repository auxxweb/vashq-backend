export const PACKAGE_VALIDITY_UNITS = ['days', 'weeks', 'months', 'years'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AVG_DAYS_PER_MONTH = 30.436875;
const AVG_DAYS_PER_YEAR = 365.25;

export function normalizePackageValidity(value, unit) {
  const validityUnit = PACKAGE_VALIDITY_UNITS.includes(unit) ? unit : 'days';
  const validityValue = Number(value);
  if (!Number.isFinite(validityValue) || validityValue <= 0) {
    const err = new Error('Validity must be a positive number');
    err.statusCode = 400;
    throw err;
  }
  return { validityValue, validityUnit };
}

/** Approximate days for legacy `validityDays` field / display helpers */
export function approximateValidityDays(value, unit = 'days') {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  switch (unit) {
    case 'weeks':
      return v * 7;
    case 'months':
      return v * AVG_DAYS_PER_MONTH;
    case 'years':
      return v * AVG_DAYS_PER_YEAR;
    case 'days':
    default:
      return v;
  }
}

/**
 * Add package validity to a start date using the selected unit.
 * Whole months/years use calendar arithmetic; fractional parts use average-length days.
 */
export function addPackageValidity(startDate, value, unit = 'days') {
  const d = new Date(startDate);
  const { validityValue, validityUnit } = normalizePackageValidity(value, unit);

  switch (validityUnit) {
    case 'weeks':
      d.setTime(d.getTime() + validityValue * 7 * MS_PER_DAY);
      break;
    case 'months': {
      const whole = Math.trunc(validityValue);
      const frac = validityValue - whole;
      if (whole) d.setMonth(d.getMonth() + whole);
      if (frac) d.setTime(d.getTime() + frac * AVG_DAYS_PER_MONTH * MS_PER_DAY);
      break;
    }
    case 'years': {
      const whole = Math.trunc(validityValue);
      const frac = validityValue - whole;
      if (whole) d.setFullYear(d.getFullYear() + whole);
      if (frac) d.setTime(d.getTime() + frac * AVG_DAYS_PER_YEAR * MS_PER_DAY);
      break;
    }
    case 'days':
    default:
      d.setTime(d.getTime() + validityValue * MS_PER_DAY);
      break;
  }
  return d;
}

export function resolveTemplateValidity(templateOrBody = {}) {
  const unit = PACKAGE_VALIDITY_UNITS.includes(templateOrBody.validityUnit)
    ? templateOrBody.validityUnit
    : 'days';
  if (templateOrBody.validityValue != null && templateOrBody.validityValue !== '') {
    return normalizePackageValidity(templateOrBody.validityValue, unit);
  }
  // Legacy templates only stored validityDays; use as value with unit (default days)
  if (templateOrBody.validityDays != null && templateOrBody.validityDays !== '') {
    return normalizePackageValidity(templateOrBody.validityDays, unit);
  }
  return normalizePackageValidity(NaN, unit);
}
