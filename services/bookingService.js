import mongoose from 'mongoose';
import Booking, { BOOKING_OCCUPYING_STATUSES } from '../models/Booking.model.js';
import BookingSlot from '../models/BookingSlot.model.js';
import Business from '../models/Business.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import Job from '../models/Job.model.js';
import User from '../models/User.model.js';
import { generateTokenNumber, calculateETA, canAcceptNewJob } from '../utils/job.utils.js';
import { resolveJobServiceLines } from '../utils/jobServiceLines.js';
import { normalizeJobAdvanceForCreate } from '../utils/jobAdvance.js';
import { sendPushNotification } from './notificationService.js';
import {
  validateSlotBooking,
  allocateBay,
  parseBookingDate,
  getBookingSettings,
  isDateAllowedForBooking
} from '../utils/booking.utils.js';
import { applyCreatedAtRange } from '../utils/businessDateRange.js';
import { findOrCreateCustomer, normalizePhone } from '../utils/customer.utils.js';

async function findOrCreateCar(businessId, customerId, vehicle) {
  const carNumber = String(vehicle.vehicleNumber || '').trim().toUpperCase();
  if (!carNumber) throw new Error('Vehicle number is required');

  let car = await Car.findOne({ businessId, customerId, carNumber });
  if (car) {
    let changed = false;
    if (vehicle.vehicleBrand && !car.brand) { car.brand = vehicle.vehicleBrand; changed = true; }
    if (vehicle.vehicleModel && !car.model) { car.model = vehicle.vehicleModel; changed = true; }
    if (vehicle.vehicleType && !car.vehicleType) { car.vehicleType = vehicle.vehicleType; changed = true; }
    if (changed) await car.save();
    return car;
  }

  car = await Car.create({
    businessId,
    customerId,
    carNumber,
    brand: vehicle.vehicleBrand || undefined,
    model: vehicle.vehicleModel || undefined,
    vehicleType: vehicle.vehicleType || undefined
  });
  return car;
}

async function notifyOwner(businessId, { type, title, body, bookingId, url }) {
  const owner = await User.findOne({ businessId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' }).select('_id').lean();
  if (!owner) return;
  try {
    await sendPushNotification({
      businessOwnerId: owner._id,
      title,
      body,
      data: { type, bookingId: String(bookingId), url }
    });
  } catch (e) {
    console.warn('Booking notification failed:', e?.message || e);
  }
}

const ADMIN_BOOKING_OPTS = { skipOnlineCheck: true, skipDateRules: true };

async function resolveBookingCustomerAndCar(businessId, payload) {
  const pickupAddress = payload.deliveryMethod === 'PICKUP_DROP'
    ? String(payload.pickupAddress || '').trim()
    : '';
  if (payload.deliveryMethod === 'PICKUP_DROP' && !pickupAddress) {
    throw new Error('Address is required for pickup & drop');
  }

  const vehicleNumber = String(payload.vehicleNumber || '').trim();
  const hasVehicle = !!vehicleNumber;

  if (payload.customerId) {
    const customer = await Customer.findOne({ _id: payload.customerId, businessId });
    if (!customer) throw new Error('Customer not found');

    let car = null;
    if (payload.carId) {
      car = await Car.findOne({ _id: payload.carId, businessId, customerId: customer._id });
      if (!car) throw new Error('Vehicle not found for this customer');
    } else if (hasVehicle) {
      car = await findOrCreateCar(businessId, customer._id, payload);
    }

    return {
      customer,
      car,
      pickupAddress,
      customerName: String(payload.customerName || customer.name).trim(),
      customerPhone: normalizePhone(payload.customerPhone || customer.phone)
    };
  }

  if (!String(payload.customerName || '').trim() || !String(payload.customerPhone || '').trim()) {
    throw new Error('Customer name and phone are required');
  }

  const customer = await findOrCreateCustomer(businessId, {
    name: payload.customerName,
    phone: payload.customerPhone,
    address: pickupAddress || undefined
  });

  let car = null;
  if (hasVehicle) {
    car = await findOrCreateCar(businessId, customer._id, payload);
  }

  return {
    customer,
    car,
    pickupAddress,
    customerName: String(payload.customerName).trim(),
    customerPhone: normalizePhone(payload.customerPhone)
  };
}

async function createBookingRecord(businessId, payload, { status = 'PENDING', slotOpts = {}, branchId = null } = {}) {
  const { slot, bookingDate, bayNumber } = await validateSlotBooking(
    businessId,
    payload.slotId,
    payload.bookingDate,
    payload.bayNumber,
    slotOpts
  );

  const rawServiceIds = Array.isArray(payload.serviceIds) ? payload.serviceIds : [];
  const uniqueServiceIds = [...new Set(rawServiceIds.map(String))];
  if (!uniqueServiceIds.length) throw new Error('Select at least one service');

  const services = await Service.find({
    _id: { $in: uniqueServiceIds },
    businessId,
    isActive: { $ne: false }
  }).lean();
  if (services.length !== uniqueServiceIds.length) {
    throw new Error('One or more selected services are not available');
  }

  const variableServices = services.filter((s) => s.isVariable);
  if (variableServices.length) {
    throw new Error(
      `Variable-price services cannot be booked online (${variableServices.map((s) => s.name).join(', ')}). Add them when creating the job instead.`
    );
  }

  const { customer, car, pickupAddress, customerName, customerPhone } = await resolveBookingCustomerAndCar(
    businessId,
    payload
  );

  const vehicleNumberRaw = String(payload.vehicleNumber || '').trim().toUpperCase();
  const now = new Date();
  let booking;
  try {
    booking = await Booking.create({
      businessId,
      branchId: branchId || undefined,
      customerId: customer._id,
      carId: car?._id || undefined,
      serviceIds: services.map((s) => s._id),
      bookingDate,
      slotId: slot._id,
      bayNumber,
      status,
      confirmedAt: status === 'CONFIRMED' ? now : undefined,
      deliveryMethod: payload.deliveryMethod === 'PICKUP_DROP' ? 'PICKUP_DROP' : 'SELF_VISIT',
      pickupAddress: pickupAddress || undefined,
      pickupLandmark: payload.pickupLandmark || undefined,
      pickupNotes: payload.pickupNotes || undefined,
      customerName,
      customerPhone,
      vehicleNumber: car?.carNumber || vehicleNumberRaw || undefined,
      vehicleBrand: payload.vehicleBrand || car?.brand,
      vehicleModel: payload.vehicleModel || car?.model,
      vehicleType: payload.vehicleType || car?.vehicleType,
      notes: payload.notes || undefined
    });
  } catch (err) {
    if (err?.code === 11000) throw new Error('This time slot was just booked. Please choose another slot.');
    throw err;
  }

  return { booking, slot, payloadDate: payload.bookingDate };
}

export async function createPublicBooking(businessId, payload) {
  const business = await Business.findOne({ _id: businessId, status: 'ACTIVE' }).lean();
  if (!business) throw new Error('Business not found');

  const { ensureDefaultBranchForBusiness } = await import('./branchService.js');
  const defaultBranch = await ensureDefaultBranchForBusiness(businessId);

  const { booking, slot, payloadDate } = await createBookingRecord(businessId, payload, {
    status: 'PENDING',
    branchId: defaultBranch?._id || null
  });

  await notifyOwner(businessId, {
    type: 'booking_request',
    title: 'New booking request',
    body: `${booking.customerName} booked ${slot.name} on ${payloadDate}`,
    bookingId: booking._id,
    url: `/admin/bookings/${booking._id}`
  });

  const availAfter = slot.capacity - (await Booking.countDocuments({
    businessId,
    slotId: slot._id,
    bookingDate: booking.bookingDate,
    status: { $in: BOOKING_OCCUPYING_STATUSES }
  }));
  if (availAfter <= 0) {
    await notifyOwner(businessId, {
      type: 'booking_slot_full',
      title: 'Slot fully booked',
      body: `${slot.name} is full on ${payloadDate}`,
      bookingId: booking._id,
      url: `/admin/bookings?date=${payloadDate}`
    });
  }

  return booking;
}

export async function createAdminBooking(businessId, payload, branchId = null) {
  const autoConfirm = payload.autoConfirm !== false;
  const { booking } = await createBookingRecord(businessId, payload, {
    status: autoConfirm ? 'CONFIRMED' : 'PENDING',
    slotOpts: ADMIN_BOOKING_OPTS,
    branchId
  });
  return booking;
}

export async function updateBookingStatus(businessId, bookingId, status, options = {}) {
  const booking = await Booking.findOne({ _id: bookingId, businessId });
  if (!booking) throw new Error('Booking not found');

  const now = new Date();
  if (status === 'CONFIRMED') {
    if (booking.status !== 'PENDING') throw new Error('Only pending bookings can be confirmed');
    booking.status = 'CONFIRMED';
    booking.confirmedAt = now;
  } else if (status === 'REJECTED') {
    if (!['PENDING', 'CONFIRMED'].includes(booking.status)) throw new Error('Cannot reject this booking');
    booking.status = 'REJECTED';
    booking.rejectedAt = now;
  } else if (status === 'CANCELLED') {
    if (!['PENDING', 'CONFIRMED'].includes(booking.status)) throw new Error('Cannot cancel this booking');
    booking.status = 'CANCELLED';
    booking.cancelledAt = now;
  } else {
    throw new Error('Invalid status');
  }

  await booking.save();

  if (status === 'CANCELLED') {
    await notifyOwner(businessId, {
      type: 'booking_cancelled',
      title: 'Booking cancelled',
      body: `${booking.customerName}'s booking was cancelled`,
      bookingId: booking._id,
      url: `/admin/bookings/${booking._id}`
    });
  }

  return booking;
}

export async function rescheduleBooking(businessId, bookingId, { bookingDate: dateStr, slotId }) {
  const booking = await Booking.findOne({ _id: bookingId, businessId });
  if (!booking) throw new Error('Booking not found');
  if (!['PENDING', 'CONFIRMED'].includes(booking.status)) {
    throw new Error('Only pending or confirmed bookings can be rescheduled');
  }

  const bookingSettings = await getBookingSettings(businessId);
  if (!isDateAllowedForBooking(dateStr, bookingSettings)) {
    throw new Error('Selected date is not available');
  }

  const slot = await BookingSlot.findOne({ _id: slotId, businessId, isEnabled: true }).lean();
  if (!slot) throw new Error('Slot not found');

  const newDate = parseBookingDate(dateStr, bookingSettings.timezone);
  const bayNumber = await allocateBay(businessId, slotId, newDate, slot.capacity);
  if (!bayNumber) throw new Error('Selected slot is fully booked');

  booking.rescheduledFrom = {
    bookingDate: booking.bookingDate,
    slotId: booking.slotId,
    bayNumber: booking.bayNumber
  };
  booking.bookingDate = newDate;
  booking.slotId = slot._id;
  booking.bayNumber = bayNumber;

  try {
    await booking.save();
  } catch (err) {
    if (err?.code === 11000) throw new Error('Selected slot is fully booked');
    throw err;
  }

  return booking;
}

async function resolveCarForJobConversion(businessId, booking, payload = {}) {
  if (payload.carId) {
    const selected = await Car.findOne({
      _id: payload.carId,
      businessId,
      customerId: booking.customerId
    });
    if (!selected) throw new Error('Vehicle not found for this customer');
    booking.carId = selected._id;
    booking.vehicleNumber = selected.carNumber;
    if (!booking.vehicleBrand && selected.brand) booking.vehicleBrand = selected.brand;
    if (!booking.vehicleModel && selected.model) booking.vehicleModel = selected.model;
    if (!booking.vehicleType && selected.vehicleType) booking.vehicleType = selected.vehicleType;
    return selected;
  }

  if (booking.carId) {
    const existing = await Car.findOne({ _id: booking.carId, businessId, customerId: booking.customerId });
    if (existing) return existing;
  }

  const vehicleNumber = String(
    payload.vehicleNumber || booking.vehicleNumber || ''
  ).trim();

  if (!vehicleNumber) {
    const err = new Error('Vehicle number is required to create a job');
    err.code = 'VEHICLE_REQUIRED';
    throw err;
  }

  const car = await findOrCreateCar(businessId, booking.customerId, {
    vehicleNumber,
    vehicleBrand: payload.vehicleBrand || booking.vehicleBrand,
    vehicleModel: payload.vehicleModel || booking.vehicleModel,
    vehicleType: payload.vehicleType || booking.vehicleType
  });

  booking.carId = car._id;
  booking.vehicleNumber = car.carNumber;
  if (!booking.vehicleBrand && car.brand) booking.vehicleBrand = car.brand;
  if (!booking.vehicleModel && car.model) booking.vehicleModel = car.model;
  if (!booking.vehicleType && car.vehicleType) booking.vehicleType = car.vehicleType;

  return car;
}

/** Cars + auto-select hint for booking → job conversion UI. */
export async function getBookingConvertJobContext(businessId, bookingId) {
  const booking = await Booking.findOne({ _id: bookingId, businessId }).lean();
  if (!booking) throw new Error('Booking not found');
  if (booking.status !== 'CONFIRMED') throw new Error('Only confirmed bookings can be converted to a job');
  if (booking.jobId) throw new Error('This booking already has a job');

  const cars = await Car.find({ businessId, customerId: booking.customerId })
    .sort({ updatedAt: -1 })
    .lean();

  const bookingVehicle = String(booking.vehicleNumber || '').trim().toUpperCase();
  const hasBookingVehicle = !!(booking.carId || bookingVehicle);

  let matchedCarId = null;
  if (booking.carId) {
    matchedCarId = String(booking.carId);
  } else if (bookingVehicle) {
    const match = cars.find((c) => String(c.carNumber || '').trim().toUpperCase() === bookingVehicle);
    if (match) matchedCarId = String(match._id);
  } else if (cars.length === 1) {
    matchedCarId = String(cars[0]._id);
  }

  let autoCarId = null;
  if (booking.carId) {
    autoCarId = String(booking.carId);
  } else if (hasBookingVehicle) {
    if (matchedCarId) autoCarId = matchedCarId;
    else if (cars.length === 1) autoCarId = String(cars[0]._id);
  }

  const requireCarPicker = !autoCarId && cars.length > 0;

  return {
    customerId: booking.customerId,
    cars,
    matchedCarId,
    autoCarId,
    requireCarPicker,
    hasBookingVehicle,
    vehicleNumber: booking.vehicleNumber || '',
    vehicleBrand: booking.vehicleBrand || '',
    vehicleModel: booking.vehicleModel || '',
    vehicleType: booking.vehicleType || ''
  };
}

export async function convertBookingToJob(businessId, bookingId, userId, userRole, payload = {}) {
  const booking = await Booking.findOne({ _id: bookingId, businessId });
  if (!booking) throw new Error('Booking not found');
  if (booking.status !== 'CONFIRMED') throw new Error('Only confirmed bookings can be converted to a job');
  if (booking.jobId) {
    const existing = await Job.findOne({ _id: booking.jobId, businessId });
    if (existing) return { booking, job: existing };
  }

  const existingBySource = await Job.findOne({ businessId, sourceBookingId: booking._id });
  if (existingBySource) {
    booking.status = 'CONVERTED_TO_JOB';
    booking.jobId = existingBySource._id;
    booking.convertedAt = booking.convertedAt || new Date();
    await booking.save();
    return { booking, job: existingBySource };
  }

  const branchId = booking.branchId || null;
  const capacityCheck = await canAcceptNewJob(businessId, branchId);
  if (!capacityCheck.canAccept) throw new Error(capacityCheck.reason);

  const car = await resolveCarForJobConversion(businessId, booking, payload);

  let lines;
  let totalPrice;
  let catalogServices;
  try {
    ({ lines, totalPrice, catalogServices } = await resolveJobServiceLines(businessId, {
      serviceIds: (booking.serviceIds || []).map(String)
    }));
  } catch (svcErr) {
    throw new Error(svcErr.message || 'Services on this booking are no longer valid');
  }

  const advanceFields = normalizeJobAdvanceForCreate({}, 0);
  const estimatedDelivery = calculateETA(catalogServices);

  const pickupNote = booking.deliveryMethod === 'PICKUP_DROP'
    ? [`Pickup & Drop`, booking.pickupAddress, booking.pickupLandmark, booking.pickupNotes].filter(Boolean).join(' · ')
    : '';
  const notes = [booking.notes, pickupNote].filter(Boolean).join('\n') || undefined;

  let job;
  let attempts = 0;
  while (attempts < 5) {
    try {
      const tokenNumber = await generateTokenNumber(businessId, branchId);
      let assignedTo = null;
      if (userRole === 'EMPLOYEE') assignedTo = userId;

      job = await Job.create({
        businessId,
        branchId: branchId || undefined,
        customerId: booking.customerId,
        carId: car._id,
        tokenNumber,
        totalPrice,
        ...advanceFields,
        estimatedDelivery,
        notes,
        assignedTo,
        sourceBookingId: booking._id,
        services: lines,
        statusHistory: [{ status: 'RECEIVED', changedAt: new Date() }]
      });
      break;
    } catch (err) {
      if (err?.code === 11000 && attempts < 4) {
        attempts += 1;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }

  if (!job) throw new Error('Failed to create job');

  booking.status = 'CONVERTED_TO_JOB';
  booking.jobId = job._id;
  booking.convertedAt = new Date();
  await booking.save();

  const owner = await User.findOne({ businessId, role: 'CAR_WASH_ADMIN' }).select('_id').lean();
  if (owner) {
    try {
      await sendPushNotification({
        businessOwnerId: owner._id,
        title: 'Job created from booking',
        body: `Token ${job.tokenNumber} created for ${booking.customerName}`,
        data: {
          type: 'job_received',
          bookingId: String(booking._id),
          jobId: String(job._id),
          url: `/admin/jobs/${job._id}`
        }
      });
    } catch (pushErr) {
      console.error('Booking conversion push notification failed:', pushErr?.message || pushErr);
    }
  }

  return { booking, job };
}

function buildBookingStatsMatch(businessId, { startUtc, endUtc, branchId = null } = {}) {
  const match = { businessId: new mongoose.Types.ObjectId(String(businessId)) };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(String(branchId));
  applyCreatedAtRange(match, startUtc, endUtc);
  return match;
}

export async function getBookingStats(businessId, { startUtc, endUtc, branchId = null } = {}) {
  const baseMatch = buildBookingStatsMatch(businessId, { startUtc, endUtc, branchId });
  const count = (status) => Booking.countDocuments({ ...baseMatch, status });

  const [pending, confirmed, cancelled, rejected, converted, slots, popularSlotAgg, popularServiceAgg] = await Promise.all([
    count('PENDING'),
    count('CONFIRMED'),
    count('CANCELLED'),
    count('REJECTED'),
    count('CONVERTED_TO_JOB'),
    BookingSlot.countDocuments({ businessId, isEnabled: true }),
    Booking.aggregate([
      { $match: { ...baseMatch, status: { $in: BOOKING_OCCUPYING_STATUSES } } },
      { $group: { _id: '$slotId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ]),
    Booking.aggregate([
      { $match: { ...baseMatch, status: { $in: BOOKING_OCCUPYING_STATUSES } } },
      { $unwind: '$serviceIds' },
      { $group: { _id: '$serviceIds', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ])
  ]);

  const total = pending + confirmed + cancelled + rejected + converted;
  const activeTotal = pending + confirmed + converted;
  const conversionRate = activeTotal > 0 ? Math.round((converted / activeTotal) * 100) : 0;

  let mostPopularSlot = null;
  if (popularSlotAgg[0]?._id) {
    mostPopularSlot = await BookingSlot.findById(popularSlotAgg[0]._id).select('name').lean();
  }

  let mostPopularService = null;
  if (popularServiceAgg[0]?._id) {
    mostPopularService = await Service.findById(popularServiceAgg[0]._id).select('name').lean();
  }

  return {
    total,
    pending,
    confirmed,
    cancelled,
    rejected,
    converted,
    conversionRate,
    activeSlots: slots,
    mostPopularSlot: mostPopularSlot?.name || null,
    mostPopularService: mostPopularService?.name || null
  };
}
