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
  getBookingStats,
  createAdminBooking
} from '../services/bookingService.js';
import {
  buildBookingWhatsAppMessage,
  parseBookingDate,
  getBookingSettings,
  getSlotAvailabilityForDate
} from '../utils/booking.utils.js';

const router = express.Router();

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.user?.businessId) {
    return res.status(403).json({ success: false, message: 'Business not assigned' });
  }
  req.businessId = req.user.businessId;
  next();
});

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
    res.json({
      success: true,
      businessId: String(req.businessId),
      businessName: business.businessName,
      logo: business.logo || null
    });
  } catch (e) {
    console.error('Booking link info error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Stats ----------
router.get('/stats', async (req, res) => {
  try {
    const stats = await getBookingStats(req.businessId);
    res.json({ success: true, stats });
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

router.post('/slots', [
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

router.put('/slots/:id', async (req, res) => {
  try {
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

router.delete('/slots/:id', async (req, res) => {
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
      businessId: req.businessId,
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
router.post('/', [
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
    const booking = await createAdminBooking(req.businessId, req.body);
    const populated = await Booking.findById(booking._id)
      .populate('slotId', 'name startTime endTime')
      .populate('serviceIds', 'name price')
      .lean();
    res.status(201).json({ success: true, booking: populated });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Could not create booking' });
  }
});

// ---------- Bookings list & detail ----------
router.get('/', async (req, res) => {
  try {
    const filter = { businessId: req.businessId };
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.date) {
      const settings = await getBookingSettings(req.businessId);
      filter.bookingDate = parseBookingDate(String(req.query.date).slice(0, 10), settings.timezone);
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
    const booking = await Booking.findOne({ _id: req.params.id, businessId: req.businessId })
      .populate('slotId')
      .populate('serviceIds', 'name price')
      .populate('customerId', 'name phone whatsappNumber address')
      .populate('carId', 'carNumber brand model vehicleType')
      .populate('jobId', 'tokenNumber status')
      .lean();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    res.json({ success: true, booking });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id/whatsapp-message', async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, businessId: req.businessId })
      .populate('slotId')
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
      settings
    });
    res.json({ success: true, message, phone: booking.customerPhone });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/:id/confirm', async (req, res) => {
  try {
    const booking = await updateBookingStatus(req.businessId, req.params.id, 'CONFIRMED');
    res.json({ success: true, booking });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Failed to confirm' });
  }
});

router.patch('/:id/reject', async (req, res) => {
  try {
    const booking = await updateBookingStatus(req.businessId, req.params.id, 'REJECTED');
    res.json({ success: true, booking });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Failed to reject' });
  }
});

router.patch('/:id/cancel', async (req, res) => {
  try {
    const booking = await updateBookingStatus(req.businessId, req.params.id, 'CANCELLED');
    res.json({ success: true, booking });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Failed to cancel' });
  }
});

router.patch('/:id/reschedule', [
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

router.post('/:id/convert-job', async (req, res) => {
  try {
    const { booking, job } = await convertBookingToJob(
      req.businessId,
      req.params.id,
      req.user._id,
      req.user.role
    );
    res.status(201).json({ success: true, booking, job });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Failed to create job' });
  }
});

export default router;
