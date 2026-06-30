import express from 'express';
import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { authenticate } from '../middleware/auth.middleware.js';
import Booking from '../models/Booking.model.js';
import BookingSlot from '../models/BookingSlot.model.js';
import Business from '../models/Business.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import {
  updateBookingStatus,
  rescheduleBooking,
  convertBookingToJob,
  getBookingConvertJobContext,
  getBookingStats,
  createAdminBooking
} from '../services/bookingService.js';
import { sendBookingErrorResponse } from '../utils/bookingErrors.js';
import { resolveFrontendBaseUrl } from '../utils/frontendUrl.js';
import {
  buildBookingWhatsAppMessage,
  parseBookingDate,
  getBookingSettings,
  getSlotAvailabilityForDate
} from '../utils/booking.utils.js';
import { parseBusinessDateRange } from '../utils/businessDateRange.js';
import { bookingSearchOrClauses } from '../utils/searchUtils.js';

import { resolveBranchContext, branchFilter } from '../middleware/branchContext.middleware.js';
import { requireBusinessModule } from '../middleware/businessModules.middleware.js';
import { scopedFilter, assertBranchAccess } from '../utils/branchAccess.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import { adminPanelOnly } from '../middleware/adminPanel.middleware.js';

async function findBookingScoped(req, id) {
  const booking = await Booking.findOne(scopedFilter(req, { _id: id }))
    .populate('slotId')
    .populate('serviceIds', 'name price')
    .populate('customerId', 'name phone whatsappNumber address')
    .populate('carId', 'carNumber brand model vehicleType')
    .populate('jobId', 'tokenNumber status');
  if (booking) assertBranchAccess(req, booking);
  return booking;
}

const router = express.Router();

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.user?.businessId) {
    return res.status(403).json({ success: false, message: 'Business not assigned' });
  }
  req.businessId = req.user.businessId;
  next();
});
router.use(resolveBranchContext);
router.use(requireBusinessModule('bookings'));
router.use(enforceActiveSubscription());

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
    return false;
  }
  return true;
}

// ---------- Online booking hub ----------
router.get('/link-info', async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('businessName logo').lean();
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    const baseUrl = resolveFrontendBaseUrl(req, { customerFacing: true });
    res.json({
      success: true,
      businessId: String(req.businessId),
      businessName: business.businessName,
      logo: business.logo || null,
      bookingUrl: `${baseUrl}/book/${req.businessId}`
    });
  } catch (e) {
    console.error('Booking link info error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Stats ----------
router.get('/stats', async (req, res) => {
  try {
    const settings = await BusinessSettings.findOne({ businessId: req.businessId }).select('timezone').lean();
    const range = String(req.query.range || 'today').toLowerCase();
    const fromQ = String(req.query.from || '').trim();
    const toQ = String(req.query.to || '').trim();
    let bounds;
    try {
      bounds = parseBusinessDateRange(settings?.timezone, range, fromQ, toQ);
    } catch (boundsErr) {
      if (boundsErr.statusCode === 400) {
        return res.status(400).json({ success: false, message: boundsErr.message });
      }
      throw boundsErr;
    }
    const stats = await getBookingStats(req.businessId, {
      startUtc: bounds.startUtc,
      endUtc: bounds.endUtc,
      branchId: req.branchScope === 'branch' ? req.branchId : null
    });
    res.json({ success: true, stats, rangeLabel: bounds.rangeLabel });
  } catch (e) {
    console.error('Booking stats error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Slots CRUD ----------
router.get('/slots', async (req, res) => {
  try {
    const slots = await BookingSlot.find({ businessId: req.businessId }).sort({ sortOrder: 1, startTime: 1 }).lean();
    res.json({ success: true, slots });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/slots', adminPanelOnly, [
  body('name').notEmpty().trim(),
  body('startTime').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('endTime').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('capacity').isInt({ min: 1, max: 50 }),
  body('sortOrder').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const slot = await BookingSlot.create({
      businessId: req.businessId,
      name: req.body.name.trim(),
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      capacity: Number(req.body.capacity),
      isEnabled: req.body.isEnabled !== false,
      sortOrder: Number(req.body.sortOrder) || 0
    });
    res.status(201).json({ success: true, slot });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/slots/:id', adminPanelOnly, [
  body('name').optional().notEmpty().trim(),
  body('startTime').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('endTime').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('capacity').optional().isInt({ min: 1, max: 50 }),
  body('isEnabled').optional().isBoolean(),
  body('sortOrder').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    if (!validate(req, res)) return;

    const { startTime, endTime } = req.body;
    if (startTime && endTime && startTime >= endTime) {
      return res.status(400).json({ success: false, message: 'End time must be after start time' });
    }

    const slot = await BookingSlot.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      {
        ...(req.body.name != null && { name: String(req.body.name).trim() }),
        ...(req.body.startTime != null && { startTime: req.body.startTime }),
        ...(req.body.endTime != null && { endTime: req.body.endTime }),
        ...(req.body.capacity != null && { capacity: Number(req.body.capacity) }),
        ...(req.body.isEnabled != null && { isEnabled: !!req.body.isEnabled }),
        ...(req.body.sortOrder != null && { sortOrder: Number(req.body.sortOrder) })
      },
      { new: true }
    );
    if (!slot) return res.status(404).json({ success: false, message: 'Slot not found' });
    res.json({ success: true, slot });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/slots/:id', adminPanelOnly, async (req, res) => {
  try {
    const activeBookings = await Booking.countDocuments({
      businessId: req.businessId,
      slotId: req.params.id,
      status: { $in: ['PENDING', 'CONFIRMED'] }
    });
    if (activeBookings > 0) {
      await BookingSlot.updateOne({ _id: req.params.id, businessId: req.businessId }, { isEnabled: false });
      return res.json({ success: true, message: 'Slot disabled (has active bookings)' });
    }
    await BookingSlot.deleteOne({ _id: req.params.id, businessId: req.businessId });
    res.json({ success: true, message: 'Slot deleted' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Calendar ----------
router.get('/calendar', [
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601()
], async (req, res) => {
  try {
    const settings = await getBookingSettings(req.businessId);
    const from = req.query.from
      ? parseBookingDate(String(req.query.from).slice(0, 10), settings.timezone)
      : parseBookingDate(new Date().toISOString().slice(0, 10), settings.timezone);
    const to = req.query.to
      ? parseBookingDate(String(req.query.to).slice(0, 10), settings.timezone)
      : from;

    const bookings = await Booking.find({
      ...branchFilter(req),
      bookingDate: { $gte: from, $lte: to }
    })
      .populate('slotId', 'name startTime endTime capacity')
      .sort({ bookingDate: 1, createdAt: 1 })
      .lean();

    res.json({ success: true, bookings });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Availability (admin — ignores online-booking toggle) ----------
router.get('/availability', async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!date) {
      return res.status(400).json({ success: false, message: 'Date is required' });
    }
    const availability = await getSlotAvailabilityForDate(req.businessId, date, {
      skipOnlineCheck: true,
      skipDateRules: true
    });
    res.json({ success: true, ...availability });
  } catch (e) {
    console.error('Booking availability error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Create booking (shop admin / walk-in) ----------
router.post('/', adminPanelOnly, [
  body('slotId').notEmpty().withMessage('Time slot is required'),
  body('bookingDate').notEmpty().withMessage('Booking date is required'),
  body('serviceIds').isArray({ min: 1 }).withMessage('Select at least one service'),
  body('bayNumber').optional().isInt({ min: 1 }),
  body('customerId').optional().isMongoId(),
  body('carId').optional().isMongoId(),
  body('customerName').optional().trim(),
  body('customerPhone').optional().trim(),
  body('vehicleNumber').optional().trim(),
  body('deliveryMethod').optional().isIn(['SELF_VISIT', 'PICKUP_DROP']),
  body('autoConfirm').optional().isBoolean()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    if (!req.body.customerId && (!req.body.customerName || !req.body.customerPhone)) {
      return res.status(400).json({ success: false, message: 'Customer name and phone are required' });
    }
    if (!req.branchId) {
      return res.status(400).json({ success: false, message: 'Select an active branch before creating a booking' });
    }
    const booking = await createAdminBooking(req.businessId, req.body, req.branchId);
    const populated = await Booking.findById(booking._id)
      .populate('slotId', 'name startTime endTime')
      .populate('serviceIds', 'name price')
      .lean();
    res.status(201).json({ success: true, booking: populated });
  } catch (e) {
    sendBookingErrorResponse(e, res, 'Could not create booking');
  }
});

// ---------- Bookings list & detail ----------
router.get('/', async (req, res) => {
  try {
    const filter = { ...branchFilter(req) };
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.date) {
      const settings = await getBookingSettings(req.businessId);
      filter.bookingDate = parseBookingDate(String(req.query.date).slice(0, 10), settings.timezone);
    }
    if (req.query.search && typeof req.query.search === 'string' && req.query.search.trim()) {
      const orClauses = bookingSearchOrClauses(req.query.search);
      if (orClauses.length) filter.$or = orClauses;
    }

    const bookings = await Booking.find(filter)
      .populate('slotId', 'name startTime endTime')
      .populate('serviceIds', 'name price')
      .sort({ bookingDate: -1, createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 200))
      .lean();

    res.json({ success: true, bookings });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const booking = await findBookingScoped(req, req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    res.json({ success: true, booking: booking.toObject ? booking.toObject() : booking });
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ success: false, message: 'Booking not found' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id/whatsapp-message', async (req, res) => {
  try {
    const type = String(req.query.type || 'confirmed').toLowerCase();
    const booking = await Booking.findOne({ _id: req.params.id, businessId: req.businessId })
      .populate('slotId')
      .populate('serviceIds', 'name')
      .lean();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    const [business, settings] = await Promise.all([
      Business.findById(req.businessId).select('businessName').lean(),
      BusinessSettings.findOne({ businessId: req.businessId }).lean()
    ]);

    const message = buildBookingWhatsAppMessage({
      booking,
      businessName: business?.businessName,
      slot: booking.slotId,
      settings,
      type
    });
    res.json({ success: true, message, phone: booking.customerPhone, type });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/:id/confirm', adminPanelOnly, async (req, res) => {
  try {
    const booking = await updateBookingStatus(req.businessId, req.params.id, 'CONFIRMED');
    res.json({ success: true, booking });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Failed to confirm' });
  }
});

router.patch('/:id/reject', adminPanelOnly, async (req, res) => {
  try {
    const booking = await updateBookingStatus(req.businessId, req.params.id, 'REJECTED');
    res.json({ success: true, booking });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Failed to reject' });
  }
});

router.patch('/:id/cancel', adminPanelOnly, async (req, res) => {
  try {
    const booking = await updateBookingStatus(req.businessId, req.params.id, 'CANCELLED');
    res.json({ success: true, booking });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Failed to cancel' });
  }
});

router.patch('/:id/reschedule', adminPanelOnly, [
  body('bookingDate').isISO8601(),
  body('slotId').notEmpty()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const booking = await rescheduleBooking(req.businessId, req.params.id, {
      bookingDate: String(req.body.bookingDate).slice(0, 10),
      slotId: req.body.slotId
    });
    res.json({ success: true, booking });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Failed to reschedule' });
  }
});

router.post('/:id/convert-job', adminPanelOnly, [
  body('carId').optional().isMongoId(),
  body('vehicleNumber').optional().trim(),
  body('vehicleBrand').optional().trim(),
  body('vehicleModel').optional().trim(),
  body('vehicleType').optional().trim()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const { booking, job } = await convertBookingToJob(
      req.businessId,
      req.params.id,
      req.user._id,
      req.user.role,
      req.body
    );
    res.status(201).json({ success: true, booking, job });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Failed to create job' });
  }
});

router.get('/:id/convert-job-context', async (req, res) => {
  try {
    const context = await getBookingConvertJobContext(req.businessId, req.params.id);
    res.json({ success: true, ...context });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Could not load job details' });
  }
});

export default router;
