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
import { normalizeJobAdvanceForCreate } from '../utils/jobAdvance.js';
import { sendPushNotification } from './notificationService.js';
import {
  validateSlotBooking,
  allocateBay,
  parseBookingDate,
  getBookingSettings,
  isDateAllowedForBooking
} from '../utils/booking.utils.js';
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

  if (payload.customerId) {
    const customer = await Customer.findOne({ _id: payload.customerId, businessId });
    if (!customer) throw new Error('Customer not found');

    let car;
    if (payload.carId) {
      car = await Car.findOne({ _id: payload.carId, businessId, customerId: customer._id });
      if (!car) throw new Error('Vehicle not found for this customer');
    } else {
      const vehicleNumber = String(payload.vehicleNumber || '').trim();
      if (!vehicleNumber) throw new Error('Vehicle number is required');
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
  if (!String(payload.vehicleNumber || '').trim()) {
    throw new Error('Vehicle number is required');
  }

  const customer = await findOrCreateCustomer(businessId, {
    name: payload.customerName,
    phone: payload.customerPhone,
    address: pickupAddress || undefined
  });
  const car = await findOrCreateCar(businessId, customer._id, payload);

  return {
    customer,
    car,
    pickupAddress,
    customerName: String(payload.customerName).trim(),
    customerPhone: normalizePhone(payload.customerPhone)
  };
}

async function createBookingRecord(businessId, payload, { status = 'PENDING', slotOpts = {} } = {}) {
  const { slot, bookingDate, bayNumber } = await validateSlotBooking(
    businessId,
    payload.slotId,
    payload.bookingDate,
    payload.bayNumber,
    slotOpts
  );

  const serviceIds = Array.isArray(payload.serviceIds) ? payload.serviceIds : [];
  if (!serviceIds.length) throw new Error('Select at least one service');

  const services = await Service.find({
    _id: { $in: serviceIds },
    businessId,
    isActive: { $ne: false }
  }).lean();
  if (services.length !== serviceIds.length) {
    throw new Error('One or more selected services are not available');
  }

  const { customer, car, pickupAddress, customerName, customerPhone } = await resolveBookingCustomerAndCar(
    businessId,
    payload
  );

  const now = new Date();
  let booking;
  try {
    booking = await Booking.create({
      businessId,
      customerId: customer._id,
      carId: car._id,
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
      vehicleNumber: String(payload.vehicleNumber || car.carNumber).trim().toUpperCase(),
      vehicleBrand: payload.vehicleBrand || car.brand,
      vehicleModel: payload.vehicleModel || car.model,
      vehicleType: payload.vehicleType || car.vehicleType,
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

  const { booking, slot, payloadDate } = await createBookingRecord(businessId, payload, {
    status: 'PENDING'
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

export async function createAdminBooking(businessId, payload) {
  const autoConfirm = payload.autoConfirm !== false;
  const { booking } = await createBookingRecord(businessId, payload, {
    status: autoConfirm ? 'CONFIRMED' : 'PENDING',
    slotOpts: ADMIN_BOOKING_OPTS
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

export async function convertBookingToJob(businessId, bookingId, userId, userRole) {
  const booking = await Booking.findOne({ _id: bookingId, businessId });
  if (!booking) throw new Error('Booking not found');
  if (booking.status !== 'CONFIRMED') throw new Error('Only confirmed bookings can be converted to a job');
  if (booking.jobId) throw new Error('Job already created for this booking');

  const capacityCheck = await canAcceptNewJob(businessId);
  if (!capacityCheck.canAccept) throw new Error(capacityCheck.reason);

  const servicesFound = await Service.find({
    _id: { $in: booking.serviceIds },
    businessId,
    isActive: { $ne: false }
  });
  if (servicesFound.length !== booking.serviceIds.length) {
    throw new Error('One or more services are no longer available');
  }

  const totalPrice = servicesFound.reduce((sum, s) => sum + s.price, 0);
  const advanceFields = normalizeJobAdvanceForCreate({}, 0);
  const estimatedDelivery = calculateETA(servicesFound);

  const pickupNote = booking.deliveryMethod === 'PICKUP_DROP'
    ? [`Pickup & Drop`, booking.pickupAddress, booking.pickupLandmark, booking.pickupNotes].filter(Boolean).join(' · ')
    : '';
  const notes = [booking.notes, pickupNote].filter(Boolean).join('\n') || undefined;

  let job;
  let attempts = 0;
  while (attempts < 5) {
    try {
      const tokenNumber = await generateTokenNumber(businessId);
      let assignedTo = null;
      if (userRole === 'EMPLOYEE') assignedTo = userId;

      job = await Job.create({
        businessId,
        customerId: booking.customerId,
        carId: booking.carId,
        tokenNumber,
        totalPrice,
        ...advanceFields,
        estimatedDelivery,
        notes,
        assignedTo,
        sourceBookingId: booking._id,
        services: servicesFound.map((s) => ({ serviceId: s._id, price: s.price })),
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
    await sendPushNotification({
      businessOwnerId: owner._id,
      title: 'Job created from booking',
      body: `Token ${job.tokenNumber} created for ${booking.customerName}`,
      data: { type: 'job_received', bookingId: String(job._id), url: `/admin/jobs/${job._id}` }
    });
  }

  return { booking, job };
}

export async function getBookingStats(businessId) {
  const [total, pending, confirmed, cancelled, rejected, converted, slots, popularSlotAgg, popularServiceAgg] = await Promise.all([
    Booking.countDocuments({ businessId }),
    Booking.countDocuments({ businessId, status: 'PENDING' }),
    Booking.countDocuments({ businessId, status: 'CONFIRMED' }),
    Booking.countDocuments({ businessId, status: 'CANCELLED' }),
    Booking.countDocuments({ businessId, status: 'REJECTED' }),
    Booking.countDocuments({ businessId, status: 'CONVERTED_TO_JOB' }),
    BookingSlot.countDocuments({ businessId, isEnabled: true }),
    Booking.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)), status: { $in: BOOKING_OCCUPYING_STATUSES.concat(['CANCELLED', 'REJECTED', 'CONVERTED_TO_JOB']) } } },
      { $group: { _id: '$slotId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ]),
    Booking.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)) } },
      { $unwind: '$serviceIds' },
      { $group: { _id: '$serviceIds', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ])
  ]);

  const conversionRate = total > 0 ? Math.round((converted / total) * 100) : 0;

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
