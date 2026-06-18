import { DateTime } from 'luxon';

export function resolveBusinessTimezone(settingsTz) {
  if (settingsTz && typeof settingsTz === 'string' && settingsTz.trim().length > 0) {
    return settingsTz.trim();
  }
  return process.env.CRON_TZ || 'UTC';
}

/** Maps UI / API tokens to canonical range keys. */
export function normalizeDateRangeKey(range) {
  const r = String(range || 'today').toLowerCase();
  const map = {
    daily: 'today',
    today: 'today',
    yesterday: 'yesterday',
    weekly: 'week',
    week: 'week',
    monthly: 'month',
    month: 'month',
    yearly: 'year',
    year: 'year',
    custom: 'custom',
    all: 'all'
  };
  return map[r] || r;
}

/**
 * Calendar bounds in the business IANA timezone.
 * Returns UTC Dates as a half-open interval: [startUtc, endUtc).
 */
export function parseBusinessDateRange(businessTz, range, fromQ = '', toQ = '') {
  const tz = resolveBusinessTimezone(businessTz);
  const key = normalizeDateRangeKey(range);

  if (key === 'all') {
    return { startUtc: null, endUtc: null, rangeLabel: 'All time', businessTz: tz };
  }

  const nowZ = DateTime.now().setZone(tz);
  const startOfDayZ = (dt) => dt.startOf('day');
  const endExclusiveDayZ = (dt) => dt.plus({ days: 1 }).startOf('day');
  const weekStartMonZ = (dt) => startOfDayZ(dt.minus({ days: dt.weekday - 1 }));

  let startZ;
  let endExclusiveZ;
  let rangeLabel;

  if (key === 'yesterday') {
    const y = nowZ.minus({ days: 1 });
    startZ = startOfDayZ(y);
    endExclusiveZ = endExclusiveDayZ(startZ);
    rangeLabel = 'Yesterday';
  } else if (key === 'week') {
    startZ = weekStartMonZ(nowZ);
    endExclusiveZ = endExclusiveDayZ(startOfDayZ(nowZ));
    rangeLabel = 'This week';
  } else if (key === 'month') {
    startZ = nowZ.startOf('month');
    endExclusiveZ = endExclusiveDayZ(startOfDayZ(nowZ));
    rangeLabel = 'This month';
  } else if (key === 'year') {
    startZ = nowZ.startOf('year');
    endExclusiveZ = endExclusiveDayZ(startOfDayZ(nowZ));
    rangeLabel = 'This year';
  } else if (key === 'custom') {
    const fromZ = fromQ ? DateTime.fromISO(String(fromQ).trim(), { zone: tz }).startOf('day') : null;
    const toZ = toQ ? DateTime.fromISO(String(toQ).trim(), { zone: tz }).startOf('day') : null;
    if (!fromZ?.isValid || !toZ?.isValid) {
      const err = new Error('Custom range requires valid from/to (YYYY-MM-DD)');
      err.statusCode = 400;
      throw err;
    }
    startZ = fromZ;
    endExclusiveZ = endExclusiveDayZ(toZ);
    rangeLabel = 'Custom';
  } else {
    startZ = startOfDayZ(nowZ);
    endExclusiveZ = endExclusiveDayZ(startZ);
    rangeLabel = 'Today';
  }

  return {
    startUtc: startZ.toUTC().toJSDate(),
    endUtc: endExclusiveZ.toUTC().toJSDate(),
    rangeLabel,
    businessTz: tz
  };
}

/** Apply half-open createdAt filter. */
export function applyCreatedAtRange(query, startUtc, endUtc) {
  if (!startUtc && !endUtc) return query;
  query.createdAt = {};
  if (startUtc) query.createdAt.$gte = startUtc;
  if (endUtc) query.createdAt.$lt = endUtc;
  return query;
}

/** Apply half-open filter on an arbitrary date field. */
export function applyDateFieldRange(query, field, startUtc, endUtc) {
  if (!startUtc && !endUtc) return query;
  query[field] = {};
  if (startUtc) query[field].$gte = startUtc;
  if (endUtc) query[field].$lt = endUtc;
  return query;
}
