export const SERVICE_TIME_UNITS = ['minute', 'hour', 'day', 'month'];

export const SERVICE_TIME_UNIT_MINUTES = {
  minute: 1,
  hour: 60,
  day: 24 * 60,
  month: 30 * 24 * 60
};

export function isValidServiceTimeUnit(unit) {
  return SERVICE_TIME_UNITS.includes(unit);
}

/** Convert UI value + unit to stored minutes. */
export function serviceTimeToMinutes(value, unit = 'minute') {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0;
  const factor = SERVICE_TIME_UNIT_MINUTES[unit] || 1;
  return Math.round(n * factor);
}

/** Pick a readable value + unit for stored minutes (for edit forms). */
export function minutesToServiceTimeInput(minutes) {
  if (minutes == null || minutes === '' || Number(minutes) <= 0) {
    return { value: '', unit: 'minute' };
  }
  const m = Number(minutes);
  for (const unit of ['month', 'day', 'hour', 'minute']) {
    const factor = SERVICE_TIME_UNIT_MINUTES[unit];
    if (m >= factor && m % factor === 0) {
      return { value: m / factor, unit };
    }
  }
  return { value: m, unit: 'minute' };
}

const UNIT_LABELS = {
  minute: { one: 'minute', other: 'minutes' },
  hour: { one: 'hour', other: 'hours' },
  day: { one: 'day', other: 'days' },
  month: { one: 'month', other: 'months' }
};

export function formatServiceTimeMinutes(minutes) {
  if (minutes == null || minutes === '' || Number(minutes) <= 0) return null;
  const { value, unit } = minutesToServiceTimeInput(minutes);
  const labels = UNIT_LABELS[unit] || UNIT_LABELS.minute;
  const word = value === 1 ? labels.one : labels.other;
  return `${value} ${word}`;
}

export function formatServiceTimeRange(minTime, maxTime) {
  const min = minTime != null && minTime !== '' ? Number(minTime) : null;
  const max = maxTime != null && maxTime !== '' ? Number(maxTime) : null;
  if (min != null && min > 0 && max != null && max > 0) {
    if (min === max) return formatServiceTimeMinutes(min);
    if (max > min) {
      return `${formatServiceTimeMinutes(min)} – ${formatServiceTimeMinutes(max)}`;
    }
  }
  if (max != null && max > 0) return `Up to ${formatServiceTimeMinutes(max)}`;
  if (min != null && min > 0) return `From ${formatServiceTimeMinutes(min)}`;
  return null;
}

export function validateServiceTimeRange(minTime, maxTime) {
  const min = minTime == null || minTime === '' ? null : Number(minTime);
  const max = maxTime == null || maxTime === '' ? null : Number(maxTime);

  if (min != null && (!Number.isFinite(min) || min < 0)) {
    return { ok: false, message: 'Minimum service time must be zero or greater' };
  }
  if (max != null && (!Number.isFinite(max) || max < 0)) {
    return { ok: false, message: 'Maximum service time must be zero or greater' };
  }
  if (min != null && max != null && max <= min) {
    return {
      ok: false,
      message: 'Maximum service time must be greater than minimum service time'
    };
  }

  return {
    ok: true,
    minTime: min != null ? min : null,
    maxTime: max != null ? max : null
  };
}
