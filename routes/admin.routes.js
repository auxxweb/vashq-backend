import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { body, validationResult } from 'express-validator';
import { authenticate, authorize } from '../middleware/auth.middleware.js';
import { uploadBuffer } from '../utils/cloudinary.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import Job from '../models/Job.model.js';
import WhatsAppTemplate from '../models/WhatsAppTemplate.model.js';
import WhatsAppMessage from '../models/WhatsAppMessage.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Notification from '../models/Notification.model.js';
import { generateTokenNumber, calculateETA, canAcceptNewJob, isValidStatusTransition } from '../utils/job.utils.js';
import { sendWhatsAppMessage, formatTemplate } from '../utils/whatsapp.utils.js';
import Business from '../models/Business.model.js';
import SubscriptionPlan from '../models/SubscriptionPlan.model.js';
import ShopSubscription from '../models/ShopSubscription.model.js';
import PlanUpgradeRequest from '../models/PlanUpgradeRequest.model.js';
import HelpArticle from '../models/HelpArticle.model.js';
import Tutorial from '../models/Tutorial.model.js';
import SupportTicket from '../models/SupportTicket.model.js';
import PlatformSettings from '../models/PlatformSettings.model.js';
import User from '../models/User.model.js';
import ExpenseType from '../models/ExpenseType.model.js';
import Expense from '../models/Expense.model.js';
import Invoice, { generateShareToken, generateInvoiceNumber } from '../models/Invoice.model.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Allow CAR_WASH_ADMIN for all; EMPLOYEE for dashboard, jobs, upload, leaderboard, and job-creation data (customers, services, cars, settings)
const allowAdminOrEmployeeForJobs = (req, res, next) => {
  if (req.user.role === 'EMPLOYEE') {
    const p = req.path;
    const allowed =
      p === '/dashboard' || p.startsWith('/dashboard/') ||
      p.startsWith('/jobs') ||
      p.startsWith('/upload') ||
      p === '/leaderboard' ||
      p === '/customers' ||
      p === '/services' ||
      p === '/settings' ||
      p.startsWith('/invoices') ||
      p.startsWith('/cars') ||
      p === '/business' ||
      p === '/my-subscription' ||
      p === '/available-plans' ||
      p.startsWith('/upgrade-request');
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
    }
  } else if (req.user.role !== 'CAR_WASH_ADMIN') {
    return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
  }
  next();
};
router.use(allowAdminOrEmployeeForJobs);

// Middleware to ensure user has businessId
const requireBusiness = (req, res, next) => {
  if (!req.user.businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business not assigned'
    });
  }
  req.businessId = req.user.businessId;
  next();
};

router.use(requireBusiness);

// Multer: max 4 files, 20MB each (client compresses large images; this is a safety limit)
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\//i.test(file.mimetype);
    if (allowed) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  }
});

// @route   POST /api/admin/upload/images
// @desc    Upload job images to Cloudinary (before or after). Send multipart form with field "images" (max 4).
// @access  Private (Car Wash Admin, Employee)
router.post('/upload/images', (req, res, next) => {
  upload.array('images', 4)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: 'Image too large. Maximum 20MB per file.' });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ success: false, message: err.message || 'Invalid upload.' });
      }
      return next(err);
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.files?.length) {
      return res.status(400).json({ success: false, message: 'No images provided' });
    }
    const folder = req.body.folder === 'after' ? 'washq/jobs/after' : req.body.folder === 'expenses' ? 'washq/expenses' : req.body.folder === 'payment' ? 'washq/payment' : 'washq/jobs/before';
    const urls = [];
    for (const file of req.files) {
      const { url } = await uploadBuffer(file.buffer, file.mimetype, folder);
      urls.push(url);
    }
    res.json({ success: true, urls });
  } catch (err) {
    console.error('Upload images error:', err);
    const name = err?.name || '';
    const msg = String(err?.message || '');
    if (name === 'TimeoutError' || /timeout/i.test(msg)) {
      return res.status(504).json({ success: false, message: 'Image upload timed out. Please try again.' });
    }
    res.status(500).json({
      success: false,
      message: err.message || 'Image upload failed'
    });
  }
});

// ==================== EXPENSE TYPES (Car Wash Admin only) ====================
const expenseAdminOnly = (req, res, next) => {
  if (req.user.role !== 'CAR_WASH_ADMIN') {
    return res.status(403).json({ success: false, message: 'Access denied. Admin only.' });
  }
  next();
};

// GET /api/admin/expense-types
router.get('/expense-types', expenseAdminOnly, async (req, res) => {
  try {
    const types = await ExpenseType.find({ businessId: req.businessId }).sort({ expenseName: 1 }).lean();
    res.json({ success: true, expenseTypes: types });
  } catch (error) {
    console.error('List expense types error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/expense-types
router.post('/expense-types', expenseAdminOnly, [
  body('expenseName').notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const expenseType = await ExpenseType.create({
      businessId: req.businessId,
      expenseName: req.body.expenseName.trim()
    });
    res.status(201).json({ success: true, expenseType });
  } catch (error) {
    console.error('Create expense type error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/admin/expense-types/:id
router.put('/expense-types/:id', expenseAdminOnly, [
  body('expenseName').optional().notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const expenseType = await ExpenseType.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!expenseType) {
      return res.status(404).json({ success: false, message: 'Expense type not found' });
    }
    if (req.body.expenseName != null) expenseType.expenseName = req.body.expenseName.trim();
    await expenseType.save();
    res.json({ success: true, expenseType });
  } catch (error) {
    console.error('Update expense type error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/expense-types/:id
router.delete('/expense-types/:id', expenseAdminOnly, async (req, res) => {
  try {
    const expenseType = await ExpenseType.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    if (!expenseType) {
      return res.status(404).json({ success: false, message: 'Expense type not found' });
    }
    res.json({ success: true, message: 'Expense type deleted' });
  } catch (error) {
    console.error('Delete expense type error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== EXPENSES (Car Wash Admin only) ====================

// GET /api/admin/expenses?range=today|weekly|monthly|yearly|custom&from=&to=
function parseExpenseDateRange(range, from, to) {
  const now = new Date();
  let start, end;
  switch (range) {
    case 'today':
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end = new Date(start); end.setDate(end.getDate() + 1);
      break;
    case 'weekly':
      start = new Date(now); start.setDate(start.getDate() - 7); start.setHours(0, 0, 0, 0);
      end = new Date(now); end.setHours(23, 59, 59, 999);
      break;
    case 'monthly':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now); end.setHours(23, 59, 59, 999);
      break;
    case 'yearly':
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now); end.setHours(23, 59, 59, 999);
      break;
    case 'custom':
      start = from && to ? new Date(from) : new Date(now); start.setHours(0, 0, 0, 0);
      end = from && to ? new Date(to) : new Date(now); end.setHours(23, 59, 59, 999);
      break;
    default:
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end = new Date(start); end.setDate(end.getDate() + 1);
  }
  return { start, end };
}

router.get('/expenses', expenseAdminOnly, async (req, res) => {
  try {
    const { range = 'today', from, to } = req.query;
    const { start, end } = parseExpenseDateRange(range, from, to);
    const query = { businessId: req.businessId, expenseDate: { $gte: start, $lte: end } };
    const expenses = await Expense.find(query)
      .populate('expenseTypeId', 'expenseName')
      .populate('createdBy', 'name email')
      .sort({ expenseDate: -1, createdAt: -1 })
      .lean();
    const totalAmount = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    res.json({ success: true, expenses, totalAmount, start, end });
  } catch (error) {
    console.error('List expenses error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/expenses - single or multiple entries
router.post('/expenses', expenseAdminOnly, [
  body('expenseDate').optional().isISO8601(),
  body('entries').isArray({ min: 1 }),
  body('entries.*.expenseTypeId').notEmpty(),
  body('entries.*.amount').isFloat({ min: 0 }),
  body('entries.*.notes').optional().trim(),
  body('entries.*.billImage').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const expenseDate = req.body.expenseDate ? new Date(req.body.expenseDate) : new Date();
    expenseDate.setHours(0, 0, 0, 0);
    const created = [];
    for (const entry of req.body.entries) {
      const expenseType = await ExpenseType.findOne({ _id: entry.expenseTypeId, businessId: req.businessId });
      if (!expenseType) {
        return res.status(400).json({ success: false, message: 'Invalid expense type' });
      }
      const exp = await Expense.create({
        businessId: req.businessId,
        expenseTypeId: expenseType._id,
        amount: Number(entry.amount),
        notes: entry.notes || '',
        billImage: entry.billImage || undefined,
        expenseDate,
        createdBy: req.user._id
      });
      await exp.populate('expenseTypeId', 'expenseName');
      created.push(exp);
    }
    res.status(201).json({ success: true, expenses: created });
  } catch (error) {
    console.error('Create expenses error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/admin/expenses/:id
router.put('/expenses/:id', expenseAdminOnly, [
  body('expenseTypeId').optional().notEmpty(),
  body('amount').optional().isFloat({ min: 0 }),
  body('notes').optional().trim(),
  body('billImage').optional().trim(),
  body('expenseDate').optional().isISO8601()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const expense = await Expense.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    if (req.body.expenseTypeId != null) {
      const expenseType = await ExpenseType.findOne({ _id: req.body.expenseTypeId, businessId: req.businessId });
      if (!expenseType) {
        return res.status(400).json({ success: false, message: 'Invalid expense type' });
      }
      expense.expenseTypeId = expenseType._id;
    }
    if (req.body.amount != null) expense.amount = Number(req.body.amount);
    if (req.body.notes !== undefined) expense.notes = req.body.notes || '';
    if (req.body.billImage !== undefined) expense.billImage = req.body.billImage || '';
    if (req.body.expenseDate != null) {
      const d = new Date(req.body.expenseDate);
      d.setHours(0, 0, 0, 0);
      expense.expenseDate = d;
    }
    await expense.save();
    await expense.populate('expenseTypeId', 'expenseName');
    res.json({ success: true, expense });
  } catch (error) {
    console.error('Update expense error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/expenses/:id
router.delete('/expenses/:id', expenseAdminOnly, async (req, res) => {
  try {
    const expense = await Expense.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    res.json({ success: true, message: 'Expense deleted' });
  } catch (error) {
    console.error('Delete expense error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== INVOICES ====================
// POST /api/admin/invoices - create invoice from job (admin or employee)
router.post('/invoices', [
  body('jobId').notEmpty().isMongoId()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const job = await Job.findOne({ _id: req.body.jobId, businessId: req.businessId })
      .populate('customerId', 'name phone whatsappNumber email')
      .populate('carId', 'carNumber model make color brand')
      .populate({ path: 'services.serviceId', model: 'Service', select: 'name price' });
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    const existing = await Invoice.findOne({ jobId: job._id });
    if (existing) {
      return res.json({ success: true, invoice: existing, alreadyExists: true });
    }
    let invoiceNumber = generateInvoiceNumber();
    while (await Invoice.findOne({ businessId: req.businessId, invoiceNumber })) {
      invoiceNumber = generateInvoiceNumber();
    }
    const items = (job.services || []).map((s) => ({
      serviceName: s.serviceId?.name || 'Service',
      servicePrice: s.price ?? 0
    }));
    const subtotal = job.totalPrice ?? items.reduce((sum, i) => sum + i.servicePrice, 0);
    const invoice = await Invoice.create({
      jobId: job._id,
      businessId: req.businessId,
      invoiceNumber,
      companyName: null,
      companyAddress: null,
      companyPhone: null,
      companyGst: null,
      customerName: job.customerId?.name ?? '',
      customerPhone: job.customerId?.phone || job.customerId?.whatsappNumber || '',
      vehicleNumber: job.carId?.carNumber ?? '',
      items,
      discount: 0,
      subtotal,
      finalAmount: subtotal,
      paymentMethod: 'CASH',
      paymentStatus: 'PENDING',
      shareToken: generateShareToken(),
      createdBy: req.user._id
    });
    res.status(201).json({ success: true, invoice });
  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/invoices - list (optional jobId filter)
router.get('/invoices', async (req, res) => {
  try {
    const query = { businessId: req.businessId };
    if (req.query.jobId) query.jobId = req.query.jobId;
    const invoices = await Invoice.find(query).populate('jobId', 'tokenNumber status').sort({ createdAt: -1 }).lean();
    res.json({ success: true, invoices });
  } catch (error) {
    console.error('List invoices error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/invoices/:id
router.get('/invoices/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId })
      .populate('jobId')
      .lean();
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    res.json({ success: true, invoice });
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/admin/invoices/:id
router.put('/invoices/:id', [
  body('companyName').optional().trim(),
  body('companyAddress').optional().trim(),
  body('companyPhone').optional().trim(),
  body('companyGst').optional().trim(),
  body('customerName').optional().trim(),
  body('customerPhone').optional().trim(),
  body('vehicleNumber').optional().trim(),
  body('discount').optional().isFloat({ min: 0 }),
  body('finalAmount').optional().isFloat({ min: 0 }),
  body('taxPercentage').optional().isFloat({ min: 0, max: 100 }),
  body('gstAmount').optional().isFloat({ min: 0 }),
  body('paymentMethod').optional().isIn(['CASH', 'ONLINE'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    if (invoice.paymentStatus === 'RECEIVED') {
      return res.status(403).json({ success: false, message: 'Invoice is closed. No further edits allowed.' });
    }
    const allowed = ['companyName', 'companyAddress', 'companyPhone', 'companyGst', 'customerName', 'customerPhone', 'vehicleNumber', 'discount', 'finalAmount', 'taxPercentage', 'gstAmount', 'paymentMethod'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) invoice[key] = req.body[key];
    }
    if (req.body.finalAmount !== undefined) invoice.finalAmount = Number(req.body.finalAmount);
    if (req.body.discount !== undefined) invoice.discount = Number(req.body.discount);
    if (req.body.taxPercentage !== undefined) invoice.taxPercentage = Number(req.body.taxPercentage);
    if (req.body.gstAmount !== undefined) invoice.gstAmount = Number(req.body.gstAmount);
    await invoice.save();
    const updated = await Invoice.findById(invoice._id).populate('jobId').lean();
    res.json({ success: true, invoice: updated });
  } catch (error) {
    console.error('Update invoice error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/invoices/:id/share-url
router.get('/invoices/:id/share-url', async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    if (!invoice.shareToken) {
      invoice.shareToken = generateShareToken();
      await invoice.save();
    }
    const envBaseUrl = (process.env.FRONTEND_URL || '').trim();
    const originHeader = (req.get('origin') || '').trim();
    const refererHeader = (req.get('referer') || '').trim();
    const refererBase = refererHeader ? (() => {
      try {
        const u = new URL(refererHeader);
        return u.origin;
      } catch {
        return '';
      }
    })() : '';
    const requestBase = `${req.protocol}://${req.get('host')}`;
    const baseUrl = (envBaseUrl || originHeader || refererBase || requestBase || 'http://localhost:3000').replace(/\/$/, '');
    const viewUrl = `${baseUrl}/invoice/${invoice._id}/view?token=${invoice.shareToken}`;
    res.json({ success: true, viewUrl });
  } catch (error) {
    console.error('Share URL error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/invoices/:id/close-job - set payment received & close job (DELIVERED)
router.patch('/invoices/:id/close-job', async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    invoice.paymentStatus = 'RECEIVED';
    invoice.paymentReceivedAt = new Date();
    await invoice.save();
    await Job.findOneAndUpdate(
      { _id: invoice.jobId, businessId: req.businessId },
      { $set: { status: 'DELIVERED', actualDelivery: new Date() } }
    );
    res.json({ success: true, message: 'Job closed' });
  } catch (error) {
    console.error('Close job error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== REPORTS (Car Wash Admin only) ====================
function parseReportDateRange(range, from, to) {
  const now = new Date();
  let start, end;
  switch (range) {
    case 'daily':
    case 'today':
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end = new Date(start); end.setDate(end.getDate() + 1);
      break;
    case 'weekly':
      start = new Date(now); start.setDate(start.getDate() - 7); start.setHours(0, 0, 0, 0);
      end = new Date(now); end.setHours(23, 59, 59, 999);
      break;
    case 'monthly':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now); end.setHours(23, 59, 59, 999);
      break;
    case 'yearly':
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now); end.setHours(23, 59, 59, 999);
      break;
    case 'custom':
      start = from && to ? new Date(from) : new Date(now); start.setHours(0, 0, 0, 0);
      end = from && to ? new Date(to) : new Date(now); end.setHours(23, 59, 59, 999);
      break;
    default:
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end = new Date(start); end.setDate(end.getDate() + 1);
  }
  return { start, end };
}

// GET /api/admin/reports/jobs?range=daily|weekly|monthly|yearly|custom&from=&to=
router.get('/reports/jobs', expenseAdminOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to } = req.query;
    const { start, end } = parseReportDateRange(range, from, to);
    const jobs = await Job.find({
      businessId: req.businessId,
      createdAt: { $gte: start, $lte: end }
    })
      .populate('customerId', 'name phone email')
      .populate('carId', 'registrationNumber model make color')
      .populate('assignedTo', 'name email employeeCode')
      .populate({ path: 'services.serviceId', model: 'Service', select: 'name' })
      .sort({ createdAt: -1 })
      .lean();
    const summary = {
      totalJobs: jobs.length,
      totalRevenue: jobs.filter(j => ['COMPLETED', 'DELIVERED'].includes(j.status)).reduce((s, j) => s + (j.totalPrice || 0), 0),
      byStatus: jobs.reduce((acc, j) => { acc[j.status] = (acc[j.status] || 0) + 1; return acc; }, {})
    };
    res.json({ success: true, data: jobs, summary, start, end });
  } catch (error) {
    console.error('Reports jobs error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/employees?range=...&from=&to= (revenue = sum of invoice final amount for delivered jobs)
router.get('/reports/employees', expenseAdminOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to } = req.query;
    const { start, end } = parseReportDateRange(range, from, to);
    const employees = await User.find({ businessId: req.businessId, role: 'EMPLOYEE', status: 'ACTIVE' })
      .select('name email employeeCode')
      .lean();
    const report = await Promise.all(employees.map(async (emp) => {
      const jobs = await Job.find({
        businessId: req.businessId,
        assignedTo: emp._id,
        createdAt: { $gte: start, $lte: end }
      }).select('status _id createdAt actualDelivery').lean();
      const completed = jobs.filter(j => ['COMPLETED', 'DELIVERED'].includes(j.status));
      const completedJobIds = completed.map(j => j._id);
      const invoices = await Invoice.find({
        businessId: req.businessId,
        jobId: { $in: completedJobIds }
      }).select('finalAmount').lean();
      const totalRevenue = Math.round(invoices.reduce((s, inv) => s + (inv.finalAmount || 0), 0) * 100) / 100;
      const withDelivery = jobs.filter(j => j.actualDelivery);
      const avgCompletionMinutes = withDelivery.length > 0
        ? Math.round(withDelivery.reduce((s, j) => s + (j.actualDelivery - new Date(j.createdAt)) / (1000 * 60), 0) / withDelivery.length)
        : 0;
      return {
        employeeId: emp._id,
        employeeName: emp.name || emp.email,
        email: emp.email,
        employeeCode: emp.employeeCode,
        totalJobsAssigned: jobs.length,
        completedJobs: completed.length,
        totalRevenue,
        avgCompletionMinutes,
        statusCounts: jobs.reduce((acc, j) => { acc[j.status] = (acc[j.status] || 0) + 1; return acc; }, {})
      };
    }));
    res.json({ success: true, data: report, start, end });
  } catch (error) {
    console.error('Reports employees error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/expenses?range=...&from=&to=
router.get('/reports/expenses', expenseAdminOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to } = req.query;
    const { start, end } = parseReportDateRange(range, from, to);
    const expenses = await Expense.find({
      businessId: req.businessId,
      expenseDate: { $gte: start, $lte: end }
    })
      .populate('expenseTypeId', 'expenseName')
      .populate('createdBy', 'name email')
      .sort({ expenseDate: -1, createdAt: -1 })
      .lean();
    const totalAmount = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    res.json({ success: true, data: expenses, totalAmount, summary: { totalExpenses: expenses.length, totalAmount }, start, end });
  } catch (error) {
    console.error('Reports expenses error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/sales?range=...&from=&to= (sales = invoices; revenue = sum of invoice final amount)
router.get('/reports/sales', expenseAdminOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to } = req.query;
    const { start, end } = parseReportDateRange(range, from, to);
    // Get invoices whose job was delivered in date range (use job.actualDelivery or job.updatedAt for "sale date")
    const deliveredJobIds = await Job.find({
      businessId: req.businessId,
      status: 'DELIVERED',
      $or: [
        { actualDelivery: { $gte: start, $lte: end } },
        { updatedAt: { $gte: start, $lte: end }, actualDelivery: { $exists: false } }
      ]
    }).distinct('_id');
    const invoices = await Invoice.find({
      businessId: req.businessId,
      jobId: { $in: deliveredJobIds }
    })
      .populate({
        path: 'jobId',
        populate: [
          { path: 'customerId', select: 'name phone email' },
          { path: 'carId', select: 'registrationNumber carNumber model make color' },
          { path: 'assignedTo', select: 'name email employeeCode' },
          { path: 'services.serviceId', model: 'Service', select: 'name' }
        ]
      })
      .sort({ createdAt: -1 })
      .lean();
    const totalRevenue = invoices.reduce((s, inv) => s + (inv.finalAmount || 0), 0);
    const totalDiscountAmount = invoices.reduce((s, inv) => {
      const sub = inv.subtotal || 0;
      const pct = inv.discount || 0;
      return s + (sub * (pct / 100));
    }, 0);
    const totalGst = invoices.reduce((s, inv) => s + (inv.gstAmount || 0), 0);
    res.json({
      success: true,
      data: invoices,
      summary: {
        totalSales: invoices.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalDiscountAmount: Math.round(totalDiscountAmount * 100) / 100,
        totalGst: Math.round(totalGst * 100) / 100
      },
      start,
      end
    });
  } catch (error) {
    console.error('Reports sales error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== DASHBOARD ====================

// @route   GET /api/admin/dashboard
// @desc    Fast dashboard stats only (KPIs). Use /admin/dashboard/charts for lazy-loaded charts.
// @access  Private (Car Wash Admin, Employee)
router.get('/dashboard', async (req, res) => {
  try {
    const businessId = req.businessId;
    const isEmployee = req.user.role === 'EMPLOYEE';
    const baseMatch = { businessId: new mongoose.Types.ObjectId(businessId) };
    if (isEmployee) baseMatch.assignedTo = req.user._id;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    // Single aggregation for all job stats (parallel in one pipeline)
    const [jobStats, avgResult, todayRevResult, monthRevResult, todayExpResult] = await Promise.all([
      Job.aggregate([
        { $match: baseMatch },
        {
          $facet: {
            todayJobs: [
              { $match: { createdAt: { $gte: today, $lt: tomorrow } } },
              { $count: 'count' }
            ],
            inProgress: [
              { $match: { status: { $nin: ['COMPLETED', 'DELIVERED', 'CANCELLED'] } } },
              { $count: 'count' }
            ],
            pendingDeliveries: [
              { $match: { status: 'COMPLETED' } },
              { $count: 'count' }
            ]
          }
        }
      ]).then((r) => r[0] || {}),
      Job.aggregate([
        { $match: { ...baseMatch, status: 'DELIVERED', actualDelivery: { $exists: true } } },
        {
          $group: {
            _id: null,
            avgMinutes: { $avg: { $divide: [{ $subtract: ['$actualDelivery', '$createdAt'] }, 60000] } }
          }
        }
      ]),
      Invoice.aggregate([
        { $match: { businessId: new mongoose.Types.ObjectId(businessId) } },
        {
          $lookup: {
            from: 'jobs',
            let: { jid: '$jobId' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$_id', '$$jid'] },
                  status: 'DELIVERED',
                  $or: [
                    { actualDelivery: { $gte: today, $lt: tomorrow } },
                    { actualDelivery: { $exists: false }, updatedAt: { $gte: today, $lt: tomorrow } }
                  ]
                }
              },
              { $limit: 1 }
            ],
            as: 'job'
          }
        },
        { $match: { job: { $ne: [] } } },
        { $group: { _id: null, total: { $sum: '$finalAmount' } } }
      ]),
      Invoice.aggregate([
        { $match: { businessId: new mongoose.Types.ObjectId(businessId) } },
        {
          $lookup: {
            from: 'jobs',
            let: { jid: '$jobId' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$_id', '$$jid'] },
                  status: 'DELIVERED',
                  $or: [
                    { actualDelivery: { $gte: startOfMonth } },
                    { actualDelivery: { $exists: false }, updatedAt: { $gte: startOfMonth } }
                  ]
                }
              },
              { $limit: 1 }
            ],
            as: 'job'
          }
        },
        { $match: { job: { $ne: [] } } },
        { $group: { _id: null, total: { $sum: '$finalAmount' } } }
      ]),
      isEmployee ? Promise.resolve([]) : Expense.aggregate([
        { $match: { businessId: new mongoose.Types.ObjectId(businessId), expenseDate: { $gte: today, $lt: tomorrow } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    const todayJobs = jobStats.todayJobs?.[0]?.count ?? 0;
    const inProgress = jobStats.inProgress?.[0]?.count ?? 0;
    const pendingDeliveries = jobStats.pendingDeliveries?.[0]?.count ?? 0;
    const avgCompletionTime = Math.round(avgResult[0]?.avgMinutes ?? 0);
    const todayRevenue = Math.round((todayRevResult[0]?.total ?? 0) * 100) / 100;
    const monthlyRevenue = Math.round((monthRevResult[0]?.total ?? 0) * 100) / 100;
    const todayExpenses = todayExpResult[0]?.total ?? 0;
    const closingBalance = !isEmployee ? (todayRevenue - todayExpenses) : 0;

    const statsPayload = {
      todayJobs,
      inProgress,
      avgCompletionTime,
      pendingDeliveries,
      isEmployee: !!isEmployee
    };
    if (!isEmployee) {
      statsPayload.todayRevenue = todayRevenue;
      statsPayload.monthlyRevenue = monthlyRevenue;
      statsPayload.todayExpenses = todayExpenses;
      statsPayload.closingBalance = closingBalance;
    } else {
      statsPayload.todayRevenue = 0;
      statsPayload.monthlyRevenue = 0;
      statsPayload.todayExpenses = 0;
      statsPayload.closingBalance = 0;
    }

    res.json({ success: true, stats: statsPayload, isEmployee: !!isEmployee });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/dashboard/charts
// @desc    Lazy-loaded charts: revenue trend + services distribution
// @access  Private (Car Wash Admin, Employee)
router.get('/dashboard/charts', async (req, res) => {
  try {
    const businessId = req.businessId;
    const isEmployee = req.user.role === 'EMPLOYEE';
    const baseMatch = { businessId: new mongoose.Types.ObjectId(businessId) };
    if (isEmployee) baseMatch.assignedTo = req.user._id;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Revenue trend: run 7 day queries in parallel
    const revenuePromises = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      revenuePromises.push(
        Invoice.aggregate([
          { $match: { businessId: new mongoose.Types.ObjectId(businessId) } },
          {
            $lookup: {
              from: 'jobs',
              let: { jid: '$jobId' },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ['$_id', '$$jid'] },
                    status: 'DELIVERED',
                    $or: [
                      { actualDelivery: { $gte: d, $lt: next } },
                      { actualDelivery: { $exists: false }, updatedAt: { $gte: d, $lt: next } }
                    ]
                  }
                },
                { $limit: 1 }
              ],
              as: 'j'
            }
          },
          { $match: { j: { $ne: [] } } },
          { $group: { _id: null, total: { $sum: '$finalAmount' } } }
        ]).then((r) => ({ d, total: r[0]?.total ?? 0 }))
      );
    }
    const revenueResults = await Promise.all(revenuePromises);
    const revenueTrend = revenueResults.map(({ d, total }) => ({
      date: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      revenue: Math.round(total * 100) / 100
    }));

    // Services distribution: single aggregation
    const servicesDist = await Job.aggregate([
      { $match: { ...baseMatch, status: 'DELIVERED' } },
      { $unwind: '$services' },
      { $group: { _id: '$services.serviceId', count: { $sum: 1 } } },
      { $lookup: { from: 'services', localField: '_id', foreignField: '_id', as: 'svc' } },
      { $unwind: { path: '$svc', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: null,
          items: {
            $push: {
              name: { $ifNull: ['$svc.name', 'Other'] },
              value: '$count'
            }
          }
        }
      }
    ]);

    const servicesDistribution = servicesDist[0]?.items ?? [];

    // Job trend for employees: jobs completed per day (last 7 days)
    let jobTrend = [];
    if (isEmployee) {
      const jobPromises = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        d.setHours(0, 0, 0, 0);
        const next = new Date(d);
        next.setDate(next.getDate() + 1);
        jobPromises.push(
          Job.aggregate([
            {
              $match: {
                ...baseMatch,
                status: 'DELIVERED',
                $or: [
                  { actualDelivery: { $gte: d, $lt: next } },
                  { actualDelivery: { $exists: false }, updatedAt: { $gte: d, $lt: next } }
                ]
              }
            },
            { $count: 'count' }
          ]).then((r) => ({ d, count: r[0]?.count ?? 0 }))
        );
      }
      const jobResults = await Promise.all(jobPromises);
      jobTrend = jobResults.map(({ d, count }) => ({
        date: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        jobs: count
      }));
    }

    res.json({
      success: true,
      revenueTrend: isEmployee ? [] : revenueTrend,
      jobTrend,
      servicesDistribution
    });
  } catch (error) {
    console.error('Dashboard charts error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/leaderboard
// @desc    Leaderboard: employees with completed job count and avg completion time (aggregation)
// @access  Private (Car Wash Admin, Employee)
router.get('/leaderboard', async (req, res) => {
  try {
    const businessId = req.businessId;
    const leaderboard = await Job.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          status: 'DELIVERED',
          actualDelivery: { $exists: true },
          assignedTo: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: '$assignedTo',
          count: { $sum: 1 },
          totalMinutes: { $sum: { $divide: [{ $subtract: ['$actualDelivery', '$createdAt'] }, 60000] } }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
          pipeline: [{ $match: { role: 'EMPLOYEE', status: 'ACTIVE' } }, { $project: { name: 1, email: 1, employeeCode: 1 } }]
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          userId: '$_id',
          name: { $ifNull: ['$user.name', '$user.email'] },
          employeeCode: '$user.employeeCode',
          completedCount: '$count',
          avgCompletionMinutes: { $round: [{ $divide: ['$totalMinutes', '$count'] }, 0] }
        }
      },
      { $sort: { completedCount: -1 } }
    ]);
    // Include employees with zero completed jobs
    const empIds = new Set(leaderboard.map((l) => l.userId?.toString()));
    const allEmployees = await User.find({ businessId, role: 'EMPLOYEE', status: 'ACTIVE' })
      .select('name email employeeCode')
      .lean();
    const zeroEmps = allEmployees
      .filter((e) => !empIds.has(e._id.toString()))
      .map((e) => ({
        userId: e._id,
        name: e.name || e.email,
        employeeCode: e.employeeCode,
        completedCount: 0,
        avgCompletionMinutes: 0
      }));
    const combined = [...leaderboard, ...zeroEmps].sort((a, b) => b.completedCount - a.completedCount);
    res.json({ success: true, leaderboard: combined });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== EMPLOYEE MANAGEMENT (Car Wash Admin only) ====================

async function generateEmployeeCode(businessId) {
  const last = await User.findOne({ businessId, role: 'EMPLOYEE' })
    .sort({ employeeCode: -1 })
    .select('employeeCode')
    .lean();
  const num = last?.employeeCode?.replace(/^EMP/i, '') || '0';
  const next = String(parseInt(num, 10) + 1).padStart(3, '0');
  return `EMP${next}`;
}

function randomPassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < length; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// @route   GET /api/admin/employees
// @desc    List employees (business owner only)
// @access  Private (Car Wash Admin)
router.get('/employees', async (req, res) => {
  try {
    const employees = await User.find({ businessId: req.businessId, role: 'EMPLOYEE' })
      .select('name email phone address employeeCode status createdAt')
      .sort({ employeeCode: 1 })
      .lean();
    res.json({ success: true, employees });
  } catch (error) {
    console.error('Get employees error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/admin/employees
// @desc    Create employee (business owner only). Returns plain password once for copying.
// @access  Private (Car Wash Admin)
router.post('/employees', [
  body('name').notEmpty().trim(),
  body('email').isEmail().normalizeEmail(),
  body('password').optional().isLength({ min: 6 }),
  body('phone').optional().trim(),
  body('address').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { name, email, phone, address } = req.body;
    let password = req.body.password;
    if (!password) password = randomPassword(10);

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already in use' });
    }

    const employeeCode = await generateEmployeeCode(req.businessId);
    const user = await User.create({
      name,
      email,
      password,
      role: 'EMPLOYEE',
      businessId: req.businessId,
      phone: phone || '',
      address: address || '',
      employeeCode
    });

    res.status(201).json({
      success: true,
      employee: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: user.address,
        employeeCode: user.employeeCode,
        status: user.status
      },
      temporaryPassword: password,
      message: 'Copy the password now; it will not be shown again.'
    });
  } catch (error) {
    console.error('Create employee error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/employees/:id
// @desc    Get one employee with work performance and reports (business owner only)
// @access  Private (Car Wash Admin)
router.get('/employees/:id', async (req, res) => {
  try {
    const user = await User.findOne({
      _id: req.params.id,
      businessId: req.businessId,
      role: 'EMPLOYEE'
    }).select('-password').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const employeeId = user._id;
    const businessId = req.businessId;

    const deliveredJobs = await Job.find({
      businessId,
      assignedTo: employeeId,
      status: 'DELIVERED',
      actualDelivery: { $exists: true }
    }).select('createdAt actualDelivery totalPrice').lean();

    const completedCount = deliveredJobs.length;
    let avgCompletionMinutes = 0;
    if (deliveredJobs.length > 0) {
      const totalMin = deliveredJobs.reduce((sum, j) => {
        return sum + (new Date(j.actualDelivery) - new Date(j.createdAt)) / (1000 * 60);
      }, 0);
      avgCompletionMinutes = Math.round(totalMin / deliveredJobs.length);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const todayJobs = await Job.countDocuments({
      businessId,
      assignedTo: employeeId,
      createdAt: { $gte: today, $lt: tomorrow }
    });
    const monthJobs = await Job.countDocuments({
      businessId,
      assignedTo: employeeId,
      createdAt: { $gte: startOfMonth }
    });
    const inProgress = await Job.countDocuments({
      businessId,
      assignedTo: employeeId,
      status: { $nin: ['COMPLETED', 'DELIVERED', 'CANCELLED'] }
    });
    const pendingDeliveries = await Job.countDocuments({
      businessId,
      assignedTo: employeeId,
      status: 'COMPLETED'
    });

    const last7DaysJobs = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      const count = await Job.countDocuments({
        businessId,
        assignedTo: employeeId,
        createdAt: { $gte: d, $lt: next }
      });
      last7DaysJobs.push({
        date: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        jobs: count
      });
    }

    const recentJobs = await Job.find({
      businessId,
      assignedTo: employeeId
    })
      .populate('customerId', 'name phone')
      .populate('carId', 'carNumber')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    res.json({
      success: true,
      employee: user,
      performance: {
        completedCount,
        avgCompletionMinutes,
        todayJobs,
        monthJobs,
        inProgress,
        pendingDeliveries,
        jobsTrend: last7DaysJobs
      },
      recentJobs
    });
  } catch (error) {
    console.error('Get employee error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PUT /api/admin/employees/:id
// @desc    Update employee (business owner only). Optionally set new password and get it back.
// @access  Private (Car Wash Admin)
router.put('/employees/:id', [
  body('name').optional().notEmpty().trim(),
  body('email').optional().isEmail().normalizeEmail(),
  body('password').optional().isLength({ min: 6 }),
  body('phone').optional().trim(),
  body('address').optional().trim(),
  body('status').optional().isIn(['ACTIVE', 'SUSPENDED', 'INACTIVE'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const user = await User.findOne({
      _id: req.params.id,
      businessId: req.businessId,
      role: 'EMPLOYEE'
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    if (req.body.name != null) user.name = req.body.name;
    if (req.body.phone != null) user.phone = req.body.phone;
    if (req.body.address != null) user.address = req.body.address;
    if (req.body.status != null) user.status = req.body.status;
    if (req.body.email != null) {
      const existing = await User.findOne({ email: req.body.email, _id: { $ne: user._id } });
      if (existing) return res.status(400).json({ success: false, message: 'Email already in use' });
      user.email = req.body.email;
    }
    let temporaryPassword = null;
    if (req.body.password) {
      temporaryPassword = req.body.password;
      user.password = req.body.password;
    }
    await user.save();
    const out = {
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: user.address,
      employeeCode: user.employeeCode,
      status: user.status
    };
    if (temporaryPassword) {
      res.json({ success: true, employee: out, temporaryPassword, message: 'Copy the new password if needed.' });
    } else {
      res.json({ success: true, employee: out });
    }
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   DELETE /api/admin/employees/:id
// @desc    Delete employee (business owner only)
// @access  Private (Car Wash Admin)
router.delete('/employees/:id', async (req, res) => {
  try {
    const user = await User.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId,
      role: 'EMPLOYEE'
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    res.json({ success: true, message: 'Employee deleted' });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/admin/employees/:id/reset-password
// @desc    Generate new password for employee and return it (business owner only)
// @access  Private (Car Wash Admin)
router.post('/employees/:id/reset-password', async (req, res) => {
  try {
    const user = await User.findOne({
      _id: req.params.id,
      businessId: req.businessId,
      role: 'EMPLOYEE'
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    const newPassword = randomPassword(10);
    user.password = newPassword;
    await user.save();
    res.json({
      success: true,
      temporaryPassword: newPassword,
      message: 'Copy the new password and share it with the employee.'
    });
  } catch (error) {
    console.error('Reset employee password error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== CUSTOMER MANAGEMENT ====================

// @route   GET /api/admin/customers
// @desc    Get customers (search, pagination)
// @access  Private (Car Wash Admin)
router.get('/customers', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const query = { businessId: req.businessId };
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: term, $options: 'i' } },
        { phone: { $regex: term, $options: 'i' } },
        { whatsappNumber: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } }
      ];
    }

    const total = await Customer.countDocuments(query);
    const customers = await Customer.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();

    const customersWithStats = await Promise.all(
      customers.map(async (customer) => {
        const carsCount = await Car.countDocuments({ customerId: customer._id });
        const jobsCount = await Job.countDocuments({ customerId: customer._id });
        return {
          ...customer,
          stats: { cars: carsCount, jobs: jobsCount }
        };
      })
    );

    res.json({
      success: true,
      customers: customersWithStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)) || 0
      }
    });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/admin/customers
// @desc    Create new customer
// @access  Private (Car Wash Admin)
router.post('/customers', [
  body('name').notEmpty().trim(),
  body('phone').notEmpty(),
  body('whatsappNumber').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const customer = await Customer.create({
      ...req.body,
      businessId: req.businessId
    });

    res.status(201).json({
      success: true,
      customer
    });
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/admin/customers/:id
// @desc    Update customer
// @access  Private (Car Wash Admin)
router.put('/customers/:id', [
  body('name').optional().notEmpty().trim(),
  body('phone').optional().notEmpty(),
  body('whatsappNumber').optional().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }
    res.json({
      success: true,
      customer
    });
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/admin/customers/:id
// @desc    Delete customer
// @access  Private (Car Wash Admin)
router.delete('/customers/:id', async (req, res) => {
  try {
    const customer = await Customer.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    res.json({
      success: true,
      message: 'Customer deleted successfully'
    });
  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== CAR MANAGEMENT ====================

// @route   GET /api/admin/cars
// @desc    Get all cars (search, filter by customerId, pagination)
// @access  Private (Car Wash Admin)
router.get('/cars', async (req, res) => {
  try {
    const { customerId, search, page = 1, limit = 20 } = req.query;
    const query = { businessId: req.businessId };
    if (customerId) query.customerId = customerId;
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const customerIds = await Customer.find({ businessId: req.businessId, name: { $regex: term, $options: 'i' } }).distinct('_id');
      query.$or = [
        { carNumber: { $regex: term, $options: 'i' } },
        { brand: { $regex: term, $options: 'i' } },
        { model: { $regex: term, $options: 'i' } },
        { color: { $regex: term, $options: 'i' } },
        { customerId: { $in: customerIds } }
      ];
    }
    const total = await Car.countDocuments(query);
    const cars = await Car.find(query)
      .populate('customerId', 'name phone')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();
    res.json({
      success: true,
      cars,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) || 0 }
    });
  } catch (error) {
    console.error('Get cars error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/admin/cars
// @desc    Create new car
// @access  Private (Car Wash Admin)
router.post('/cars', [
  body('customerId').notEmpty(),
  body('carNumber').notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    // Verify customer belongs to business
    const customer = await Customer.findOne({
      _id: req.body.customerId,
      businessId: req.businessId
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    const car = await Car.create({
      ...req.body,
      businessId: req.businessId
    });

    res.status(201).json({
      success: true,
      car
    });
  } catch (error) {
    console.error('Create car error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/admin/cars/:id
// @desc    Update car
// @access  Private (Car Wash Admin)
router.put('/cars/:id', [
  body('carNumber').optional().notEmpty().trim(),
  body('customerId').optional().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    if (req.body.customerId) {
      const customer = await Customer.findOne({
        _id: req.body.customerId,
        businessId: req.businessId
      });
      if (!customer) {
        return res.status(404).json({
          success: false,
          message: 'Customer not found'
        });
      }
    }
    const car = await Car.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!car) {
      return res.status(404).json({
        success: false,
        message: 'Car not found'
      });
    }
    res.json({
      success: true,
      car
    });
  } catch (error) {
    console.error('Update car error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/admin/cars/:id
// @desc    Delete car
// @access  Private (Car Wash Admin)
router.delete('/cars/:id', async (req, res) => {
  try {
    const car = await Car.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId
    });

    if (!car) {
      return res.status(404).json({
        success: false,
        message: 'Car not found'
      });
    }

    res.json({
      success: true,
      message: 'Car deleted successfully'
    });
  } catch (error) {
    console.error('Delete car error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== SERVICE MANAGEMENT ====================

// @route   GET /api/admin/services
// @desc    Get all services (search, pagination)
// @access  Private (Car Wash Admin)
router.get('/services', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const query = { businessId: req.businessId };
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } }
      ];
    }
    const total = await Service.countDocuments(query);
    const services = await Service.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();
    res.json({
      success: true,
      services,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) || 0 }
    });
  } catch (error) {
    console.error('Get services error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/admin/services
// @desc    Create new service
// @access  Private (Car Wash Admin)
router.post('/services', [
  body('name').notEmpty().trim(),
  body('price').isFloat({ min: 0 }),
  body('minTime').optional().isInt({ min: 0 }),
  body('maxTime').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const service = await Service.create({
      ...req.body,
      businessId: req.businessId
    });

    res.status(201).json({
      success: true,
      service
    });
  } catch (error) {
    console.error('Create service error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/admin/services/:id
// @desc    Update service
// @access  Private (Car Wash Admin)
router.put('/services/:id', [
  body('name').optional().notEmpty().trim(),
  body('price').optional().isFloat({ min: 0 }),
  body('minTime').optional().isInt({ min: 0 }),
  body('maxTime').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const service = await Service.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }
    res.json({
      success: true,
      service
    });
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/admin/services/:id
// @desc    Delete service
// @access  Private (Car Wash Admin)
router.delete('/services/:id', async (req, res) => {
  try {
    const service = await Service.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId
    });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    res.json({
      success: true,
      message: 'Service deleted successfully'
    });
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== JOB MANAGEMENT ====================

// @route   GET /api/admin/jobs/:id
// @desc    Get single job
// @access  Private (Car Wash Admin)
router.get('/jobs/:id', async (req, res) => {
  try {
    const filter = { _id: req.params.id, businessId: req.businessId };
    if (req.user.role === 'EMPLOYEE') {
      filter.assignedTo = req.user._id;
    }
    const job = await Job.findOne(filter)
      .populate('customerId', 'name phone whatsappNumber')
      .populate('carId', 'carNumber brand model color')
      .populate('services.serviceId', 'name')
      .populate('assignedTo', 'name employeeCode email');

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    res.json({
      success: true,
      job
    });
  } catch (error) {
    console.error('Get job error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/admin/jobs
// @desc    Get all jobs (search, filter by status, pagination)
// @access  Private (Car Wash Admin)
router.get('/jobs', async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const query = { businessId: req.businessId };
    // Employee sees only jobs assigned to them
    if (req.user.role === 'EMPLOYEE') {
      query.assignedTo = req.user._id;
    }
    if (status && status !== 'ALL') {
      query.status = status;
    }
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const businessCustomerIds = await Customer.find({ businessId: req.businessId }).distinct('_id');
      const customerIds = await Customer.find({
        businessId: req.businessId,
        $or: [
          { name: { $regex: term, $options: 'i' } },
          { phone: { $regex: term, $options: 'i' } }
        ]
      }).distinct('_id');
      const carIds = await Car.find({
        customerId: { $in: businessCustomerIds },
        carNumber: { $regex: term, $options: 'i' }
      }).distinct('_id');
      query.$or = [
        { tokenNumber: { $regex: term, $options: 'i' } },
        { customerId: { $in: customerIds } },
        { carId: { $in: carIds } }
      ];
    }

    const jobs = await Job.find(query)
      .populate('customerId', 'name phone whatsappNumber')
      .populate('carId', 'carNumber brand model color')
      .populate('services.serviceId', 'name')
      .populate('assignedTo', 'name employeeCode email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const deliveredIds = jobs.filter(j => j.status === 'DELIVERED').map(j => j._id);
    let invoiceFinalByJob = {};
    if (deliveredIds.length > 0) {
      const invoices = await Invoice.find({ businessId: req.businessId, jobId: { $in: deliveredIds } }).select('jobId finalAmount').lean();
      invoices.forEach(inv => { invoiceFinalByJob[inv.jobId?.toString()] = inv.finalAmount; });
    }
    const jobsWithFinal = jobs.map(j => {
      const out = { ...j };
      if (j.status === 'DELIVERED' && invoiceFinalByJob[j._id.toString()] != null) {
        out.invoiceFinalAmount = invoiceFinalByJob[j._id.toString()];
      }
      return out;
    });

    const total = await Job.countDocuments(query);

    res.json({
      success: true,
      jobs: jobsWithFinal,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/admin/jobs
// @desc    Create new job
// @access  Private (Car Wash Admin)
router.post('/jobs', [
  body('customerId').notEmpty().withMessage('Customer is required'),
  body('carId').notEmpty().withMessage('Car is required'),
  body('serviceIds').isArray({ min: 1 }).withMessage('At least one service is required'),
  body('createWithoutImages').optional().toBoolean(),
  body('beforeImages').optional().isArray(),
  body('notes').optional().trim(),
  body('estimatedDelivery').optional().isISO8601(),
  body('assignedTo').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid employee')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const errList = errors.array();
      const firstMsg = errList[0]?.msg || errList[0]?.message || 'Validation failed';
      return res.status(400).json({
        success: false,
        message: firstMsg,
        errors: errList
      });
    }

    const { customerId, carId, serviceIds, beforeImages, notes, estimatedDelivery: estimatedDeliveryBody, assignedTo: assignedToBody } = req.body;

    // Check capacity
    const capacityCheck = await canAcceptNewJob(req.businessId);
    if (!capacityCheck.canAccept) {
      return res.status(400).json({
        success: false,
        message: capacityCheck.reason
      });
    }

    // Verify customer and car belong to business
    const customer = await Customer.findOne({
      _id: customerId,
      businessId: req.businessId
    });

    const car = await Car.findOne({
      _id: carId,
      businessId: req.businessId,
      customerId: customerId
    });

    if (!customer || !car) {
      return res.status(404).json({
        success: false,
        message: 'Customer or car not found'
      });
    }

    // Fetch services - convert IDs for reliable $in match, accept active or unset isActive
    const serviceIdsObj = serviceIds.map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (serviceIdsObj.length !== serviceIds.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid service ID format'
      });
    }

    const businessIdObj = typeof req.businessId === 'string'
      ? new mongoose.Types.ObjectId(req.businessId)
      : req.businessId;

    // Use unique IDs for lookup (handles duplicates); build job services from original order
    const uniqueIds = [...new Set(serviceIdsObj.map((id) => id.toString()))].map((id) => new mongoose.Types.ObjectId(id));
    const servicesFound = await Service.find({
      _id: { $in: uniqueIds },
      businessId: businessIdObj,
      isActive: { $ne: false }
    });

    if (servicesFound.length !== uniqueIds.length) {
      const foundIds = new Set(servicesFound.map((s) => s._id.toString()));
      const missingIds = uniqueIds.filter((id) => !foundIds.has(id.toString()));
      return res.status(400).json({
        success: false,
        message: 'One or more services not found. Ensure services exist, are active, and belong to your business.',
        missingServiceIds: missingIds.map((id) => id.toString())
      });
    }

    const serviceMap = new Map(servicesFound.map((s) => [s._id.toString(), s]));
    const services = serviceIdsObj.map((id) => serviceMap.get(id.toString())).filter(Boolean);

    // Calculate total price and ETA (use body value if provided and valid, else calculate from services)
    const totalPrice = services.reduce((sum, s) => sum + s.price, 0);
    const estimatedDelivery = (estimatedDeliveryBody && !isNaN(Date.parse(estimatedDeliveryBody)))
      ? new Date(estimatedDeliveryBody)
      : calculateETA(services);

    // Create job with retry logic for duplicate token numbers
    let job;
    let attempts = 0;
    const maxAttempts = 5;
    
    while (attempts < maxAttempts) {
      try {
        // Generate token number
        const tokenNumber = await generateTokenNumber(req.businessId);

        // assignedTo: optional; if employee creates without specifying, can assign to self
        let assignedTo = assignedToBody || null;
        if (req.user.role === 'EMPLOYEE' && !assignedTo) {
          assignedTo = req.user._id;
        }
        if (assignedTo) {
          const emp = await User.findOne({ _id: assignedTo, businessId: req.businessId, role: 'EMPLOYEE' });
          if (!emp) assignedTo = null;
        }

        // Create job
        job = await Job.create({
          businessId: req.businessId,
          customerId,
          carId,
          tokenNumber,
          totalPrice,
          estimatedDelivery,
          beforeImages: Array.isArray(beforeImages) ? beforeImages : [],
          notes,
          assignedTo,
          services: services.map(s => ({
            serviceId: s._id,
            price: s.price
          })),
          statusHistory: [{
            status: 'RECEIVED',
            changedAt: new Date()
          }]
        });
        
        // Success - break out of retry loop
        break;
      } catch (createError) {
        // Check if it's a duplicate key error (code 11000)
        if (createError.code === 11000 && attempts < maxAttempts - 1) {
          attempts++;
          // Wait a small random amount to avoid simultaneous retries
          await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
          continue; // Retry with new token
        }
        // If not a duplicate key error or max attempts reached, throw
        throw createError;
      }
    }
    
    if (!job) {
      throw new Error('Failed to create job after multiple attempts');
    }

    // Populate for response
    await job.populate('customerId', 'name phone whatsappNumber');
    await job.populate('carId', 'carNumber brand model color');
    await job.populate('services.serviceId', 'name');

    // Send WhatsApp notification
    try {
      const template = await WhatsAppTemplate.findOne({
        $or: [
          { businessId: req.businessId, name: 'Job Received', isActive: true },
          { isGlobal: true, name: 'Job Received', isActive: true }
        ]
      });

      if (template) {
        const message = formatTemplate(template.template, {
          customerName: customer.name,
          carNumber: car.carNumber,
          tokenNumber: job.tokenNumber,
          estimatedTime: estimatedDelivery.toLocaleTimeString()
        });

        const whatsappResult = await sendWhatsAppMessage(
          customer.whatsappNumber,
          message,
          template._id
        );

        await WhatsAppMessage.create({
          businessId: req.businessId,
          jobId: job._id,
          templateId: template._id,
          recipient: customer.whatsappNumber,
          message,
          status: whatsappResult.success ? 'SENT' : 'FAILED',
          sentAt: whatsappResult.success ? new Date() : null
        });
      }
    } catch (whatsappError) {
      console.error('WhatsApp send error:', whatsappError);
      // Don't fail job creation if WhatsApp fails
    }

    res.status(201).json({
      success: true,
      job
    });
  } catch (error) {
    console.error('Create job error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/admin/jobs/:id/status
// @desc    Update job status
// @access  Private (Car Wash Admin)
router.patch('/jobs/:id/status', [
  body('status').isIn(['RECEIVED', 'WORK_STARTED', 'COMPLETED', 'DELIVERED', 'CANCELLED']),
  body('notes').optional().isString(),
  body('afterImages').optional().isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { status, notes, afterImages } = req.body;

    const jobFilter = { _id: req.params.id, businessId: req.businessId };
    if (req.user.role === 'EMPLOYEE') {
      jobFilter.assignedTo = req.user._id;
    }
    const job = await Job.findOne(jobFilter).populate('customerId', 'name whatsappNumber').populate('carId', 'carNumber');

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    // Validate status transition
    if (!isValidStatusTransition(job.status, status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status transition'
      });
    }

    // Update job
    job.status = status;
    if (afterImages) job.afterImages = afterImages;
    if (status === 'DELIVERED') job.actualDelivery = new Date();
    
    job.statusHistory.push({
      status,
      notes,
      changedAt: new Date()
    });

    await job.save();

    // Send WhatsApp notification
    try {
      const template = await WhatsAppTemplate.findOne({
        $or: [
          { businessId: req.businessId, name: `Job ${status}`, isActive: true },
          { isGlobal: true, name: `Job ${status}`, isActive: true }
        ]
      });

      if (template) {
        const message = formatTemplate(template.template, {
          customerName: job.customerId.name,
          carNumber: job.carId.carNumber,
          tokenNumber: job.tokenNumber,
          status,
          totalPrice: job.totalPrice.toString()
        });

        await sendWhatsAppMessage(
          job.customerId.whatsappNumber,
          message,
          template._id
        );

        await WhatsAppMessage.create({
          businessId: req.businessId,
          jobId: job._id,
          templateId: template._id,
          recipient: job.customerId.whatsappNumber,
          message,
          status: 'SENT',
          sentAt: new Date()
        });
      }
    } catch (whatsappError) {
      console.error('WhatsApp send error:', whatsappError);
    }

    await job.populate('customerId', 'name phone whatsappNumber');
    await job.populate('carId', 'carNumber brand model color');
    await job.populate('services.serviceId', 'name');

    res.json({
      success: true,
      job
    });
  } catch (error) {
    console.error('Update job status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== NOTIFICATIONS ====================

// @route   GET /api/admin/notifications
// @desc    Get all notifications for business
// @access  Private (Car Wash Admin)
router.get('/notifications', async (req, res) => {
  try {
    const notifications = await Notification.find({ businessId: req.businessId })
      .sort({ createdAt: -1 })
      .limit(100);

    const unreadCount = await Notification.countDocuments({
      businessId: req.businessId,
      isRead: false
    });

    res.json({
      success: true,
      notifications,
      unreadCount
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/admin/notifications/:id/read
// @desc    Mark notification as read
// @access  Private (Car Wash Admin)
router.patch('/notifications/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      notification
    });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/admin/notifications/read-all
// @desc    Mark all notifications as read
// @access  Private (Car Wash Admin)
router.patch('/notifications/read-all', async (req, res) => {
  try {
    await Notification.updateMany(
      { businessId: req.businessId, isRead: false },
      { isRead: true }
    );

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== BUSINESS MANAGEMENT ====================

// @route   GET /api/admin/business
// @desc    Get business information
// @access  Private (Car Wash Admin)
router.get('/business', async (req, res) => {
  try {
    const business = await Business.findById(req.businessId);
    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }

    res.json({
      success: true,
      business
    });
  } catch (error) {
    console.error('Get business error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/admin/business
// @desc    Update business information
// @access  Private (Car Wash Admin)
router.put('/business', [
  body('businessName').optional().trim(),
  body('ownerName').optional().trim(),
  body('email').optional().isEmail(),
  body('phone').optional(),
  body('whatsappNumber').optional(),
  body('address').optional(),
  body('location').optional(),
  body('workingHoursStart').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('workingHoursEnd').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('carHandlingCapacity').optional().isIn(['SINGLE', 'MULTIPLE']),
  body('maxConcurrentJobs').optional().isInt({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const business = await Business.findByIdAndUpdate(
      req.businessId,
      req.body,
      { new: true, runValidators: true }
    );

    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }

    res.json({
      success: true,
      business
    });
  } catch (error) {
    console.error('Update business error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== SETTINGS ====================

const DEFAULT_WHATSAPP_TEMPLATES = {
  received: 'Hello {{name}}, your vehicle {{vehicleNumber}} has been received. Token: {{token}}',
  inProgress: 'Your car {{vehicleNumber}} is now in progress.',
  washing: 'Your car {{vehicleNumber}} is currently being washed.',
  drying: 'Your car {{vehicleNumber}} is being dried.',
  completed: '✅ Your car wash for {{vehicleNumber}} is completed.',
  delivered: '🚗 Thank you! Your vehicle {{vehicleNumber}} has been delivered.'
};

// @route   GET /api/admin/settings
// @desc    Get business settings
// @access  Private (Car Wash Admin)
router.get('/settings', async (req, res) => {
  try {
    let settings = await BusinessSettings.findOne({ businessId: req.businessId });

    if (!settings) {
      settings = await BusinessSettings.create({
        businessId: req.businessId,
        workingHours: { start: '09:00', end: '18:00' },
        capacity: 5,
        currency: 'USD',
        timezone: 'UTC',
        autoSendWhatsApp: true,
        notificationPreferences: {
          jobCreated: true,
          jobCompleted: true,
          jobDelivered: true,
          planExpiry: true
        },
        whatsappTemplates: DEFAULT_WHATSAPP_TEMPLATES
      });
    }
    const settingsObj = settings.toObject ? settings.toObject() : settings;
    if (!settingsObj.whatsappTemplates || typeof settingsObj.whatsappTemplates !== 'object') {
      settingsObj.whatsappTemplates = { ...DEFAULT_WHATSAPP_TEMPLATES };
    } else {
      settingsObj.whatsappTemplates = { ...DEFAULT_WHATSAPP_TEMPLATES, ...settingsObj.whatsappTemplates };
    }
    // Currency is set only by super admin; always return platform default currency
    const platform = await PlatformSettings.findOne({}).lean();
    if (platform?.defaultCurrency) {
      settingsObj.currency = platform.defaultCurrency;
    }
    if (platform?.defaultPhoneDialCode) {
      settingsObj.defaultPhoneDialCode = platform.defaultPhoneDialCode;
    }
    if (platform?.defaultPhoneCountryIso2) {
      settingsObj.defaultPhoneCountryIso2 = platform.defaultPhoneCountryIso2;
    }
    res.json({
      success: true,
      settings: settingsObj
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/admin/settings
// @desc    Update business settings
// @access  Private (Car Wash Admin)
router.put('/settings', [
  body('capacity').optional().isInt({ min: 1 }),
  body('timezone').optional().isString(),
  body('autoSendWhatsApp').optional(),
  body('workingHours').optional(),
  body('notificationPreferences').optional(),
  body('shopWhatsappNumber').optional().trim().isString(),
  body('googleReviewLink').optional().trim().isString(),
  body('whatsappTemplates').optional().isObject(),
  body('whatsappTemplates.received').optional().isString(),
  body('whatsappTemplates.inProgress').optional().isString(),
  body('whatsappTemplates.washing').optional().isString(),
  body('whatsappTemplates.drying').optional().isString(),
  body('whatsappTemplates.completed').optional().isString(),
  body('whatsappTemplates.delivered').optional().isString(),
  body('upiId').optional().trim().isString(),
  body('qrCodeImage').optional().trim().isString(),
  body('paymentMobileNumber').optional().trim().isString(),
  body('gstNumber').optional({ nullable: true }).trim().isString(),
  body('taxPercentage').optional({ nullable: true }).isFloat({ min: 0, max: 100 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const updateFields = {};
    if (req.body.capacity !== undefined) updateFields.capacity = req.body.capacity;
    if (req.body.timezone !== undefined) updateFields.timezone = req.body.timezone;
    if (req.body.autoSendWhatsApp !== undefined) updateFields.autoSendWhatsApp = req.body.autoSendWhatsApp;
    if (req.body.workingHours !== undefined) updateFields.workingHours = req.body.workingHours;
    if (req.body.notificationPreferences !== undefined) updateFields.notificationPreferences = req.body.notificationPreferences;
    if (req.body.shopWhatsappNumber !== undefined) updateFields.shopWhatsappNumber = req.body.shopWhatsappNumber?.trim() || null;
    if (req.body.googleReviewLink !== undefined) updateFields.googleReviewLink = req.body.googleReviewLink?.trim() || null;
    if (req.body.whatsappTemplates !== undefined) updateFields.whatsappTemplates = req.body.whatsappTemplates;
    if (req.body.upiId !== undefined) updateFields.upiId = req.body.upiId?.trim() || null;
    if (req.body.qrCodeImage !== undefined) updateFields.qrCodeImage = req.body.qrCodeImage?.trim() || null;
    if (req.body.paymentMobileNumber !== undefined) updateFields.paymentMobileNumber = req.body.paymentMobileNumber?.trim() || null;
    if (req.body.gstNumber !== undefined) {
      updateFields.gstNumber = req.body.gstNumber?.trim() || null;
      if (!updateFields.gstNumber) updateFields.taxPercentage = null;
    }
    if (req.body.taxPercentage !== undefined) updateFields.taxPercentage = req.body.taxPercentage;

    let settings = await BusinessSettings.findOne({ businessId: req.businessId });
    if (!settings) {
      settings = await BusinessSettings.create({
        businessId: req.businessId,
        workingHours: { start: '09:00', end: '18:00' },
        capacity: 5,
        currency: 'USD',
        timezone: 'UTC',
        autoSendWhatsApp: true,
        notificationPreferences: {
          jobCreated: true,
          jobCompleted: true,
          jobDelivered: true,
          planExpiry: true
        },
        ...updateFields
      });
    } else {
      settings = await BusinessSettings.findOneAndUpdate(
        { businessId: req.businessId },
        { $set: updateFields },
        { new: true }
      );
    }
    const settingsObj = settings.toObject ? settings.toObject() : settings;
    res.json({
      success: true,
      settings: settingsObj
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== MANUAL SUBSCRIPTION ====================

// Ensure at least one active SubscriptionPlan exists (default "Free Tier")
// so Car Wash Admin "My Plan" shows plans even if Super Admin only added plans in "Plans & Pricing".
async function ensureDefaultSubscriptionPlan() {
  const count = await SubscriptionPlan.countDocuments();
  if (count > 0) return;
  await SubscriptionPlan.create({
    name: 'Free Tier',
    description: 'Default free plan for new shops',
    validityDays: 14,
    features: ['Basic access'],
    isActive: true,
    isFreeTrial: true
  });
}

// @route   GET /api/admin/my-subscription
// @desc    Get current shop subscription
// @access  Private (Car Wash Admin)
router.get('/my-subscription', async (req, res) => {
  try {
    await ensureDefaultSubscriptionPlan();
    let subscription = await ShopSubscription.findOne({ shopId: req.businessId })
      .populate('planId', 'name description validityDays features isActive isFreeTrial price');
    if (!subscription) {
      const business = await Business.findById(req.businessId).select('freeTrialUsed').lean();
      const skipFreeTrial = business?.freeTrialUsed === true;
      const defaultPlanQuery = { isActive: true };
      if (skipFreeTrial) defaultPlanQuery.isFreeTrial = { $ne: true };
      const defaultPlan = await SubscriptionPlan.findOne(defaultPlanQuery).sort({ validityDays: 1 });
      if (!defaultPlan) {
        return res.json({
          success: true,
          subscription: null,
          message: skipFreeTrial ? 'No paid plans available. Contact admin.' : 'No plans available. Contact admin.'
        });
      }
      const startDate = new Date();
      const expiryDate = new Date(startDate);
      expiryDate.setDate(expiryDate.getDate() + defaultPlan.validityDays);
      subscription = await ShopSubscription.create({
        shopId: req.businessId,
        planId: defaultPlan._id,
        startDate,
        expiryDate,
        status: 'ACTIVE'
      });
      await subscription.populate('planId', 'name description validityDays features isActive isFreeTrial price');
    }
    const subObj = subscription.toObject ? subscription.toObject() : subscription;
    if (subObj.expiryDate && new Date(subObj.expiryDate) < new Date() && subObj.status === 'ACTIVE') {
      await ShopSubscription.updateOne(
        { _id: subscription._id },
        { status: 'EXPIRED' }
      );
      subObj.status = 'EXPIRED';
    }
    const business = await Business.findById(req.businessId).select('freeTrialUsed').lean();
    const freeTrialUsed = business?.freeTrialUsed === true;
    const hasPendingUpgrade = await PlanUpgradeRequest.exists({ shopId: req.businessId, status: 'PENDING' });
    const canRequestUpgrade = !freeTrialUsed && !hasPendingUpgrade;
    res.json({ success: true, subscription: subObj, canRequestUpgrade });
  } catch (error) {
    console.error('Get my-subscription error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/available-plans
// @desc    List active subscription plans (for upgrade request). Free tier is excluded when free trial is used or when shop has requested a higher plan (pending upgrade).
// @access  Private (Car Wash Admin)
router.get('/available-plans', async (req, res) => {
  try {
    await ensureDefaultSubscriptionPlan();
    const business = await Business.findById(req.businessId).select('freeTrialUsed').lean();
    const freeTrialUsed = business?.freeTrialUsed === true;
    const hasPendingUpgrade = await PlanUpgradeRequest.exists({ shopId: req.businessId, status: 'PENDING' });
    const hideFreeTier = freeTrialUsed || hasPendingUpgrade;
    const query = { isActive: true };
    if (hideFreeTier) query.isFreeTrial = { $ne: true };
    const plans = await SubscriptionPlan.find(query).sort({ validityDays: 1 });
    res.json({ success: true, plans });
  } catch (error) {
    console.error('Get available plans error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/upgrade-requests
// @desc    Get current shop's upgrade requests (to show pending status)
// @access  Private (Car Wash Admin)
router.get('/upgrade-requests', async (req, res) => {
  try {
    const requests = await PlanUpgradeRequest.find({ shopId: req.businessId })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('currentPlanId', 'name')
      .populate('requestedPlanId', 'name validityDays');
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Get upgrade requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/admin/upgrade-request
// @desc    Submit plan upgrade request
// @access  Private (Car Wash Admin)
router.post('/upgrade-request', [
  body('requestedPlanId').notEmpty(),
  body('message').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const subscription = await ShopSubscription.findOne({ shopId: req.businessId })
      .populate('planId', 'name');
    if (!subscription) {
      return res.status(400).json({ success: false, message: 'No active subscription found' });
    }
    const pending = await PlanUpgradeRequest.findOne({
      shopId: req.businessId,
      status: 'PENDING'
    });
    if (pending) {
      return res.status(400).json({
        success: false,
        message: 'You already have a pending upgrade request. Wait for admin approval.'
      });
    }
    const requestedPlan = await SubscriptionPlan.findById(req.body.requestedPlanId);
    if (!requestedPlan || !requestedPlan.isActive) {
      return res.status(400).json({ success: false, message: 'Invalid or inactive plan' });
    }
    const business = await Business.findById(req.businessId).select('freeTrialUsed').lean();
    const isFreeTrialPlan = requestedPlan.isFreeTrial === true || (requestedPlan.name && /free tier/i.test(requestedPlan.name));
    if (business?.freeTrialUsed && isFreeTrialPlan) {
      return res.status(400).json({ success: false, message: 'Free trial is no longer available for your account.' });
    }
    const request = await PlanUpgradeRequest.create({
      shopId: req.businessId,
      currentPlanId: subscription.planId._id,
      requestedPlanId: req.body.requestedPlanId,
      message: req.body.message || undefined,
      status: 'PENDING'
    });
    await request.populate('currentPlanId', 'name');
    await request.populate('requestedPlanId', 'name validityDays features');
    res.status(201).json({ success: true, request });
  } catch (error) {
    console.error('Create upgrade request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== HELP & SUPPORT (Car Wash Admin) ====================

// @route   GET /api/admin/support/help-articles
// @desc    Get published help articles (with optional search and category filter)
// @access  Private (Car Wash Admin)
router.get('/support/help-articles', async (req, res) => {
  try {
    const { search = '', category = '' } = req.query;
    const query = { isPublished: true };
    if (category && category.trim()) query.category = new RegExp(category.trim(), 'i');
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { title: searchRegex },
        { content: searchRegex }
      ];
    }
    const articles = await HelpArticle.find(query).sort({ order: 1, createdAt: -1 });
    res.json({ success: true, articles });
  } catch (error) {
    console.error('Get help articles error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/support/tutorials
// @desc    Get published tutorials (with optional search)
// @access  Private (Car Wash Admin)
router.get('/support/tutorials', async (req, res) => {
  try {
    const { search = '' } = req.query;
    const query = { isPublished: true };
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { title: searchRegex },
        { description: searchRegex }
      ];
    }
    const tutorials = await Tutorial.find(query).sort({ order: 1, createdAt: -1 });
    res.json({ success: true, tutorials });
  } catch (error) {
    console.error('Get tutorials error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/support/tickets
// @desc    Get support tickets for current business
// @access  Private (Car Wash Admin)
router.get('/support/tickets', async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ businessId: req.businessId })
      .populate('replies.repliedBy', 'email')
      .sort({ createdAt: -1 });
    res.json({ success: true, tickets });
  } catch (error) {
    console.error('Get tickets error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/support/tickets/:id
// @desc    Get single ticket (own business only)
// @access  Private (Car Wash Admin)
router.get('/support/tickets/:id', async (req, res) => {
  try {
    const ticket = await SupportTicket.findOne({
      _id: req.params.id,
      businessId: req.businessId
    }).populate('replies.repliedBy', 'email');
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    res.json({ success: true, ticket });
  } catch (error) {
    console.error('Get ticket error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/admin/support/tickets
// @desc    Create support ticket
// @access  Private (Car Wash Admin)
router.post('/support/tickets', [
  body('subject').notEmpty().trim(),
  body('description').notEmpty().trim(),
  body('priority').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const ticket = await SupportTicket.create({
      businessId: req.businessId,
      subject: req.body.subject,
      description: req.body.description,
      priority: req.body.priority || 'MEDIUM',
      createdBy: req.user._id,
      status: 'OPEN'
    });
    res.status(201).json({ success: true, ticket });
  } catch (error) {
    console.error('Create ticket error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
