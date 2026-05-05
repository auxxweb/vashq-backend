import { DateTime } from 'luxon';

/**
 * Inclusive start and exclusive end of the calendar day containing `now` in `timeZone` (IANA).
 * Returns UTC Dates suitable for MongoDB queries.
 */
export function getZonedDayBoundsUtc(now, timeZone) {
  const zoneRaw =
    timeZone && typeof timeZone === 'string' && timeZone.trim().length > 0
      ? timeZone.trim()
      : 'UTC';
  const instant = DateTime.fromMillis((now instanceof Date ? now : new Date()).getTime());
  let z = instant.setZone(zoneRaw);
  if (!z.isValid) z = instant.setZone('UTC');
  const start = z.startOf('day');
  const end = start.plus({ days: 1 });
  return {
    start: start.toJSDate(),
    end: end.toJSDate(),
    zone: z.zoneName || zoneRaw,
    label: start.toFormat('ccc, dd LLL yyyy'),
  };
}
