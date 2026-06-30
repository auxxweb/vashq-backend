import express from 'express';
import rateLimit from 'express-rate-limit';
import Invoice from '../models/Invoice.model.js';
import PlatformSettings from '../models/PlatformSettings.model.js';
import Business from '../models/Business.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Service from '../models/Service.model.js';
import { createPublicBooking } from '../services/bookingService.js';
import { sendBookingErrorResponse } from '../utils/bookingErrors.js';
import { getSlotAvailabilityForDate, getBookingSettings } from '../utils/booking.utils.js';
import {
  getInvoiceCompanySnapshot,
  mergeInvoiceWithCompanySnapshot,
  companyFieldsToPersist
} from '../utils/invoiceCompany.js';
import Branch from '../models/Branch.model.js';
import { isBranchOperational } from '../services/branchService.js';
import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';

const router = express.Router();

const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many booking attempts. Please try again later.' }
});

// GET /api/public/branch-portal/:branchId — branch login page info (no auth)
router.get('/branch-portal/:branchId', async (req, res) => {
  try {
    const { branchId } = req.params;
    if (!branchId || !/^[a-f\d]{24}$/i.test(branchId)) {
      return res.status(400).json({ success: false, message: 'Invalid branch' });
    }

    const branch = await Branch.findById(branchId).lean();
    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found' });
    }

    const business = await Business.findById(branch.businessId)
      .select('businessName logo status')
      .lean();
    if (!business || business.status !== 'ACTIVE') {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    const modules = await getBusinessModules(branch.businessId);
    const branchesModuleOn = isModuleEnabled(modules, 'branches');
    const operational = branchesModuleOn && await isBranchOperational(branch);

    res.json({
      success: true,
      moduleDisabled: !branchesModuleOn,
      branch: {
        _id: branch._id,
        businessId: branch.businessId,
        name: branch.name,
        code: branch.code,
        address: branch.address || '',
        phone: branch.phone || '',
        isDefault: branch.isDefault,
        status: branch.status,
        operational
      },
      business: {
        _id: business._id,
        businessName: business.businessName,
        logo: business.logo || null
      }
    });
  } catch (error) {
    console.error('Public branch portal info error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/public/book/:businessId — business info + services for booking page
router.get('/book/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    if (!businessId || !/^[a-f\d]{24}$/i.test(businessId)) {
      return res.status(400).json({ success: false, message: 'Invalid business' });
    }

    const [business, settings, services] = await Promise.all([
      Business.findOne({ _id: businessId, status: 'ACTIVE' }).select('businessName address logo phone whatsappNumber').lean(),
      BusinessSettings.findOne({ businessId }).lean(),
      Service.find({ businessId, isActive: { $ne: false }, isVariable: { $ne: true } }).select('name price minTime maxTime description').sort({ name: 1 }).lean()
    ]);

    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    const modules = await getBusinessModules(businessId);
    if (!isModuleEnabled(modules, 'bookings')) {
      return res.status(403).json({ success: false, message: 'Online booking is not available' });
    }
    if (settings?.onlineBookingEnabled === false) {
      return res.status(403).json({ success: false, message: 'Online booking is not available' });
    }

    res.json({
      success: true,
      business: {
        _id: business._id,
        businessName: business.businessName,
        address: business.address,
        logo: business.logo,
        phone: business.phone,
        whatsappNumber: business.whatsappNumber
      },
      services,
      bookingSettings: {
        currency: settings?.currency || 'INR',
        timezone: settings?.timezone || 'Asia/Kolkata',
        bookingAdvanceDays: settings?.bookingAdvanceDays || 30,
        bookingAllowedDays: settings?.bookingAllowedDays || null
      }
    });
  } catch (error) {
    console.error('Public book info error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/public/book/:businessId/slots?date=YYYY-MM-DD
router.get('/book/:businessId/slots', async (req, res) => {
  try {
    const { businessId } = req.params;
    const date = String(req.query.date || '').slice(0, 10);
    if (!date) return res.status(400).json({ success: false, message: 'Date is required' });
    const modules = await getBusinessModules(businessId);
    if (!isModuleEnabled(modules, 'bookings')) {
      return res.status(403).json({ success: false, message: 'Online booking is not available' });
    }

    const availability = await getSlotAvailabilityForDate(businessId, date);
    res.json({ success: true, ...availability });
  } catch (error) {
    console.error('Public slots error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/public/book/:businessId — submit booking
router.post('/book/:businessId', bookingLimiter, async (req, res) => {
  try {
    const { businessId } = req.params;
    if (!businessId || !/^[a-f\d]{24}$/i.test(businessId)) {
      return res.status(400).json({ success: false, message: 'Invalid business' });
    }
    const modules = await getBusinessModules(businessId);
    if (!isModuleEnabled(modules, 'bookings')) {
      return res.status(403).json({ success: false, message: 'Online booking is not available' });
    }
    const booking = await createPublicBooking(businessId, req.body);
    res.status(201).json({
      success: true,
      message: 'Booking submitted successfully. You will receive confirmation from the shop.',
      booking: {
        _id: booking._id,
        status: booking.status,
        bookingDate: booking.bookingDate,
        bayNumber: booking.bayNumber
      }
    });
  } catch (error) {
    console.error('Public booking create error:', error);
    sendBookingErrorResponse(error, res, 'Could not create booking');
  }
});

// GET /api/public/invoice/:id/view?token=xxx - view invoice by share token (no auth)
router.get('/invoice/:id/view', async (req, res) => {
  try {
    const { id } = req.params;
    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token required' });
    }
    const invoice = await Invoice.findOne({ _id: id, shareToken: token }).lean();
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const [platform, business] = await Promise.all([
      PlatformSettings.findOne({}).lean(),
      getInvoiceCompanySnapshot(invoice.businessId)
    ]);

    const toPersist = companyFieldsToPersist(invoice, business);
    if (toPersist) {
      await Invoice.updateOne({ _id: id, shareToken: token }, { $set: toPersist });
    }

    const invoiceForView = mergeInvoiceWithCompanySnapshot(invoice, business);
    const currency = platform?.defaultCurrency || 'USD';

    res.json({ success: true, invoice: invoiceForView, currency, business });
  } catch (error) {
    console.error('Public invoice view error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
