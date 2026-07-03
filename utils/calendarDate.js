import { DateTime } from 'luxon';

/** Parse YYYY-MM-DD (or ISO string) as start of that calendar day in the business timezone. */
export function parseBusinessCalendarDate(dateStr, timezone = 'Asia/Kolkata') {
  const raw = dateStr ? String(dateStr).trim().slice(0, 10) : null;
  const dt = raw
    ? DateTime.fromISO(raw, { zone: timezone }).startOf('day')
    : DateTime.now().setZone(timezone).startOf('day');
  if (!dt.isValid) {
    return DateTime.now().setZone(timezone).startOf('day').toUTC().toJSDate();
  }
  return dt.toUTC().toJSDate();
}

/** Format a stored expense/calendar date for display (DD/MM/YYYY). */
export function formatBusinessCalendarDate(value, timezone = 'Asia/Kolkata') {
  if (!value) return '';
  const dt = DateTime.fromJSDate(new Date(value), { zone: timezone });
  if (!dt.isValid) return '';
  return dt.toFormat('dd/MM/yyyy');
}

/** YYYY-MM-DD for HTML date inputs from a stored calendar date. */
export function businessCalendarDateToInputValue(value, timezone = 'Asia/Kolkata') {
  if (!value) return '';
  const dt = DateTime.fromJSDate(new Date(value), { zone: timezone });
  if (!dt.isValid) return '';
  return dt.toFormat('yyyy-MM-dd');
}
