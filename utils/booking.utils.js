import { DateTime } from 'luxon';
import Booking, { BOOKING_OCCUPYING_STATUSES } from '../models/Booking.model.js';
import BookingSlot from '../models/BookingSlot.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';

export { normalizePhone } from './customer.utils.js';

/** Store booking date as UTC midnight for the calendar day in business timezone. */
export function parseBookingDate(dateStr, timezone = 'Asia/Kolkata') {
  const dt = DateTime.fromISO(String(dateStr), { zone: timezone }).startOf('day');
  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

export function formatBookingDateLabel(date, timezone = 'Asia/Kolkata') {
  if (!date) return '—';
  return DateTime.fromJSDate(new Date(date), { zone: timezone }).toFormat('dd LLL yyyy');
}

export function isPastBookingDate(dateStr, timezone = 'Asia/Kolkata') {
  const day = DateTime.fromISO(String(dateStr), { zone: timezone }).startOf('day');
  const today = DateTime.now().setZone(timezone).startOf('day');
  return day < today;
}

export async function getBookingSettings(businessId) {
  const settings = await BusinessSettings.findOne({ businessId }).lean();
  return {
    onlineBookingEnabled: settings?.onlineBookingEnabled !== false,
    bookingAllowedDays: Array.isArray(settings?.bookingAllowedDays) ? settings.bookingAllowedDays : null,
    bookingAdvanceDays: Number(settings?.bookingAdvanceDays) || 30,
    timezone: settings?.timezone || 'Asia/Kolkata',
    currency: settings?.currency || 'INR'
  };
}

export function isDateAllowedForBooking(dateStr, bookingSettings, options = {}) {
  const { bookingAllowedDays, bookingAdvanceDays, timezone } = bookingSettings;
  if (isPastBookingDate(dateStr, timezone)) return false;

  if (options.skipDateRules) return true;

  const day = DateTime.fromISO(String(dateStr), { zone: timezone }).startOf('day');
  const today = DateTime.now().setZone(timezone).startOf('day');
  const maxDay = today.plus({ days: bookingAdvanceDays });
  if (day > maxDay) return false;

  if (Array.isArray(bookingAllowedDays) && bookingAllowedDays.length > 0) {
    const dow = day.weekday % 7;
    if (!bookingAllowedDays.includes(dow)) return false;
  }
  return true;
}

export async function countOccupiedBays(businessId, slotId, bookingDate) {
  const bookings = await Booking.find({
    businessId,
    slotId,
    bookingDate,
    status: { $in: BOOKING_OCCUPYING_STATUSES }
  }).select('bayNumber').lean();

  return bookings.map((b) => b.bayNumber);
}

export async function allocateBay(businessId, slotId, bookingDate, capacity) {
  const occupied = await countOccupiedBays(businessId, slotId, bookingDate);
  const occupiedSet = new Set(occupied);
  for (let bay = 1; bay <= capacity; bay += 1) {
    if (!occupiedSet.has(bay)) return bay;
  }
  return null;
}

export function buildBayMap(capacity, occupiedBayNumbers = []) {
  const occupied = new Set(occupiedBayNumbers);
  return Array.from({ length: capacity }, (_, i) => {
    const number = i + 1;
    return {
      number,
      label: `Bay ${number}`,
      status: occupied.has(number) ? 'booked' : 'available'
    };
  });
}

export async function getSlotAvailabilityForDate(businessId, dateStr, options = {}) {
  const bookingSettings = await getBookingSettings(businessId);
  if (!options.skipOnlineCheck && !bookingSettings.onlineBookingEnabled) {
    return { allowed: false, slots: [], reason: 'Online booking is not enabled' };
  }
  if (!isDateAllowedForBooking(dateStr, bookingSettings, options)) {
    return { allowed: false, slots: [], reason: 'Date not available for booking' };
  }

  const bookingDate = parseBookingDate(dateStr, bookingSettings.timezone);
  const slots = await BookingSlot.find({ businessId, isEnabled: true }).sort({ sortOrder: 1, startTime: 1 }).lean();

  const availability = await Promise.all(slots.map(async (slot) => {
    const occupied = await countOccupiedBays(businessId, slot._id, bookingDate);
    const booked = occupied.length;
    const available = Math.max(0, slot.capacity - booked);
    return {
      _id: slot._id,
      name: slot.name,
      startTime: slot.startTime,
      endTime: slot.endTime,
      capacity: slot.capacity,
      booked,
      available,
      isFull: available <= 0,
      bays: buildBayMap(slot.capacity, occupied)
    };
  }));

  return { allowed: true, slots: availability, bookingDate, timezone: bookingSettings.timezone };
}

export async function validateSlotBooking(businessId, slotId, dateStr, preferredBay = null, options = {}) {
  const bookingSettings = await getBookingSettings(businessId);
  if (!options.skipOnlineCheck && !bookingSettings.onlineBookingEnabled) {
    throw new Error('Online booking is not enabled for this business');
  }
  if (!isDateAllowedForBooking(dateStr, bookingSettings, options)) {
    throw new Error('Selected date is not available for booking');
  }

  const slot = await BookingSlot.findOne({ _id: slotId, businessId, isEnabled: true }).lean();
  if (!slot) {
    throw new Error('Selected time slot is not available');
  }

  const bookingDate = parseBookingDate(dateStr, bookingSettings.timezone);
  const occupied = await countOccupiedBays(businessId, slotId, bookingDate);
  const occupiedSet = new Set(occupied);

  let bayNumber;
  const preferred = Number(preferredBay);
  if (preferredBay != null && preferredBay !== '' && Number.isFinite(preferred) && preferred >= 1) {
    if (preferred > slot.capacity) {
      throw new Error('Invalid bay selection');
    }
    if (occupiedSet.has(preferred)) {
      throw new Error('This bay was just booked. Please choose another.');
    }
    bayNumber = preferred;
  } else {
    bayNumber = await allocateBay(businessId, slotId, bookingDate, slot.capacity);
  }

  if (!bayNumber) {
    throw new Error('This time slot is fully booked');
  }

  return { slot, bookingDate, bayNumber, bookingSettings };
}

export function buildBookingWhatsAppMessage({ booking, businessName, slot, settings }) {
  const tz = settings?.timezone || 'Asia/Kolkata';
  const dateLabel = formatBookingDateLabel(booking.bookingDate, tz);
  const slotLabel = slot?.name || `${slot?.startTime || ''} - ${slot?.endTime || ''}`.trim();
  const vehicle = [booking.vehicleBrand, booking.vehicleModel, booking.vehicleNumber].filter(Boolean).join(' ');
  const pickup = booking.deliveryMethod === 'PICKUP_DROP' ? '\nPickup & Drop requested.' : '';

  return [
    `Hello ${booking.customerName},`,
    '',
    `Your appointment at ${businessName || 'our shop'} is confirmed.`,
    '',
    `Date: ${dateLabel}`,
    `Time: ${slotLabel}`,
    `Vehicle: ${vehicle || booking.vehicleNumber}`,
    pickup,
    '',
    'Thank you for choosing us!'
  ].join('\n');
}
