import { DateTime } from 'luxon';

/** 0 = Sunday … 6 = Saturday (matches BusinessSettings.bookingAllowedDays). */
export const BOOKING_DAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
];

export const BOOKING_DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function defaultWeeklySchedule(fallback = { start: '09:00', end: '18:00' }) {
  const start = fallback.start || '09:00';
  const end = fallback.end || '18:00';
  return BOOKING_DAY_LABELS.map((_, day) => ({
    day,
    isOpen: true,
    start,
    end
  }));
}

function isValidTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/** Normalize "9:00" → "09:00" for reliable string comparisons. */
export function normalizeTimeValue(t) {
  if (!t || typeof t !== 'string') return t;
  const match = String(t).trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return t;
  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return t;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

/** Normalize stored schedule to 7 days; migrate legacy bookingAllowedDays when needed. */
export function normalizeWeeklySchedule(raw, options = {}) {
  const fallbackStart = options.fallbackStart || '09:00';
  const fallbackEnd = options.fallbackEnd || '18:00';
  const legacyAllowedDays = options.legacyAllowedDays;

  const byDay = new Map();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const day = Number(entry?.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) continue;
      const isOpen = entry.isOpen !== false;
      let start = isValidTime(entry.start) ? entry.start : fallbackStart;
      let end = isValidTime(entry.end) ? entry.end : fallbackEnd;
      if (isOpen && start >= end) {
        start = fallbackStart;
        end = fallbackEnd;
      }
      byDay.set(day, { day, isOpen, start, end });
    }
  }

  const hasLegacy = Array.isArray(legacyAllowedDays) && legacyAllowedDays.length > 0;
  return BOOKING_DAY_LABELS.map((_, day) => {
    if (byDay.has(day)) return byDay.get(day);
    if (hasLegacy) {
      return {
        day,
        isOpen: legacyAllowedDays.includes(day),
        start: fallbackStart,
        end: fallbackEnd
      };
    }
    return { day, isOpen: true, start: fallbackStart, end: fallbackEnd };
  });
}

export function weeklyScheduleToAllowedDays(schedule) {
  return schedule.filter((d) => d.isOpen).map((d) => d.day);
}

/** Read canonical weekly schedule from settings (supports legacy bookingWeeklySchedule). */
export function resolveWeeklySchedule(settings) {
  if (Array.isArray(settings?.weeklyOperatingSchedule) && settings.weeklyOperatingSchedule.length) {
    return settings.weeklyOperatingSchedule;
  }
  if (Array.isArray(settings?.bookingWeeklySchedule) && settings.bookingWeeklySchedule.length) {
    return settings.bookingWeeklySchedule;
  }
  return null;
}

/** Luxon weekday (1=Mon … 7=Sun) → JS day index (0=Sun … 6=Sat). */
function luxonDateToDayIndex(dt) {
  return dt.weekday % 7;
}

export function getDayScheduleForDate(dateStr, bookingSettings) {
  const timezone = bookingSettings?.timezone || 'Asia/Kolkata';
  const dt = DateTime.fromISO(String(dateStr), { zone: timezone }).startOf('day');
  if (!dt.isValid) return null;
  const dayIndex = luxonDateToDayIndex(dt);
  const schedule = resolveWeeklySchedule(bookingSettings);
  if (!Array.isArray(schedule) || !schedule.length) {
    const allowed = bookingSettings?.bookingAllowedDays;
    if (Array.isArray(allowed) && allowed.length > 0) {
      return {
        day: dayIndex,
        isOpen: allowed.includes(dayIndex),
        start: bookingSettings?.workingHours?.start || '09:00',
        end: bookingSettings?.workingHours?.end || '18:00'
      };
    }
    return {
      day: dayIndex,
      isOpen: true,
      start: bookingSettings?.workingHours?.start || '09:00',
      end: bookingSettings?.workingHours?.end || '18:00'
    };
  }
  return schedule.find((d) => d.day === dayIndex) || null;
}

export function isDateOpenForBooking(dateStr, bookingSettings) {
  const daySchedule = getDayScheduleForDate(dateStr, bookingSettings);
  return !!daySchedule?.isOpen;
}

/** Slot must fit entirely within the day's operating window. */
export function isSlotWithinDayHours(slot, daySchedule) {
  if (!daySchedule?.isOpen) return false;
  const start = normalizeTimeValue(String(slot?.startTime || ''));
  const end = normalizeTimeValue(String(slot?.endTime || ''));
  const dayStart = normalizeTimeValue(daySchedule.start || '09:00');
  const dayEnd = normalizeTimeValue(daySchedule.end || '18:00');
  if (!isValidTime(start) || !isValidTime(end)) return true;
  return start >= dayStart && end <= dayEnd;
}

export function closedDayMessage(dateStr, bookingSettings) {
  const daySchedule = getDayScheduleForDate(dateStr, bookingSettings);
  if (!daySchedule) return 'Date not available for booking';
  if (!daySchedule.isOpen) {
    const label = BOOKING_DAY_LABELS[daySchedule.day] || 'This day';
    return `${label} is closed — choose another date`;
  }
  return 'Date not available for booking';
}
