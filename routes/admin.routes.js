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
import { resolveJobServiceLines, jobLinesToInvoiceItems, syncDraftInvoiceFromJob, syncJobFromInvoiceItems, recalculateInvoiceFinalAmount, applyInvoiceItemPriceUpdates } from '../utils/jobServiceLines.js';
import {
  assertDirectBillEligible,
  createInvoiceForJobRecord,
  directBillStatusHistory,
  finalizeDirectBillSale,
  WASH_JOB_FILTER
} from '../utils/directBillJob.js';
import { loadDashboardStats } from '../services/dashboardStatsService.js';
import { getDashboardServicesDistribution } from '../utils/dashboardServicesDistribution.js';
import { getDashboardUnclosedInvoices } from '../utils/dashboardUnclosedInvoices.js';
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
import Branch from '../models/Branch.model.js';
import BranchSubscription from '../models/BranchSubscription.model.js';
import BranchCreationRequest from '../models/BranchCreationRequest.model.js';
import ExpenseType from '../models/ExpenseType.model.js';
import Expense from '../models/Expense.model.js';
import Invoice, { generateShareToken, generateInvoiceNumber } from '../models/Invoice.model.js';
import CustomerPackage from '../models/CustomerPackage.model.js';
import PackageVisit from '../models/PackageVisit.model.js';
import { sendPushNotification } from '../services/notificationService.js';
import { getZonedDayBoundsUtc } from '../utils/zonedDayBounds.js';
import { parseBusinessDateRange, applyCreatedAtRange, applyDateFieldRange } from '../utils/businessDateRange.js';
import { balanceDue, assertSettlementMatchesDue, normalizeInvoicePaymentFields, relabelLockedInvoicePaymentMethod, roundMoney } from '../utils/invoicePayment.js';
import { rejectLockedFinancialBodyFields, applyOpenInvoiceFinancialFields } from '../utils/invoiceCheckout.js';
import { normalizeCreditCheckoutPayment } from '../utils/creditPayment.js';
import { normalizeJobAdvanceForCreate } from '../utils/jobAdvance.js';
import { invoiceSettlementCashOnline } from '../utils/paymentChannelAmounts.js';
import { resolveExpensePaymentFields, sumExpenseChannelTotals } from '../utils/expensePayment.js';
import OwnerTask from '../models/OwnerTask.model.js';
import SettlementChangeRequest from '../models/SettlementChangeRequest.model.js';
import { applySettlementDateChange } from '../utils/settlementChange.js';
import { cacheGetOrSet } from '../utils/cache.js';
import { customerSearchOrClauses, distinctCustomerIdsBySearch, escapeRegex } from '../utils/searchUtils.js';
import { invoiceStatusFilterClause } from '../utils/invoiceListFilter.js';
import {
  buildDeliveredJobSalesFilter,
  mapJobInvoiceForSalesReport,
  normalizeSalesReportSource,
  shouldIncludeJobSales,
  shouldIncludePackageSales
} from '../utils/salesReportFilter.js';
import {
  assertCustomerPhoneAvailable,
  normalizePhone,
  isDuplicatePhoneError
} from '../utils/customer.utils.js';
import creditRoutes from './credit.routes.js';
import { isCreditSettlementMode, closeJobOnCredit } from '../services/credit/creditInvoiceService.js';
import { aggregateOutstandingByCustomer } from '../services/credit/outstandingService.js';
import { buildCollectionReport, buildOutstandingReport, getCreditDashboardStats, getTodayCashReceived } from '../services/credit/creditReportsService.js';
import {
  getInvoiceCompanySnapshot,
  mergeInvoiceWithCompanySnapshot,
  companyFieldsToPersist
} from '../utils/invoiceCompany.js';
import { DEFAULT_WHATSAPP_TEMPLATES, normalizeWhatsappTemplates } from '../utils/whatsappTemplates.js';
import { DateTime } from 'luxon';
import { resolveBranchContext, branchFilter } from '../middleware/branchContext.middleware.js';
import { moduleDisabledResponse } from '../middleware/businessModules.middleware.js';
import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';
import { ensureDefaultBranchForBusiness, getBranchOverviewStats, getBranchUsageStats, isBranchOperational, submitBranchRenewalRequest, branchLicenseNeedsRenewal } from '../services/branchService.js';
import { getBranchPlatformConfig } from '../utils/branchConfig.js';
import { applyBranchScopeOid, applyBranchScope } from '../utils/branchQuery.js';
import { scopedFilter, assertBranchAccess, assertInvoiceCheckoutAccess, findScoped, branchIdForCreate, jobAccessFilter } from '../utils/branchAccess.js';
import { isAdminPanelRole, isBranchAdmin, isBusinessOwner } from '../utils/adminRoles.js';
import { adminPanelOnly } from '../middleware/adminPanel.middleware.js';
import { generateEmployeeCode } from '../utils/employeeAccount.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import {
  ensureDefaultSubscriptionPlan,
  isFreeTrialPlan,
  invalidateSubscriptionCache
} from '../services/subscriptionService.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// -------------------- PUSH NOTIFICATIONS (BUSINESS OWNERS ONLY) --------------------
// POST /api/admin/push/fcm-token
// Body: { token: string }
// Stores token only for CAR_WASH_ADMIN
router.post('/push/fcm-token', [
  body('token').notEmpty().isString().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only admin users can register push tokens' });
    }
    const token = String(req.body.token).trim();
    // Add token and cap list size to keep it sane
    await User.updateOne(
      { _id: req.user._id },
      {
        $addToSet: { fcmTokens: token },
      }
    );
    // Optional cap to last 20 tokens
    await User.updateOne(
      { _id: req.user._id },
      [{ $set: { fcmTokens: { $slice: ['$fcmTokens', -20] } } }]
    ).catch(() => {});
    res.json({ success: true, message: 'Token saved' });
  } catch (e) {
    console.error('Save FCM token error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Allow CAR_WASH_ADMIN for all; EMPLOYEE for dashboard, jobs, upload, leaderboard, and job-creation data (customers, services, cars, settings)
const allowAdminOrEmployeeForJobs = (req, res, next) => {
  if (req.user.role === 'EMPLOYEE') {
    const p = req.path;
    if (p === '/business' && req.method === 'GET') {
      return next();
    }
    const allowed =
      p === '/dashboard' || p.startsWith('/dashboard/') ||
      p.startsWith('/jobs') ||
      p.startsWith('/upload') ||
      p === '/leaderboard' ||
      p === '/customers' ||
      p === '/services' ||
      p === '/settings' ||
      p.startsWith('/packages') ||
      p.startsWith('/notifications') ||
      p.startsWith('/invoices') ||
      p.startsWith('/cars') ||
      p.startsWith('/expenses') ||
      p === '/expense-types' ||
      p === '/my-subscription' ||
      p === '/available-plans' ||
      p.startsWith('/upgrade-request') ||
      p.startsWith('/settlement-change-requests');
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
    }
  } else if (!isAdminPanelRole(req.user.role)) {
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

router.use(resolveBranchContext);

router.use(async (req, res, next) => {
  if (!req.businessId) return next();
  try {
    const modules = req.businessModules || await getBusinessModules(req.businessId);
    req.businessModules = modules;
    const p = req.path;
    if (/^\/reports\/(trial-balance|profit-loss|sales-expenses)/.test(p) && !isModuleEnabled(modules, 'accounting')) {
      return moduleDisabledResponse(res, 'accounting');
    }
    if (/^\/reports\/(collections|outstanding)/.test(p) && !isModuleEnabled(modules, 'credit')) {
      return moduleDisabledResponse(res, 'credit');
    }
    if (p.startsWith('/credit') && !isModuleEnabled(modules, 'credit')) {
      return moduleDisabledResponse(res, 'credit');
    }
    if (
      (p.startsWith('/expenses') || p === '/expense-types') &&
      !isModuleEnabled(modules, 'accounting')
    ) {
      return moduleDisabledResponse(res, 'accounting');
    }
    if (p.startsWith('/reports/visits') && !isModuleEnabled(modules, 'packages')) {
      return moduleDisabledResponse(res, 'packages');
    }
    if (p.startsWith('/reports/expenses') && !isModuleEnabled(modules, 'accounting')) {
      return moduleDisabledResponse(res, 'accounting');
    }
    next();
  } catch (err) {
    next(err);
  }
});

router.use(enforceActiveSubscription());

router.use('/credit', creditRoutes);

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
    const isEmployee = req.user.role === 'EMPLOYEE';
    const folderKey = req.body.folder === 'after' ? 'after' : req.body.folder === 'expenses' ? 'expenses' : req.body.folder === 'payment' ? 'payment' : 'before';
    if (isEmployee && folderKey === 'payment') {
      return res.status(403).json({ success: false, message: 'Employees cannot upload payment proof images.' });
    }
    const folder = folderKey === 'after' ? 'washq/jobs/after' : folderKey === 'expenses' ? 'washq/expenses' : folderKey === 'payment' ? 'washq/payment' : 'washq/jobs/before';
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

// ==================== OWNER TASKS (Car Wash Admin only) ====================
function computedTaskStatus(task, now = new Date()) {
  const endAt = task?.endAt ? new Date(task.endAt) : null;
  const completedAt = task?.completedAt ? new Date(task.completedAt) : null;
  if (task?.status === 'COMPLETED') {
    const early = !!(completedAt && endAt && completedAt.getTime() + 30_000 < endAt.getTime()); // 30s tolerance
    return early ? 'EARLY' : 'COMPLETED';
  }
  if (endAt && endAt.getTime() < now.getTime()) return 'OVERDUE';
  return 'PENDING';
}

// GET /api/admin/tasks?from=ISO&to=ISO
router.get('/tasks', adminPanelOnly, async (req, res) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const q = { businessId: req.businessId };
    if (from && !Number.isNaN(from.getTime())) q.endAt = { ...(q.endAt || {}), $gte: from };
    if (to && !Number.isNaN(to.getTime())) q.startAt = { ...(q.startAt || {}), $lte: to };
    const tasks = await OwnerTask.find(q).sort({ startAt: 1 }).lean();
    const now = new Date();
    const out = tasks.map((t) => ({ ...t, computedStatus: computedTaskStatus(t, now) }));
    res.json({ success: true, tasks: out });
  } catch (e) {
    console.error('List tasks error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/tasks
router.post('/tasks', adminPanelOnly, [
  body('title').notEmpty().trim().isLength({ max: 120 }),
  body('description').optional().trim().isLength({ max: 2000 }),
  body('endAt').notEmpty().isISO8601()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const errList = errors.array();
      const firstMsg = errList[0]?.msg || errList[0]?.message || 'Validation failed';
      return res.status(400).json({ success: false, message: firstMsg, errors: errList });
    }
    const endAt = new Date(req.body.endAt);
    const startAt = req.body.startAt ? new Date(req.body.startAt) : new Date(endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid time' });
    }
    if (endAt.getTime() < startAt.getTime()) {
      return res.status(400).json({ success: false, message: 'End time must be after start time' });
    }
    const task = await OwnerTask.create({
      businessId: req.businessId,
      title: String(req.body.title).trim(),
      description: String(req.body.description || '').trim(),
      startAt,
      endAt,
      status: 'PENDING',
      createdBy: req.user._id
    });
    const out = task.toObject();
    out.computedStatus = computedTaskStatus(out, new Date());
    res.status(201).json({ success: true, task: out });
  } catch (e) {
    console.error('Create task error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/tasks/:id - update fields (title/description/startAt/endAt) when pending
router.patch('/tasks/:id', adminPanelOnly, [
  body('title').optional().trim().isLength({ min: 1, max: 120 }),
  body('description').optional().trim().isLength({ max: 2000 }),
  body('endAt').optional().isISO8601(),
  body('status').optional().isIn(['PENDING', 'COMPLETED'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const task = await OwnerTask.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const nextStatus = req.body.status;
    if (nextStatus === 'COMPLETED') {
      if (task.status !== 'COMPLETED') {
        task.status = 'COMPLETED';
        task.completedAt = new Date();
      }
    } else if (nextStatus === 'PENDING') {
      task.status = 'PENDING';
      task.completedAt = null;
      task.reminderSentAt = null; // allow reminder again if rescheduled
    }

    if (task.status === 'COMPLETED' && (req.body.title || req.body.description || req.body.startAt || req.body.endAt)) {
      return res.status(403).json({ success: false, message: 'Completed tasks are read-only (reopen to edit)' });
    }

    if (req.body.title !== undefined) task.title = String(req.body.title).trim();
    if (req.body.description !== undefined) task.description = String(req.body.description).trim();
    if (req.body.endAt !== undefined) task.endAt = new Date(req.body.endAt);
    // If startAt is not being used by client, keep it aligned with endAt for day grouping.
    if (req.body.endAt !== undefined && (req.body.startAt === undefined || req.body.startAt === null || req.body.startAt === '')) {
      task.startAt = new Date(task.endAt);
    }
    if (task.endAt.getTime() < task.startAt.getTime()) {
      return res.status(400).json({ success: false, message: 'End time must be after start time' });
    }
    await task.save();
    const out = task.toObject();
    out.computedStatus = computedTaskStatus(out, new Date());
    res.json({ success: true, task: out });
  } catch (e) {
    console.error('Update task error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/expense-types
// GET /api/admin/expense-types (read-only for employees)
router.get('/expense-types', async (req, res) => {
  try {
    const types = await ExpenseType.find({ businessId: req.businessId }).sort({ expenseName: 1 }).lean();
    res.json({ success: true, expenseTypes: types });
  } catch (error) {
    console.error('List expense types error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/expense-types
router.post('/expense-types', adminPanelOnly, [
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
router.put('/expense-types/:id', adminPanelOnly, [
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
router.delete('/expense-types/:id', adminPanelOnly, async (req, res) => {
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

async function loadBusinessDateRange(businessId, range, from = '', to = '') {
  const settings = await BusinessSettings.findOne({ businessId }).select('timezone').lean();
  return parseBusinessDateRange(settings?.timezone, range, from, to);
}

// GET /api/admin/expenses?range=today|weekly|monthly|yearly|custom&from=&to=
function parseExpenseDateRange(range, from, to, businessTz) {
  if (businessTz !== undefined) {
    const { startUtc, endUtc } = parseBusinessDateRange(businessTz, range, from, to);
    return { start: startUtc, end: endUtc, exclusiveEnd: true };
  }
  const now = new Date();
  let start, end;
  switch (range) {
    case 'today':
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end = new Date(start); end.setDate(end.getDate() + 1);
      break;
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      start = new Date(y); start.setHours(0, 0, 0, 0);
      end = new Date(start); end.setDate(end.getDate() + 1);
      break;
    }
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
  return { start, end, exclusiveEnd: false };
}

router.get('/expenses', async (req, res) => {
  try {
    const { range = 'today', from, to, search, expenseTypeId } = req.query;
    const settings = await BusinessSettings.findOne({ businessId: req.businessId }).select('timezone').lean();
    const { start, end, exclusiveEnd } = parseExpenseDateRange(range, from, to, settings?.timezone);
    const query = scopedFilter(req, { expenseDate: dateRangeQuery(start, end, exclusiveEnd) });
    if (expenseTypeId && String(expenseTypeId).trim()) {
      query.expenseTypeId = String(expenseTypeId).trim();
    }
    if (search && typeof search === 'string' && search.trim()) {
      const termRaw = search.trim();
      const term = termRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const or = [
        { notes: { $regex: term, $options: 'i' } },
      ];
      const asNumber = Number(termRaw);
      if (!Number.isNaN(asNumber)) {
        or.push({ amount: asNumber });
      }
      const typeIds = await ExpenseType.find({
        businessId: req.businessId,
        expenseName: { $regex: term, $options: 'i' }
      }).distinct('_id');
      if (typeIds?.length) {
        or.push({ expenseTypeId: { $in: typeIds } });
      }
      query.$or = or;
    }
    const expenses = await Expense.find(query)
      .populate('expenseTypeId', 'expenseName')
      .populate('createdBy', 'name email')
      .sort({ expenseDate: -1, createdAt: -1 })
      .lean();
    const totals = sumExpenseChannelTotals(expenses);
    res.json({
      success: true,
      expenses,
      totalAmount: totals.totalAmount,
      totalCashAmount: totals.totalCashAmount,
      totalOnlineAmount: totals.totalOnlineAmount,
      start,
      end
    });
  } catch (error) {
    console.error('List expenses error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/expenses - single or multiple entries
router.post('/expenses', [
  body('expenseDate').optional().isISO8601(),
  body('entries').isArray({ min: 1 }),
  body('entries.*.expenseTypeId').notEmpty(),
  body('entries.*.amount').isFloat({ min: 0.01 }),
  body('entries.*.notes').optional().trim(),
  body('entries.*.billImage').optional().trim(),
  body('entries.*.paymentMethod').optional().isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('entries.*.paymentCashAmount').optional().isFloat({ min: 0 }),
  body('entries.*.paymentOnlineAmount').optional().isFloat({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0]?.msg || 'Validation failed',
        errors: errors.array()
      });
    }
    const expenseDate = req.body.expenseDate ? new Date(req.body.expenseDate) : new Date();
    expenseDate.setHours(0, 0, 0, 0);
    const typeIds = [...new Set(req.body.entries.map((e) => String(e.expenseTypeId)))];
    const expenseTypes = await ExpenseType.find({
      _id: { $in: typeIds },
      businessId: req.businessId
    }).lean();
    const typeById = new Map(expenseTypes.map((t) => [String(t._id), t]));
    const created = [];
    for (const entry of req.body.entries) {
      const expenseType = typeById.get(String(entry.expenseTypeId));
      if (!expenseType) {
        return res.status(400).json({ success: false, message: 'Invalid expense type' });
      }
      let paymentFields;
      try {
        paymentFields = resolveExpensePaymentFields(Number(entry.amount), {
          paymentMethod: entry.paymentMethod,
          paymentCashAmount: entry.paymentCashAmount,
          paymentOnlineAmount: entry.paymentOnlineAmount,
        });
      } catch (payErr) {
        return res.status(payErr.status || 400).json({ success: false, message: payErr.message });
      }
      const exp = await Expense.create({
        businessId: req.businessId,
        branchId: req.branchId || null,
        expenseTypeId: expenseType._id,
        amount: Number(entry.amount),
        notes: entry.notes || '',
        billImage: entry.billImage || undefined,
        expenseDate,
        createdBy: req.user._id,
        ...paymentFields,
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
router.put('/expenses/:id', [
  body('expenseTypeId').optional().notEmpty(),
  body('amount').optional().isFloat({ min: 0.01 }),
  body('notes').optional().trim(),
  body('billImage').optional().trim(),
  body('expenseDate').optional().isISO8601(),
  body('paymentMethod').optional().isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('paymentCashAmount').optional().isFloat({ min: 0 }),
  body('paymentOnlineAmount').optional().isFloat({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0]?.msg || 'Validation failed',
        errors: errors.array()
      });
    }
    const expense = await findScoped(Expense, req, { _id: req.params.id });
    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    assertBranchAccess(req, expense);
    if (req.body.expenseTypeId != null) {
      const expenseType = await ExpenseType.findOne({ _id: req.body.expenseTypeId, businessId: req.businessId });
      if (!expenseType) {
        return res.status(400).json({ success: false, message: 'Invalid expense type' });
      }
      expense.expenseTypeId = expenseType._id;
    }
    if (req.body.amount != null) expense.amount = Number(req.body.amount);
    const paymentTouched =
      req.body.paymentMethod !== undefined ||
      req.body.paymentCashAmount !== undefined ||
      req.body.paymentOnlineAmount !== undefined ||
      req.body.amount != null;
    if (paymentTouched) {
      try {
        const paymentFields = resolveExpensePaymentFields(
          req.body.amount != null ? Number(req.body.amount) : expense.amount,
          {
            paymentMethod: req.body.paymentMethod,
            paymentCashAmount: req.body.paymentCashAmount,
            paymentOnlineAmount: req.body.paymentOnlineAmount,
          },
          expense
        );
        Object.assign(expense, paymentFields);
      } catch (payErr) {
        return res.status(payErr.status || 400).json({ success: false, message: payErr.message });
      }
    }
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
router.delete('/expenses/:id', async (req, res) => {
  try {
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only business owners and branch admins can delete expenses' });
    }
    const expense = await Expense.findOneAndDelete(scopedFilter(req, { _id: req.params.id }));
    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    res.json({ success: true, message: 'Expense deleted' });
  } catch (error) {
    console.error('Delete expense error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

async function backfillCustomerInvoiceLinks(businessId, customerId) {
  const jobIds = await Job.find({ businessId, customerId }).distinct('_id');
  if (!jobIds.length) return;

  await Invoice.updateMany(
    {
      businessId,
      jobId: { $in: jobIds },
      $or: [{ customerId: { $exists: false } }, { customerId: null }]
    },
    { $set: { customerId } }
  );
}

// ==================== INVOICES ====================

const INVOICE_METADATA_FIELDS = [
  'companyName', 'companyOwnerName', 'companyAddress', 'companyPhone', 'companyGst',
  'customerName', 'customerPhone', 'customerGst', 'vehicleNumber'
];

function applyInvoiceMetadataFields(invoice, body) {
  for (const key of INVOICE_METADATA_FIELDS) {
    if (body[key] !== undefined) invoice[key] = body[key];
  }
}

// POST /api/admin/invoices - create invoice from job (admin or employee)
router.post('/invoices', [
  body('jobId').notEmpty().isMongoId()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const job = await Job.findOne(scopedFilter(req, { _id: req.body.jobId }))
      .populate('customerId', 'name phone whatsappNumber email')
      .populate('carId', 'carNumber model make color brand')
      .populate({ path: 'services.serviceId', model: 'Service', select: 'name price isVariable' });
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    assertBranchAccess(req, job, { allowLegacyNull: true });

    const existing = await Invoice.findOne({ jobId: job._id });
    if (existing) {
      return res.json({ success: true, invoice: existing, alreadyExists: true });
    }

    const invoice = await createInvoiceForJobRecord({
      job,
      businessId: req.businessId,
      userId: req.user._id,
      customer: job.customerId,
      car: job.carId,
      catalogServices: (job.services || [])
        .map((s) => s.serviceId)
        .filter((s) => s && typeof s === 'object' && s.name)
    });
    res.status(201).json({ success: true, invoice });
  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// GET /api/admin/invoices - list (optional jobId filter, pagination, search)
router.get('/invoices', async (req, res) => {
  try {
    const { search, page = 1, limit = 20, from, to, jobId, status } = req.query;
    const query = applyBranchScope({ businessId: req.businessId }, req);
    const andClauses = [];

    if (jobId) query.jobId = jobId;

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matchingJobIds = await Job.find(applyBranchScope({
        businessId: req.businessId,
        tokenNumber: { $regex: term, $options: 'i' }
      }, req)).distinct('_id');
      andClauses.push({
        $or: [
          { invoiceNumber: { $regex: term, $options: 'i' } },
          { customerName: { $regex: term, $options: 'i' } },
          { customerPhone: { $regex: term, $options: 'i' } },
          { vehicleNumber: { $regex: term, $options: 'i' } },
          ...(matchingJobIds.length ? [{ jobId: { $in: matchingJobIds } }] : [])
        ]
      });
    }

    const statusClause = invoiceStatusFilterClause(status);
    if (statusClause) andClauses.push(statusClause);

    if (andClauses.length) query.$and = andClauses;

    if ((from && String(from).trim()) || (to && String(to).trim())) {
      const range = {};
      if (from && String(from).trim()) {
        const d = new Date(String(from).trim());
        if (!Number.isNaN(d.getTime())) range.$gte = d;
      }
      if (to && String(to).trim()) {
        const d = new Date(String(to).trim());
        if (!Number.isNaN(d.getTime())) range.$lte = d;
      }
      if (Object.keys(range).length) query.createdAt = range;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const [invoices, total] = await Promise.all([
      Invoice.find(query)
        .populate('jobId', 'tokenNumber status')
        .populate('packageId', 'name')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Invoice.countDocuments(query)
    ]);

    res.json({
      success: true,
      invoices,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1
      }
    });
  } catch (error) {
    console.error('List invoices error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/invoices/:id
router.get('/invoices/:id', async (req, res) => {
  try {
    let invoice = await Invoice.findOne(scopedFilter(req, { _id: req.params.id }))
      .populate({
        path: 'jobId',
        populate: { path: 'services.serviceId', select: 'name isVariable skipWorkProcess' }
      })
      .populate('packageId', 'name')
      .lean();
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    assertBranchAccess(req, invoice, { allowLegacyNull: true });
    const companySnapshot = await getInvoiceCompanySnapshot(req.businessId);
    const toPersist = companyFieldsToPersist(invoice, companySnapshot);
    if (toPersist) {
      await Invoice.updateOne({ _id: req.params.id, businessId: req.businessId }, { $set: toPersist });
      invoice = { ...invoice, ...toPersist };
    }
    invoice = mergeInvoiceWithCompanySnapshot(invoice, companySnapshot);
    if (!invoice.customerId) {
      const cid = invoice.jobId?.customerId?._id || invoice.jobId?.customerId;
      if (cid) {
        invoice.customerId = cid;
        await Invoice.updateOne({ _id: invoice._id }, { $set: { customerId: cid } });
      }
    }
    res.json({ success: true, invoice, business: companySnapshot });
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
  body('customerGst').optional().trim(),
  body('vehicleNumber').optional().trim(),
  body('discount').optional().isFloat({ min: 0 }),
  body('finalAmount').optional().isFloat({ min: 0 }),
  body('taxPercentage').optional().isFloat({ min: 0, max: 100 }),
  body('gstAmount').optional().isFloat({ min: 0 }),
  body('loyaltyRedeemedPoints').optional().isInt({ min: 0 }),
  body('loyaltyRedeemedAmount').optional().isFloat({ min: 0 }),
  body('paymentMethod').optional().isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('paymentCashAmount').optional().isFloat({ min: 0 }),
  body('paymentOnlineAmount').optional().isFloat({ min: 0 }),
  body('allowPartialCheckout').optional().isBoolean(),
  body('items').optional().isArray({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const invoiceDoc = await findScoped(Invoice, req, { _id: req.params.id });
    if (!invoiceDoc) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    assertBranchAccess(req, invoiceDoc, { allowLegacyNull: true });
    try {
      await assertInvoiceCheckoutAccess(req, invoiceDoc);
    } catch (accessErr) {
      return res.status(accessErr.status || 403).json({ success: false, message: accessErr.message });
    }
    const invoice = invoiceDoc;

    const isPaid = invoice.paymentStatus === 'RECEIVED';
    const isCreditClosed = invoice.settlementMode === 'CREDIT' && invoice.saleConfirmedAt;
    const isLocked = isPaid || isCreditClosed;

    if (isLocked && !isBusinessOwner(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Only the business owner can edit a closed invoice'
      });
    }

    if (isLocked) {
      rejectLockedFinancialBodyFields(req.body);
    }

    if (req.body.items !== undefined) {
      if (isLocked) {
        return res.status(403).json({
          success: false,
          message: 'Line item amounts cannot be edited on a paid or credit-closed invoice'
        });
      }
      try {
        await applyInvoiceItemPriceUpdates(invoice, req.body.items, req.businessId);
      } catch (itemErr) {
        return res.status(itemErr.status || 400).json({
          success: false,
          message: itemErr.message || 'Invalid line item prices'
        });
      }
    }

    applyInvoiceMetadataFields(invoice, req.body);

    if (!isLocked) {
      await applyOpenInvoiceFinancialFields(invoice, req.body, req.businessId);
    } else if (req.body.paymentMethod !== undefined) {
      relabelLockedInvoicePaymentMethod(invoice, req.body.paymentMethod);
    }

    await invoice.save();
    const updated = await Invoice.findById(invoice._id)
      .populate({
        path: 'jobId',
        populate: { path: 'services.serviceId', select: 'name isVariable skipWorkProcess' }
      })
      .lean();
    res.json({ success: true, invoice: updated });
  } catch (error) {
    console.error('Update invoice error:', error);
    const status = error?.status && error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ success: false, message: error?.message || 'Server error' });
  }
});

// GET /api/admin/invoices/:id/share-url
router.get('/invoices/:id/share-url', async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    if (invoice.paymentStatus !== 'RECEIVED') {
      return res.status(400).json({
        success: false,
        message: 'Invoice can be shared only after payment is received and the job is closed'
      });
    }
    if (invoice.jobId) {
      const job = await Job.findOne({ _id: invoice.jobId, businessId: req.businessId }).select('status').lean();
      if (!job) {
        return res.status(400).json({ success: false, message: 'Job not found for this invoice' });
      }
      if (job.status !== 'DELIVERED') {
        return res.status(400).json({
          success: false,
          message: 'Invoice can be shared only after payment is received and the job is closed'
        });
      }
    }
    if (!invoice.shareToken) {
      invoice.shareToken = generateShareToken();
      await invoice.save();
    }
    res.json({
      success: true,
      shareToken: invoice.shareToken,
      invoiceId: String(invoice._id)
    });
  } catch (error) {
    console.error('Share URL error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/invoices/:id/close-job - set payment received & close job (DELIVERED)
router.patch('/invoices/:id/close-job', async (req, res) => {
  try {
    const invoice = await Invoice.findOne(scopedFilter(req, { _id: req.params.id, businessId: req.businessId }));
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    assertBranchAccess(req, invoice, { allowLegacyNull: true });
    try {
      await assertInvoiceCheckoutAccess(req, invoice);
    } catch (accessErr) {
      return res.status(accessErr.status || 403).json({ success: false, message: accessErr.message });
    }
    if (invoice.paymentStatus === 'RECEIVED') {
      return res.json({ success: true, message: 'Job already closed' });
    }
    if (invoice.settlementMode === 'CREDIT' && invoice.saleConfirmedAt) {
      const refreshed = await Invoice.findById(invoice._id).populate('jobId').lean();
      return res.json({ success: true, message: 'Job already closed on credit', invoice: refreshed || invoice });
    }

    const job = await Job.findOne({ _id: invoice.jobId, businessId: req.businessId })
      .select('customerId services assignedTo')
      .lean();

    if (!invoice.customerId && job?.customerId) {
      invoice.customerId = job.customerId;
    }

    if (isCreditSettlementMode(req.body)) {
      const modules = req.businessModules || await getBusinessModules(req.businessId);
      if (!isModuleEnabled(modules, 'credit')) {
        return moduleDisabledResponse(res, 'credit');
      }
      try {
        const result = await closeJobOnCredit({
          invoice,
          job,
          businessId: req.businessId,
          user: req.user,
          body: req.body
        });
        return res.json({ success: true, message: result.message, invoice: result.invoice });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message || 'Credit close failed' });
      }
    }

    const due = balanceDue(invoice.finalAmount, invoice.advancePayment);
    try {
      normalizeInvoicePaymentFields(invoice, {
        paymentMethod: req.body.paymentMethod ?? invoice.paymentMethod,
        paymentCashAmount: req.body.paymentCashAmount,
        paymentOnlineAmount: req.body.paymentOnlineAmount
      });
      assertSettlementMatchesDue(
        invoice.paymentMethod,
        due,
        invoice.paymentCashAmount,
        invoice.paymentOnlineAmount
      );
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message || 'Invalid payment amount' });
    }

    invoice.paymentStatus = 'RECEIVED';
    invoice.paymentReceivedAt = new Date();
    await invoice.save();
    await Job.findOneAndUpdate(
      { _id: invoice.jobId, businessId: req.businessId },
      { $set: { status: 'DELIVERED', actualDelivery: new Date() } }
    );

    // Loyalty points: earn from services (redeem is already applied when invoice is saved)
    if (job?.customerId) {
      const serviceIds = Array.isArray(job.services) ? job.services.map((s) => s?.serviceId).filter(Boolean) : [];
      let earned = 0;
      if (serviceIds.length) {
        const svc = await Service.find({ businessId: req.businessId, _id: { $in: serviceIds } })
          .select('loyaltyPointsEarned')
          .lean();
        earned = svc.reduce((sum, s) => sum + Math.max(0, Number(s.loyaltyPointsEarned || 0)), 0);
      }
      if (earned !== 0) {
        const customer = await Customer.findOne({ _id: job.customerId, businessId: req.businessId }).select('loyaltyPointsBalance');
        if (customer) {
          customer.loyaltyPointsBalance = Math.max(0, Number(customer.loyaltyPointsBalance || 0) + earned);
          await customer.save();
        }
      }
    }
    res.json({ success: true, message: 'Job closed' });

    // Push notification to business owner + assigned employee (job_closed)
    try {
      const ownerId = req.user.role === 'CAR_WASH_ADMIN'
        ? req.user._id
        : (await User.findOne({ businessId: req.businessId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' }).select('_id').lean())?._id;
      if (ownerId) {
        const pushRes = await sendPushNotification({
          businessOwnerId: ownerId,
          title: 'Booking completed',
          body: 'Invoice marked paid. Booking closed.',
          data: { type: 'job_closed', bookingId: invoice.jobId, url: `/admin/invoices/${invoice._id}` }
        });
        console.log('Push job_closed:', pushRes);
      }

      if (job?.assignedTo) {
        const pushEmp = await sendPushNotification({
          businessOwnerId: job.assignedTo,
          title: 'Job closed',
          body: 'Invoice marked paid. Job delivered.',
          data: { type: 'job_closed', bookingId: invoice.jobId, url: `/employee/invoices/${invoice._id}` }
        });
        console.log('Push job_closed (employee):', pushEmp);
      }
    } catch (pushErr) {
      console.warn('Push notification error (job_closed):', pushErr?.message || pushErr);
    }
  } catch (error) {
    console.error('Close job error:', error);
    res.status(error?.status || 500).json({
      success: false,
      message: error?.message || 'Server error'
    });
  }
});

// ==================== REPORTS (Car Wash Admin only) ====================
function parseServiceIdsFromQuery(query) {
  const raw = query.serviceIds ?? query.service_id;
  if (raw == null || raw === '') return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(',');
  return [
    ...new Set(
      parts
        .map((s) => String(s).trim())
        .filter(Boolean)
        .filter((id) => mongoose.isValidObjectId(id))
    )
  ];
}

async function serviceObjectIdsForBusiness(businessId, idStrings) {
  if (!idStrings.length) return [];
  const oids = idStrings.map((id) => new mongoose.Types.ObjectId(id));
  const found = await Service.find({ businessId, _id: { $in: oids } }).select('_id').lean();
  return found.map((f) => f._id);
}

function parseReportDateRange(range, from, to, businessTz) {
  if (businessTz !== undefined) {
    const { startUtc, endUtc } = parseBusinessDateRange(businessTz, range, from, to);
    return { start: startUtc, end: endUtc, exclusiveEnd: true };
  }
  const now = new Date();
  let start, end;
  switch (range) {
    case 'daily':
    case 'today':
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end = new Date(start); end.setDate(end.getDate() + 1);
      break;
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      start = new Date(y); start.setHours(0, 0, 0, 0);
      end = new Date(start); end.setDate(end.getDate() + 1);
      break;
    }
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
  return { start, end, exclusiveEnd: range === 'daily' || range === 'today' || range === 'yesterday' || !range };
}

function dateRangeQuery(start, end, exclusiveEnd) {
  return exclusiveEnd ? { $gte: start, $lt: end } : { $gte: start, $lte: end };
}

async function loadReportDateRange(businessId, range, from, to) {
  const settings = await BusinessSettings.findOne({ businessId }).select('timezone').lean();
  return parseReportDateRange(range, from, to, settings?.timezone);
}

// GET /api/admin/reports/jobs?range=daily|weekly|monthly|yearly|custom&from=&to=&serviceIds=id1,id2
// serviceIds: optional; jobs that include at least one of these services (OR). Scoped to this business.
router.get('/reports/jobs', adminPanelOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to } = req.query;
    const { start, end, exclusiveEnd } = await loadReportDateRange(req.businessId, range, from, to);
    const serviceObjectIds = await serviceObjectIdsForBusiness(
      req.businessId,
      parseServiceIdsFromQuery(req.query)
    );
    const jobQuery = applyBranchScope({
      businessId: req.businessId,
      createdAt: dateRangeQuery(start, end, exclusiveEnd)
    }, req);
    if (serviceObjectIds.length) {
      jobQuery.services = { $elemMatch: { serviceId: { $in: serviceObjectIds } } };
    }
    const jobs = await Job.find(jobQuery)
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
router.get('/reports/employees', adminPanelOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to } = req.query;
    const { start, end, exclusiveEnd } = await loadReportDateRange(req.businessId, range, from, to);
    const employees = await User.find({
      ...employeeListQuery(req),
      status: 'ACTIVE'
    })
      .select('name email employeeCode')
      .lean();
    const createdAtRange = dateRangeQuery(start, end, exclusiveEnd);
    const jobQuery = applyBranchScope({ businessId: req.businessId, createdAt: createdAtRange }, req);
    const report = await Promise.all(employees.map(async (emp) => {
      const jobs = await Job.find({
        ...jobQuery,
        assignedTo: emp._id
      }).select('status _id createdAt actualDelivery').lean();
      const completed = jobs.filter(j => ['COMPLETED', 'DELIVERED'].includes(j.status));
      const completedJobIds = completed.map(j => j._id);
      const invoices = await Invoice.find(applyBranchScope({
        businessId: req.businessId,
        jobId: { $in: completedJobIds }
      }, req)).select('finalAmount').lean();
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

// GET /api/admin/reports/expenses?range=...&from=&to=&expenseTypeId=
router.get('/reports/expenses', adminPanelOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to, expenseTypeId } = req.query;
    const { start, end, exclusiveEnd } = await loadReportDateRange(req.businessId, range, from, to);
    const query = applyBranchScope({
      businessId: req.businessId,
      expenseDate: dateRangeQuery(start, end, exclusiveEnd)
    }, req);
    if (expenseTypeId && mongoose.isValidObjectId(String(expenseTypeId))) {
      const type = await ExpenseType.findOne({
        _id: expenseTypeId,
        businessId: req.businessId
      }).select('_id').lean();
      if (!type) {
        return res.status(400).json({ success: false, message: 'Invalid expense type' });
      }
      query.expenseTypeId = type._id;
    }
    const expenses = await Expense.find(query)
      .populate('expenseTypeId', 'expenseName')
      .populate('createdBy', 'name email')
      .sort({ expenseDate: -1, createdAt: -1 })
      .lean();
    const totals = sumExpenseChannelTotals(expenses);
    res.json({
      success: true,
      data: expenses,
      totalAmount: totals.totalAmount,
      totalCashAmount: totals.totalCashAmount,
      totalOnlineAmount: totals.totalOnlineAmount,
      summary: {
        totalExpenses: expenses.length,
        totalAmount: totals.totalAmount,
        totalCashAmount: totals.totalCashAmount,
        totalOnlineAmount: totals.totalOnlineAmount,
      },
      start,
      end
    });
  } catch (error) {
    console.error('Reports expenses error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/sales?range=...&from=&to=&source=all|wash|jobs|products|variable|packages&serviceIds=id1,id2
// serviceIds: optional; limits job-linked invoices to jobs that include at least one selected service.
// Package invoices are omitted when serviceIds is set (filter applies to job line items only).
router.get('/reports/sales', adminPanelOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to, source = 'all' } = req.query;
    const salesSource = normalizeSalesReportSource(source);
    const { start, end, exclusiveEnd } = await loadReportDateRange(req.businessId, range, from, to);
    const deliveryRange = dateRangeQuery(start, end, exclusiveEnd);
    const serviceObjectIds = await serviceObjectIdsForBusiness(
      req.businessId,
      parseServiceIdsFromQuery(req.query)
    );

    let invoices = [];
    if (shouldIncludeJobSales(salesSource)) {
      const jobFilter = await buildDeliveredJobSalesFilter(req.businessId, {
        source: salesSource,
        deliveryRange,
        serviceObjectIds,
        ServiceModel: Service
      });

      if (jobFilter) {
        const deliveredJobIds = await Job.find(applyBranchScope(jobFilter, req)).distinct('_id');
        if (deliveredJobIds.length) {
          invoices = await Invoice.find(applyBranchScope({
            businessId: req.businessId,
            jobId: { $in: deliveredJobIds }
          }, req))
            .populate({
              path: 'jobId',
              populate: [
                { path: 'customerId', select: 'name phone email' },
                { path: 'carId', select: 'registrationNumber carNumber model make color' },
                { path: 'assignedTo', select: 'name email employeeCode' },
                { path: 'services.serviceId', model: 'Service', select: 'name isVariable skipWorkProcess' }
              ]
            })
            .sort({ createdAt: -1 })
            .lean();
          invoices = invoices.map(mapJobInvoiceForSalesReport);
        }
      }
    }

    let packageSales = [];
    if (shouldIncludePackageSales(salesSource, serviceObjectIds.length > 0)) {
      packageSales = await Invoice.find(applyBranchScope({
        businessId: req.businessId,
        saleType: 'PACKAGE',
        $or: [
          { paymentStatus: 'RECEIVED', paymentReceivedAt: deliveryRange },
          { settlementMode: 'CREDIT', saleConfirmedAt: deliveryRange }
        ]
      }, req))
        .sort({ paymentReceivedAt: -1, createdAt: -1 })
        .lean();
      packageSales = packageSales.map((inv) => ({
        ...inv,
        saleType: 'package',
        saleSubType: 'package'
      }));
    }

    const data = [...invoices, ...packageSales].sort((a, b) => {
      const da = a.saleType === 'job'
        ? (a.jobId?.actualDelivery || a.paymentReceivedAt || a.jobId?.createdAt || a.createdAt)
        : (a.paymentReceivedAt || a.createdAt);
      const db = b.saleType === 'job'
        ? (b.jobId?.actualDelivery || b.paymentReceivedAt || b.jobId?.createdAt || b.createdAt)
        : (b.paymentReceivedAt || b.createdAt);
      return new Date(db).getTime() - new Date(da).getTime();
    });

    const totalRevenue = data.reduce((s, inv) => s + (inv.finalAmount || 0), 0);
    let totalCashReceived = 0;
    let totalOnlineReceived = 0;
    for (const inv of data) {
      const pc = roundMoney(Number(inv.paymentCashAmount) || 0);
      const po = roundMoney(Number(inv.paymentOnlineAmount) || 0);
      if (pc + po > 0.02) {
        totalCashReceived += pc;
        totalOnlineReceived += po;
      } else if (inv.paymentStatus === 'RECEIVED') {
        const ch = invoiceSettlementCashOnline(inv);
        totalCashReceived += ch.cash;
        totalOnlineReceived += ch.online;
      }
    }
    const totalDiscountAmount = invoices.reduce((s, inv) => {
      const sub = inv.subtotal || 0;
      const pct = inv.discount || 0;
      return s + (sub * (pct / 100));
    }, 0);
    const totalGst = invoices.reduce((s, inv) => s + (inv.gstAmount || 0), 0);

    const paymentAtDeliveryCash = Math.round(totalCashReceived * 100) / 100;
    const paymentAtDeliveryOnline = Math.round(totalOnlineReceived * 100) / 100;
    let amountDueOnDeliveredSales = 0;
    for (const inv of data) {
      if (inv.settlementMode === 'CREDIT') {
        const final = roundMoney(Number(inv.finalAmount) || 0);
        const atCheckout = roundMoney(Number(inv.amountCollectedAtCheckout) || 0);
        amountDueOnDeliveredSales += roundMoney(Math.max(0, final - atCheckout));
      }
    }
    amountDueOnDeliveredSales = Math.round(amountDueOnDeliveredSales * 100) / 100;

    const endExclusive = exclusiveEnd ? end : new Date(end.getTime() + 1);
    const advanceRows = await Job.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(req.businessId), createdAt: dateRangeQuery(start, end, exclusiveEnd) } },
      {
        $addFields: {
          advCash: {
            $cond: [
              { $lte: [{ $ifNull: ['$advancePayment', 0] }, 0] },
              0,
              {
                $ifNull: [
                  '$advanceCashAmount',
                  { $cond: [{ $eq: ['$advancePaymentMethod', 'ONLINE'] }, 0, { $ifNull: ['$advancePayment', 0] }] }
                ]
              }
            ]
          },
          advOnline: {
            $cond: [
              { $lte: [{ $ifNull: ['$advancePayment', 0] }, 0] },
              0,
              {
                $ifNull: [
                  '$advanceOnlineAmount',
                  { $cond: [{ $eq: ['$advancePaymentMethod', 'ONLINE'] }, { $ifNull: ['$advancePayment', 0] }, 0] }
                ]
              }
            ]
          }
        }
      },
      { $group: { _id: null, advCash: { $sum: '$advCash' }, advOnline: { $sum: '$advOnline' } } }
    ]);
    const advCash = advanceRows[0]?.advCash ?? 0;
    const advOnline = advanceRows[0]?.advOnline ?? 0;
    const moneyInRaw = await getTodayCashReceived(req.businessId, start, endExclusive, advCash, advOnline);
    const collectionReport = await buildCollectionReport(req.businessId, start, end, exclusiveEnd);

    res.json({
      success: true,
      data,
      summary: {
        totalSales: data.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCashReceived: paymentAtDeliveryCash,
        totalOnlineReceived: paymentAtDeliveryOnline,
        paymentAtDelivery: {
          cash: paymentAtDeliveryCash,
          online: paymentAtDeliveryOnline,
          total: Math.round((paymentAtDeliveryCash + paymentAtDeliveryOnline) * 100) / 100
        },
        amountDueOnDeliveredSales,
        moneyInPeriod: {
          total: moneyInRaw.todayCashReceived,
          cash: moneyInRaw.todayCashReceivedCash,
          online: moneyInRaw.todayCashReceivedOnline,
          fullPayCheckout: moneyInRaw.todayFullPayCheckout,
          creditCheckout: moneyInRaw.todayCreditCheckout,
          creditRecovery: moneyInRaw.todayCreditRecovery,
          advances: moneyInRaw.todayAdvances
        },
        collectionsInPeriod: collectionReport.summary,
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

// GET /api/admin/reports/visits?range=...&from=&to=
router.get('/reports/visits', adminPanelOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to } = req.query;
    const { start, end, exclusiveEnd } = await loadReportDateRange(req.businessId, range, from, to);
    const visitRange = dateRangeQuery(start, end, exclusiveEnd);

    const visits = await PackageVisit.find(applyBranchScope({
      businessId: req.businessId,
      date: visitRange
    }, req))
      .populate({
        path: 'customerPackageId',
        select: 'name status totalVisits visitsUsed visitsRemaining customerId',
        populate: { path: 'customerId', select: 'name phone email' }
      })
      .sort({ date: -1, createdAt: -1 })
      .lean();

    // Compute remaining visits "as of" each row date (so older rows don't show today's remaining).
    const pkgIds = [...new Set(visits.map((v) => v.customerPackageId?._id).filter(Boolean).map((id) => id.toString()))];
    const completed = pkgIds.length ? await PackageVisit.find({
      businessId: req.businessId,
      customerPackageId: { $in: pkgIds },
      status: 'completed',
      date: exclusiveEnd ? { $lt: end } : { $lte: end }
    }).select('customerPackageId date').sort({ date: 1, createdAt: 1 }).lean() : [];

    const completedDatesByPkg = new Map();
    for (const r of completed) {
      const key = String(r.customerPackageId);
      if (!completedDatesByPkg.has(key)) completedDatesByPkg.set(key, []);
      completedDatesByPkg.get(key).push(new Date(r.date).getTime());
    }

    const countCompletedUpTo = (arr, t) => {
      // upper_bound (<= t)
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    const visitsWithComputed = visits.map((v) => {
      const pkg = v.customerPackageId || {};
      const pkgId = pkg?._id ? String(pkg._id) : '';
      const total = Number(pkg.totalVisits || 0);
      const arr = pkgId ? (completedDatesByPkg.get(pkgId) || []) : [];
      const t = v.date ? new Date(v.date).getTime() : 0;
      const usedAfter = t && arr.length ? countCompletedUpTo(arr, t) : 0;
      const remainingAfter = Math.max(0, total - usedAfter);
      return { ...v, usedAfter, remainingAfter };
    });

    const summary = {
      totalVisits: visits.length,
      byStatus: visits.reduce((acc, v) => { acc[v.status] = (acc[v.status] || 0) + 1; return acc; }, {})
    };

    res.json({ success: true, data: visitsWithComputed, summary, start, end });
  } catch (error) {
    console.error('Reports visits error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/collections?range=...&from=&to=
router.get('/reports/collections', adminPanelOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to } = req.query;
    const { start, end, exclusiveEnd } = await loadReportDateRange(req.businessId, range, from, to);
    const branchId = req.branchScope === 'all' ? null : req.branchId;
    const report = await buildCollectionReport(req.businessId, start, end, exclusiveEnd, branchId);
    res.json({
      success: true,
      data: report.data,
      summary: report.summary,
      totalAmount: report.summary.totalCollection,
      start: report.start,
      end: report.end
    });
  } catch (error) {
    console.error('Reports collections error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/outstanding?customerId=&minAmount=&overdueOnly=true
router.get('/reports/outstanding', adminPanelOnly, async (req, res) => {
  try {
    const branchId = req.branchScope === 'all' ? null : req.branchId;
    const report = await buildOutstandingReport(req.businessId, {
      customerId: req.query.customerId,
      minAmount: req.query.minAmount,
      overdueOnly: req.query.overdueOnly,
      branchId
    });
    res.json({
      success: true,
      data: report.data,
      summary: report.summary,
      totalAmount: report.summary.totalOutstanding
    });
  } catch (error) {
    console.error('Reports outstanding error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/sales-expenses?range=today|...|custom&from=&to=
router.get('/reports/sales-expenses', adminPanelOnly, async (req, res) => {
  try {
    const { range = 'this_month', from, to } = req.query;
    const { buildSalesExpensesStatement } = await import('../services/financialStatementsService.js');
    const statement = await buildSalesExpensesStatement(req.businessId, range, from, to);
    res.json({ success: true, statement });
  } catch (error) {
    console.error('Sales & expenses statement error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/trial-balance?range=...&from=&to=
router.get('/reports/trial-balance', adminPanelOnly, async (req, res) => {
  try {
    const { range = 'this_month', from, to } = req.query;
    const { buildTrialBalance } = await import('../services/financialStatementsService.js');
    const statement = await buildTrialBalance(req.businessId, range, from, to);
    res.json({ success: true, statement });
  } catch (error) {
    console.error('Trial balance error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports/profit-loss?range=...&from=&to=
router.get('/reports/profit-loss', adminPanelOnly, async (req, res) => {
  try {
    const { range = 'this_month', from, to } = req.query;
    const { buildProfitLossStatement } = await import('../services/financialStatementsService.js');
    const statement = await buildProfitLossStatement(req.businessId, range, from, to);
    res.json({ success: true, statement });
  } catch (error) {
    console.error('Profit & loss statement error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== DASHBOARD ====================

// @route   GET /api/admin/dashboard/branch-overview
// @desc    Per-branch KPIs when viewing all branches (owner)
router.get('/dashboard/branch-overview', async (req, res) => {
  try {
    if (req.user.role !== 'CAR_WASH_ADMIN') {
      return res.status(403).json({ success: false, message: 'Owner access only' });
    }
    if (req.branchScope !== 'all') {
      return res.status(400).json({ success: false, message: 'Switch to All branches to view branch overview' });
    }
    const businessId = req.businessId;
    const settingsLean = await BusinessSettings.findOne({ businessId }).select('timezone').lean();
    const businessTz = settingsLean?.timezone || process.env.CRON_TZ || 'UTC';
    const range = String(req.query.range || 'today').toLowerCase();
    const fromQ = String(req.query.from || '').trim();
    const toQ = String(req.query.to || '').trim();
    let bounds;
    try {
      bounds = parseBusinessDateRange(businessTz, range, fromQ, toQ);
    } catch (boundsErr) {
      if (boundsErr.statusCode === 400) {
        return res.status(400).json({ success: false, message: boundsErr.message });
      }
      throw boundsErr;
    }
    const branches = await getBranchOverviewStats(businessId, bounds.startUtc, bounds.endUtc);
    res.json({ success: true, branches, rangeLabel: bounds.rangeLabel });
  } catch (error) {
    console.error('Branch overview error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/dashboard
// @desc    Fast dashboard stats only (KPIs). Use /admin/dashboard/charts for lazy-loaded charts.
// @access  Private (Car Wash Admin, Employee)
router.get('/dashboard', async (req, res) => {
  try {
    const businessId = req.businessId;
    const isEmployee = req.user.role === 'EMPLOYEE';
    const baseMatch = applyBranchScopeOid({ businessId: new mongoose.Types.ObjectId(businessId) }, req);
    if (isEmployee) baseMatch.assignedTo = req.user._id;

    const scopedBranchId = req.branchScope === 'branch' && req.branchId ? req.branchId : null;
    const expenseMatch = applyBranchScopeOid({ businessId: new mongoose.Types.ObjectId(businessId) }, req);

    const settingsLean = await BusinessSettings.findOne({ businessId })
      .select('timezone')
      .lean();
    const businessTz = settingsLean?.timezone || process.env.CRON_TZ || 'UTC';

    const range = String(req.query.range || 'today').toLowerCase();
    const fromQ = String(req.query.from || '').trim();
    const toQ = String(req.query.to || '').trim();

    let bounds;
    try {
      bounds = parseBusinessDateRange(businessTz, range, fromQ, toQ);
    } catch (boundsErr) {
      if (boundsErr.statusCode === 400) {
        return res.status(400).json({ success: false, message: boundsErr.message });
      }
      throw boundsErr;
    }
    const { startUtc, endUtc, rangeLabel } = bounds;

    const statsPayload = await loadDashboardStats({
      businessId,
      businessTz,
      startUtc,
      endUtc,
      rangeLabel,
      range,
      isEmployee,
      baseMatch,
      expenseMatch,
      scopedBranchId,
      businessModules: req.businessModules
    });

    res.json({ success: true, stats: statsPayload, isEmployee: !!isEmployee });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/dashboard/unclosed-invoices
// @desc    Unclosed invoices in selected dashboard period (owner)
// @access  Private (Car Wash Admin)
router.get('/dashboard/unclosed-invoices', async (req, res) => {
  try {
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Admin access only' });
    }
    const businessId = req.businessId;
    const settingsLean = await BusinessSettings.findOne({ businessId })
      .select('timezone')
      .lean();
    const businessTz = settingsLean?.timezone || process.env.CRON_TZ || 'UTC';
    const range = String(req.query.range || 'today').toLowerCase();
    const fromQ = String(req.query.from || '').trim();
    const toQ = String(req.query.to || '').trim();
    let bounds;
    try {
      bounds = parseBusinessDateRange(businessTz, range, fromQ, toQ);
    } catch (boundsErr) {
      if (boundsErr.statusCode === 400) {
        return res.status(400).json({ success: false, message: boundsErr.message });
      }
      throw boundsErr;
    }
    const { startUtc, endUtc, rangeLabel } = bounds;
    const limit = Math.min(Number(req.query.limit) || 10, 25);
    const scopedBranchId = req.branchScope === 'branch' && req.branchId ? req.branchId : null;
    const invoices = await getDashboardUnclosedInvoices(businessId, startUtc, endUtc, limit, scopedBranchId);
    res.json({ success: true, invoices, rangeLabel });
  } catch (error) {
    console.error('Dashboard unclosed invoices error:', error);
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
    const baseMatch = applyBranchScopeOid({ businessId: new mongoose.Types.ObjectId(businessId) }, req);
    if (isEmployee) baseMatch.assignedTo = req.user._id;

    const scopedBranchId = req.branchScope === 'branch' && req.branchId ? req.branchId : null;
    const invoiceMatch = applyBranchScopeOid({ businessId: new mongoose.Types.ObjectId(businessId) }, req);

    const settingsLean = await BusinessSettings.findOne({ businessId })
      .select('timezone')
      .lean();
    const businessTz = settingsLean?.timezone || process.env.CRON_TZ || 'UTC';

    const range = String(req.query.range || 'today').toLowerCase();
    const fromQ = String(req.query.from || '').trim();
    const toQ = String(req.query.to || '').trim();

    let bounds;
    try {
      bounds = parseBusinessDateRange(businessTz, range, fromQ, toQ);
    } catch (boundsErr) {
      if (boundsErr.statusCode === 400) {
        return res.status(400).json({ success: false, message: boundsErr.message });
      }
      throw boundsErr;
    }
    const { startUtc, endUtc, rangeLabel } = bounds;
    const endExclusiveZ = DateTime.fromJSDate(endUtc).setZone(businessTz);
    const washJobMatch = { ...baseMatch, ...WASH_JOB_FILTER };

    // Revenue trend: run 7 day queries in parallel
    const revenuePromises = [];
    const anchorDayZ = endExclusiveZ.minus({ days: 1 }).startOf('day');
    for (let i = 6; i >= 0; i--) {
      const dayZ = anchorDayZ.minus({ days: i });
      const d = dayZ.toUTC().toJSDate();
      const next = dayZ.plus({ days: 1 }).toUTC().toJSDate();
      revenuePromises.push(
        Invoice.aggregate([
          { $match: invoiceMatch },
          {
            $lookup: {
              from: 'jobs',
              let: { jid: '$jobId' },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ['$_id', '$$jid'] },
                    directBill: { $ne: true },
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
      date: DateTime.fromJSDate(d).setZone(businessTz).toFormat('ccc, LLL d'),
      revenue: Math.round(total * 100) / 100
    }));

    const servicesDistribution = await getDashboardServicesDistribution(businessId, startUtc, endUtc, scopedBranchId);

    // Job trend for employees: jobs completed per day (last 7 days)
    let jobTrend = [];
    if (isEmployee) {
      const jobPromises = [];
      const anchorEmpDayZ = endExclusiveZ.minus({ days: 1 }).startOf('day');
      for (let i = 6; i >= 0; i--) {
        const dayZ = anchorEmpDayZ.minus({ days: i });
        const d = dayZ.toUTC().toJSDate();
        const next = dayZ.plus({ days: 1 }).toUTC().toJSDate();
        jobPromises.push(
          Job.aggregate([
            {
              $match: {
                ...baseMatch,
                ...WASH_JOB_FILTER,
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
        date: DateTime.fromJSDate(d).setZone(businessTz).toFormat('ccc, LLL d'),
        jobs: count
      }));
    }

    res.json({
      success: true,
      revenueTrend: isEmployee ? [] : revenueTrend,
      jobTrend,
      servicesDistribution,
      servicesDistributionMeta: {
        label: rangeLabel,
        timezone: businessTz,
        range,
        start: startUtc.toISOString(),
        end: endUtc.toISOString()
      }
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
    const settingsLean = await BusinessSettings.findOne({ businessId })
      .select('timezone')
      .lean();
    const businessTz = settingsLean?.timezone || process.env.CRON_TZ || 'UTC';
    const range = String(req.query.range || 'today').toLowerCase();
    const fromQ = String(req.query.from || '').trim();
    const toQ = String(req.query.to || '').trim();
    let bounds;
    try {
      bounds = parseBusinessDateRange(businessTz, range, fromQ, toQ);
    } catch (boundsErr) {
      if (boundsErr.statusCode === 400) {
        return res.status(400).json({ success: false, message: boundsErr.message });
      }
      throw boundsErr;
    }
    const { startUtc, endUtc, rangeLabel } = bounds;

    const deliveredInRange = {
      status: 'DELIVERED',
      $or: [
        { actualDelivery: { $gte: startUtc, $lt: endUtc } },
        { actualDelivery: { $exists: false }, updatedAt: { $gte: startUtc, $lt: endUtc } }
      ]
    };

    const branchMatch = req.branchScope !== 'all' && req.branchId
      ? { branchId: new mongoose.Types.ObjectId(String(req.branchId)) }
      : {};

    const leaderboard = await Job.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          ...branchMatch,
          ...WASH_JOB_FILTER,
          ...deliveredInRange,
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
    res.json({ success: true, leaderboard: combined, rangeLabel });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== EMPLOYEE MANAGEMENT (Car Wash Admin only) ====================

function randomPassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < length; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function employeeListQuery(req) {
  const q = { businessId: req.businessId, role: 'EMPLOYEE' };
  if (isBranchAdmin(req.user.role)) {
    q.branchId = req.user.branchId;
  } else if (req.branchScope !== 'all' && req.branchId) {
    q.branchId = req.branchId;
  }
  return q;
}

async function findManagedEmployee(req, employeeId, asQuery = false) {
  const q = { _id: employeeId, businessId: req.businessId, role: 'EMPLOYEE' };
  if (isBranchAdmin(req.user.role)) {
    q.branchId = req.user.branchId;
  } else if (req.branchScope !== 'all' && req.branchId) {
    q.branchId = req.branchId;
  }
  return asQuery ? q : User.findOne(q);
}

// @route   GET /api/admin/employees
// @desc    List employees (business owner only)
// @access  Private (Car Wash Admin)
router.get('/employees', async (req, res) => {
  try {
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const employees = await User.find(employeeListQuery(req))
      .select('name email phone address employeeCode status branchId createdAt')
      .populate('branchId', 'name code')
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
  body('address').optional().trim(),
  body('branchId').optional().isMongoId()
], async (req, res) => {
  try {
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
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

    let branchId = isBranchAdmin(req.user.role)
      ? req.user.branchId
      : (req.body.branchId || req.branchId || null);
    if (branchId) {
      const branch = await Branch.findOne({ _id: branchId, businessId: req.businessId, status: 'ACTIVE' });
      if (!branch) {
        return res.status(400).json({ success: false, message: 'Invalid branch selected' });
      }
    }

    let user;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const employeeCode = await generateEmployeeCode(req.businessId);
      try {
        user = await User.create({
          name,
          email,
          password,
          role: 'EMPLOYEE',
          businessId: req.businessId,
          branchId: branchId || undefined,
          phone: phone || '',
          address: address || '',
          employeeCode
        });
        break;
      } catch (err) {
        if (err?.code === 11000 && /employeeCode/i.test(String(err?.message || '')) && attempt < 4) {
          continue;
        }
        throw err;
      }
    }
    if (!user) {
      return res.status(500).json({ success: false, message: 'Could not assign employee code' });
    }

    res.status(201).json({
      success: true,
      employee: {
        _id: user._id,
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: user.address,
        employeeCode: user.employeeCode,
        status: user.status,
        branchId: user.branchId || null
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
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const user = await findManagedEmployee(req, req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    const employee = await User.findById(user._id).select('-password').lean();
    const employeeId = employee._id;
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
      employee,
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
  body('status').optional().isIn(['ACTIVE', 'SUSPENDED', 'INACTIVE']),
  body('branchId').optional({ nullable: true }).isMongoId()
], async (req, res) => {
  try {
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const user = await findManagedEmployee(req, req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    if (req.body.name != null) user.name = req.body.name;
    if (req.body.phone != null) user.phone = req.body.phone;
    if (req.body.address != null) user.address = req.body.address;
    if (req.body.status != null) user.status = req.body.status;
    if (req.body.branchId !== undefined && !isBranchAdmin(req.user.role)) {
      if (req.body.branchId === null || req.body.branchId === '') {
        user.branchId = undefined;
      } else {
        const branch = await Branch.findOne({ _id: req.body.branchId, businessId: req.businessId, status: 'ACTIVE' });
        if (!branch) {
          return res.status(400).json({ success: false, message: 'Invalid branch selected' });
        }
        user.branchId = branch._id;
      }
    }
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
      _id: user._id,
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: user.address,
      employeeCode: user.employeeCode,
      status: user.status,
      branchId: user.branchId || null
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
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const user = await User.findOneAndDelete(findManagedEmployee(req, req.params.id, true));
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
// @desc    Set a new password for an employee (business owner or branch admin)
// @access  Private (Car Wash Admin / Branch Admin)
router.post('/employees/:id/reset-password', [
  body('newPassword').isLength({ min: 6 }),
  body('confirmPassword').notEmpty()
], async (req, res) => {
  try {
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const user = await findManagedEmployee(req, req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    const { newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match' });
    }
    user.password = newPassword;
    await user.save();
    res.json({
      success: true,
      temporaryPassword: newPassword,
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('Reset employee password error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== CUSTOMER MANAGEMENT ====================

// @route   GET /api/admin/customers/:id
// @desc    Customer profile with cars, visits (jobs), packages
// @access  Private (Car Wash Admin)
router.get('/customers/:id', async (req, res) => {
  try {
    const customer = await findScoped(Customer, req, { _id: req.params.id });
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    assertBranchAccess(req, customer);

    const customerId = customer._id;
    const now = new Date();
    const branchJobFilter = applyBranchScope({ businessId: req.businessId, customerId }, req);
    const branchCarFilter = applyBranchScope({ businessId: req.businessId, customerId }, req);
    const branchPkgFilter = applyBranchScope({ businessId: req.businessId, customerId }, req);

    await backfillCustomerInvoiceLinks(req.businessId, customerId);

    const [cars, jobs, packages, bookings, totalVisits, totalProductSales, deliveredJobs] = await Promise.all([
      Car.find(branchCarFilter).sort({ createdAt: -1 }).lean(),
      Job.find(branchJobFilter)
        .populate('carId', 'carNumber brand model color')
        .populate({ path: 'services.serviceId', select: 'name isVariable skipWorkProcess' })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      CustomerPackage.find(branchPkgFilter)
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      (async () => {
        const Booking = (await import('../models/Booking.model.js')).default;
        return Booking.find(applyBranchScope({ businessId: req.businessId, customerId }, req))
          .populate('slotId', 'name startTime endTime')
          .sort({ createdAt: -1, bookingDate: -1 })
          .limit(20)
          .lean();
      })(),
      Job.countDocuments({ ...branchJobFilter, directBill: { $ne: true } }),
      Job.countDocuments({ ...branchJobFilter, directBill: true }),
      Job.find({
        ...branchJobFilter,
        status: 'DELIVERED',
        directBill: { $ne: true }
      })
        .sort({ actualDelivery: -1, updatedAt: -1 })
        .limit(1)
        .populate('carId', 'carNumber brand model')
        .lean()
    ]);

    const visitJobs = jobs.filter((j) => !j.directBill).slice(0, 25);
    const productSales = jobs.filter((j) => j.directBill).slice(0, 25);
    const lastVisitJob = deliveredJobs[0] || visitJobs[0] || null;
    const lastVisitAt = lastVisitJob
      ? (lastVisitJob.actualDelivery || lastVisitJob.createdAt)
      : null;

    const hasActivePackage = packages.some(
      (p) => p.status === 'active' && (p.visitsRemaining ?? 0) > 0 && new Date(p.expiryDate) >= now
    );

    res.json({
      success: true,
      customer,
      cars,
      jobs: visitJobs,
      productSales,
      packages,
      bookings,
      stats: {
        totalJobs: totalVisits + totalProductSales,
        totalVisits,
        totalProductSales,
        totalCars: cars.length,
        loyaltyPoints: customer.loyaltyPointsBalance ?? 0,
        hasActivePackage,
        lastVisitAt
      }
    });
  } catch (error) {
    console.error('Get customer detail error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/admin/customers/:id/retention-message
// @desc    Generate personalized retention WhatsApp message
// @access  Private (Car Wash Admin)
router.post('/customers/:id/retention-message', adminPanelOnly, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const business = await Business.findById(req.businessId).select('businessName').lean();
    const customerId = customer._id;
    const now = new Date();

    const [lastDelivered, primaryCar, activePkg] = await Promise.all([
      Job.findOne({
        businessId: req.businessId,
        customerId,
        status: 'DELIVERED'
      })
        .sort({ actualDelivery: -1, updatedAt: -1 })
        .populate('carId', 'carNumber brand model')
        .lean(),
      Car.findOne({ businessId: req.businessId, customerId }).sort({ createdAt: -1 }).lean(),
      CustomerPackage.findOne({
        businessId: req.businessId,
        customerId,
        status: 'active',
        visitsRemaining: { $gt: 0 },
        expiryDate: { $gte: now }
      }).lean()
    ]);

    const lastJob = lastDelivered || await Job.findOne({ businessId: req.businessId, customerId })
      .sort({ createdAt: -1 })
      .populate('carId', 'carNumber brand model')
      .lean();

    const car = lastJob?.carId || primaryCar;
    const carLabel = car
      ? [car.brand, car.model, car.carNumber].filter(Boolean).join(' ').trim() || car.carNumber
      : null;

    const totalVisits = await Job.countDocuments({ businessId: req.businessId, customerId });

    const { generateRetentionMessage } = await import('../utils/retentionMessage.js');
    const message = await generateRetentionMessage({
      customerName: customer.name,
      businessName: business?.businessName || 'Our car wash',
      lastVisitDate: lastJob?.actualDelivery || lastJob?.createdAt || null,
      carLabel,
      loyaltyPoints: customer.loyaltyPointsBalance ?? 0,
      totalVisits,
      hasActivePackage: !!activePkg
    });

    res.json({ success: true, message });
  } catch (error) {
    console.error('Retention message error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/customers/:id/visits
// @desc    Get customer visit count (jobs count)
// @access  Private (Car Wash Admin)
router.get('/customers/:id/visits', async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, businessId: req.businessId }).select('_id').lean();
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    const visits = await Job.countDocuments({ businessId: req.businessId, customerId: customer._id });
    res.json({ success: true, visits });
  } catch (error) {
    console.error('Get customer visits error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/customers/:id/loyalty
// @desc    Get customer loyalty points balance
// @access  Private (Car Wash Admin)
router.get('/customers/:id/loyalty', async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, businessId: req.businessId })
      .select('_id loyaltyPointsBalance')
      .lean();
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    res.json({ success: true, loyaltyPointsBalance: customer.loyaltyPointsBalance ?? 0 });
  } catch (error) {
    console.error('Get customer loyalty error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/customers
// @desc    Get customers (search, pagination)
// @access  Private (Car Wash Admin)
router.get('/customers', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
    const outstandingOnly = req.query.outstanding === 'true' || req.query.outstanding === '1';
    const creditEnabled = isModuleEnabled(req.businessModules, 'credit');

    const query = { businessId: req.businessId };
    const andClauses = [];
    let outstandingMap = new Map();

    if (!outstandingOnly) {
      Object.assign(query, applyBranchScope({}, req));
    }

    if (search && typeof search === 'string' && search.trim()) {
      const orClauses = customerSearchOrClauses(search);
      if (orClauses.length) andClauses.push({ $or: orClauses });
    }

    if (outstandingOnly) {
      if (!creditEnabled) {
        return res.json({
          success: true,
          customers: [],
          pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 0 }
        });
      }
      outstandingMap = await aggregateOutstandingByCustomer(req.businessId, req);
      const outstandingIds = [...outstandingMap.keys()];
      if (!outstandingIds.length) {
        return res.json({
          success: true,
          customers: [],
          pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 0 }
        });
      }
      andClauses.push({
        _id: { $in: outstandingIds.map((id) => new mongoose.Types.ObjectId(id)) }
      });
    }

    if (andClauses.length) query.$and = andClauses;

    const total = await Customer.countDocuments(query);
    const customers = await Customer.find(query)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const customerIds = customers.map((c) => c._id);
    const branchStatsMatch = applyBranchScopeOid({ businessId: req.businessId, customerId: { $in: customerIds } }, req);
    const [carCounts, jobCounts] = customerIds.length
      ? await Promise.all([
          Car.aggregate([
            { $match: branchStatsMatch },
            { $group: { _id: '$customerId', count: { $sum: 1 } } }
          ]),
          Job.aggregate([
            { $match: branchStatsMatch },
            { $group: { _id: '$customerId', count: { $sum: 1 } } }
          ])
        ])
      : [[], []];
    const carCountMap = new Map(carCounts.map((r) => [String(r._id), r.count]));
    const jobCountMap = new Map(jobCounts.map((r) => [String(r._id), r.count]));

    const customersWithStats = customers.map((customer) => {
      const id = String(customer._id);
      return {
        ...customer,
        stats: {
          cars: carCountMap.get(id) || 0,
          jobs: jobCountMap.get(id) || 0
        }
      };
    });

    // Active package badge: customer has an active package with remaining visits and not expired
    const now = new Date();
    const activePkgCustomerIds = customerIds.length
      ? await CustomerPackage.find({
          ...applyBranchScope({ businessId: req.businessId, customerId: { $in: customerIds } }, req),
          status: 'active',
          visitsRemaining: { $gt: 0 },
          expiryDate: { $gte: now }
        }).distinct('customerId')
      : [];
    const activeSet = new Set(activePkgCustomerIds.map((id) => id.toString()));

    if (!outstandingMap.size && creditEnabled && customerIds.length) {
      outstandingMap = await aggregateOutstandingByCustomer(req.businessId, req, { customerIds });
    }

    const customersWithBadges = customersWithStats.map((c) => ({
      ...c,
      hasActivePackage: activeSet.has(String(c._id)),
      creditOutstanding: outstandingMap.get(String(c._id)) || 0
    }));

    res.json({
      success: true,
      customers: customersWithBadges,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 0
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
  body('whatsappNumber').optional()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const branchId = branchIdForCreate(req);
    const phone = String(req.body.phone || '').trim();
    const whatsappNumber = String(req.body.whatsappNumber || '').trim();
    const normalizedPhone = await assertCustomerPhoneAvailable(req.businessId, phone, null, branchId);
    const normalizedWhatsapp = whatsappNumber
      ? await assertCustomerPhoneAvailable(req.businessId, whatsappNumber, null, branchId)
      : normalizedPhone;

    const customer = await Customer.create({
      ...req.body,
      phone: normalizedPhone,
      whatsappNumber: normalizedWhatsapp || normalizedPhone,
      businessId: req.businessId,
      branchId
    });

    res.status(201).json({
      success: true,
      customer
    });
  } catch (error) {
    if (isDuplicatePhoneError(error) || /already exists/i.test(error.message)) {
      return res.status(400).json({ success: false, message: 'Mobile number already exists' });
    }
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
  body('whatsappNumber').optional()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const existing = await findScoped(Customer, req, { _id: req.params.id });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    assertBranchAccess(req, existing);
    const branchId = existing.branchId || req.branchId;
    if (req.body.phone) {
      const normalizedPhone = await assertCustomerPhoneAvailable(
        req.businessId,
        req.body.phone,
        req.params.id,
        branchId
      );
      req.body.phone = normalizedPhone;
      if (!req.body.whatsappNumber) {
        req.body.whatsappNumber = normalizedPhone;
      }
    }
    if (req.body.whatsappNumber) {
      req.body.whatsappNumber = await assertCustomerPhoneAvailable(
        req.businessId,
        req.body.whatsappNumber,
        req.params.id,
        branchId
      );
    }
    const customer = await Customer.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
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
    if (isDuplicatePhoneError(error) || /already exists/i.test(error.message)) {
      return res.status(400).json({ success: false, message: 'Mobile number already exists' });
    }
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
router.delete('/customers/:id', adminPanelOnly, async (req, res) => {
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
    const query = applyBranchScope({ businessId: req.businessId }, req);
    if (customerId) query.customerId = customerId;
    if (search && typeof search === 'string' && search.trim()) {
      const term = escapeRegex(search);
      const customerIds = await distinctCustomerIdsBySearch(Customer, req.businessId, search);
      query.$or = [
        { carNumber: { $regex: term, $options: 'i' } },
        { brand: { $regex: term, $options: 'i' } },
        { model: { $regex: term, $options: 'i' } },
        { color: { $regex: term, $options: 'i' } },
        ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : [])
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

    const customer = await findScoped(Customer, req, { _id: req.body.customerId });
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }
    assertBranchAccess(req, customer);

    const car = await Car.create({
      ...req.body,
      businessId: req.businessId,
      branchId: customer.branchId || req.branchId || branchIdForCreate(req)
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
      const customer = await findScoped(Customer, req, { _id: req.body.customerId });
      if (!customer) {
        return res.status(404).json({
          success: false,
          message: 'Customer not found'
        });
      }
      assertBranchAccess(req, customer);
    }
    const car = await Car.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!car) {
      return res.status(404).json({
        success: false,
        message: 'Car not found'
      });
    }
    assertBranchAccess(req, car);
    const updated = await Car.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
      req.body,
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Car not found'
      });
    }
    res.json({
      success: true,
      car: updated
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
    const car = await Car.findOneAndDelete(scopedFilter(req, { _id: req.params.id }));

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
    const { search, page = 1, limit = 20, all } = req.query;
    const query = scopedFilter(req);
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchOr = [
        { name: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } }
      ];
      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: searchOr }];
        delete query.$or;
      } else {
        query.$or = searchOr;
      }
    }
    const variableModuleOn = isModuleEnabled(req.businessModules, 'variableServices');
    const filterVariable = (list) => (
      variableModuleOn ? list : list.filter((s) => !s.isVariable)
    );
    const returnAll = all === '1' || all === 'true';
    if (returnAll) {
      const services = filterVariable(await Service.find(query)
        .sort({ name: 1 })
        .select('name price minTime maxTime description loyaltyPointsEarned isVariable skipWorkProcess isActive createdAt')
        .lean());
      const total = services.length;
      return res.json({
        success: true,
        services,
        pagination: { page: 1, limit: total, total, totalPages: 1 }
      });
    }
    const total = await Service.countDocuments(query);
    const services = filterVariable(await Service.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean());
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
router.post('/services', adminPanelOnly, [
  body('name').notEmpty().trim(),
  body('price').optional().isFloat({ min: 0 }),
  body('isVariable').optional().isBoolean(),
  body('skipWorkProcess').optional().isBoolean(),
  body('minTime').optional().isInt({ min: 0 }),
  body('maxTime').optional().isInt({ min: 0 }),
  body('loyaltyPointsEarned').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const isVariable = !!req.body.isVariable;
    const skipWorkProcess = isVariable && !!req.body.skipWorkProcess;
    if (isVariable && !isModuleEnabled(req.businessModules || await getBusinessModules(req.businessId), 'variableServices')) {
      return moduleDisabledResponse(res, 'variableServices');
    }
    const price = req.body.price != null && req.body.price !== '' ? Number(req.body.price) : 0;
    if (!isVariable && price <= 0) {
      return res.status(400).json({ success: false, message: 'Fixed services require a price greater than zero' });
    }

    const service = await Service.create({
      ...req.body,
      isVariable,
      skipWorkProcess,
      price: isVariable ? Math.max(0, price) : price,
      businessId: req.businessId,
      branchId: branchIdForCreate(req)
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
router.put('/services/:id', adminPanelOnly, [
  body('name').optional().notEmpty().trim(),
  body('price').optional().isFloat({ min: 0 }),
  body('isVariable').optional().isBoolean(),
  body('skipWorkProcess').optional().isBoolean(),
  body('minTime').optional().isInt({ min: 0 }),
  body('maxTime').optional().isInt({ min: 0 }),
  body('loyaltyPointsEarned').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const existing = await findScoped(Service, req, { _id: req.params.id });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Service not found' });
    }
    assertBranchAccess(req, existing);

    const isVariable = req.body.isVariable !== undefined ? !!req.body.isVariable : !!existing.isVariable;
    if (isVariable && !existing.isVariable && !isModuleEnabled(req.businessModules, 'variableServices')) {
      return moduleDisabledResponse(res, 'variableServices');
    }
    const skipWorkProcess = isVariable
      ? (req.body.skipWorkProcess !== undefined ? !!req.body.skipWorkProcess : !!existing.skipWorkProcess)
      : false;
    const price = req.body.price !== undefined
      ? (req.body.price != null && req.body.price !== '' ? Number(req.body.price) : 0)
      : Number(existing.price) || 0;
    if (!isVariable && price <= 0) {
      return res.status(400).json({ success: false, message: 'Fixed services require a price greater than zero' });
    }

    const update = { ...req.body, isVariable, skipWorkProcess, price: isVariable ? Math.max(0, price) : price };
    const service = await Service.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
      update,
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
router.delete('/services/:id', adminPanelOnly, async (req, res) => {
  try {
    const service = await Service.findOneAndDelete(scopedFilter(req, { _id: req.params.id }));

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
    const filter = jobAccessFilter(req, { _id: req.params.id });
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
    assertBranchAccess(req, job, { allowLegacyNull: true });

    const invoiceForJob = await Invoice.findOne({ businessId: req.businessId, jobId: job._id })
      .select('finalAmount advancePayment paymentMethod paymentStatus paymentCashAmount paymentOnlineAmount invoiceNumber createdAt paymentReceivedAt')
      .lean();

    const pendingSettlementRequest = invoiceForJob
      ? await SettlementChangeRequest.findOne({
          businessId: req.businessId,
          jobId: job._id,
          invoiceId: invoiceForJob._id,
          status: 'PENDING'
        })
          .populate('requestedBy', 'name email employeeCode')
          .lean()
      : null;

    res.json({
      success: true,
      job,
      hasInvoice: !!invoiceForJob,
      invoice: invoiceForJob || null,
      pendingSettlementRequest: pendingSettlementRequest || null
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
    const { status, page = 1, limit = 20, search, from, to, range } = req.query;
    const query = { ...branchFilter(req) };
    // Employee sees only jobs assigned to them
    if (req.user.role === 'EMPLOYEE') {
      query.assignedTo = req.user._id;
    }
    if (status && status !== 'ALL') {
      query.status = status;
    }
    const directBillParam = String(req.query.directBill || req.query.productSales || '').toLowerCase();
    if (directBillParam === '1' || directBillParam === 'true') {
      query.directBill = true;
    } else if (directBillParam === 'all') {
      // include wash jobs and product sales
    } else {
      query.directBill = { $ne: true };
    }
    if (search && typeof search === 'string' && search.trim()) {
      const term = escapeRegex(search);
      const [customerIds, carIdRows] = await Promise.all([
        distinctCustomerIdsBySearch(Customer, req.businessId, search),
        Car.aggregate([
          {
            $lookup: {
              from: 'customers',
              localField: 'customerId',
              foreignField: '_id',
              as: 'cust'
            }
          },
          { $unwind: '$cust' },
          {
            $match: {
              'cust.businessId': new mongoose.Types.ObjectId(req.businessId),
              carNumber: { $regex: term, $options: 'i' }
            }
          },
          { $project: { _id: 1 } }
        ])
      ]);
      const carIds = carIdRows.map((r) => r._id);
      query.$or = [
        { tokenNumber: { $regex: term, $options: 'i' } },
        ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : []),
        ...(carIds.length ? [{ carId: { $in: carIds } }] : [])
      ];
    }

    // Date range filter (createdAt) — prefer `range` in business timezone; legacy from/to ISO still supported
    const rangeKey = range && String(range).trim() && String(range).toUpperCase() !== 'ALL'
      ? String(range).trim()
      : '';
    if (rangeKey) {
      const { startUtc, endUtc } = await loadBusinessDateRange(req.businessId, rangeKey, from, to);
      applyCreatedAtRange(query, startUtc, endUtc);
    } else if ((from && String(from).trim()) || (to && String(to).trim())) {
      const settings = await BusinessSettings.findOne({ businessId: req.businessId }).select('timezone').lean();
      const fromStr = from && String(from).trim();
      const toStr = to && String(to).trim();
      const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (isDateOnly(fromStr) || isDateOnly(toStr)) {
        const bounds = parseBusinessDateRange(
          settings?.timezone,
          'custom',
          fromStr || toStr,
          toStr || fromStr
        );
        applyCreatedAtRange(query, fromStr ? bounds.startUtc : null, toStr ? bounds.endUtc : null);
      } else {
        const rangeObj = {};
        if (fromStr) {
          const d = new Date(fromStr);
          if (!Number.isNaN(d.getTime())) rangeObj.$gte = d;
        }
        if (toStr) {
          const d = new Date(toStr);
          if (!Number.isNaN(d.getTime())) rangeObj.$lte = d;
        }
        if (Object.keys(rangeObj).length) query.createdAt = rangeObj;
      }
    }

    const [jobs, total] = await Promise.all([
      Job.find(query)
        .select('-beforeImages -afterImages -notes')
        .populate('customerId', 'name phone whatsappNumber')
        .populate('carId', 'carNumber brand model color')
        .populate('services.serviceId', 'name')
        .populate('assignedTo', 'name employeeCode email')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit)
        .lean(),
      Job.countDocuments(query)
    ]);

    const deliveredIds = jobs.filter(j => j.status === 'DELIVERED').map(j => j._id);
    let invoiceFinalByJob = {};
    if (deliveredIds.length > 0) {
      const invoices = await Invoice.find({ businessId: req.businessId, jobId: { $in: deliveredIds } })
        .select('jobId finalAmount paymentMethod paymentStatus')
        .lean();
      invoices.forEach(inv => {
        invoiceFinalByJob[inv.jobId?.toString()] = {
          invoiceId: inv._id,
          finalAmount: inv.finalAmount,
          paymentMethod: inv.paymentMethod,
          paymentStatus: inv.paymentStatus
        };
      });
    }
    const jobsWithFinal = jobs.map(j => {
      const out = { ...j };
      const inv = invoiceFinalByJob[j._id.toString()];
      if (j.status === 'DELIVERED' && inv != null) {
        out.invoiceId = inv.invoiceId;
        out.invoiceFinalAmount = inv.finalAmount;
        out.invoicePaymentMethod = inv.paymentMethod;
        out.invoicePaymentStatus = inv.paymentStatus;
      }
      return out;
    });

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
  body('carId').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid car'),
  body('serviceIds').optional().isArray({ min: 1 }),
  body('services').optional().isArray({ min: 1 }),
  body('createWithoutImages').optional().toBoolean(),
  body('beforeImages').optional().isArray(),
  body('notes').optional().trim(),
  body('estimatedDelivery').optional().isISO8601(),
  body('assignedTo').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid employee'),
  body('customerPackageId').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid package'),
  body('advancePayment').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Advance must be a non-negative number'),
  body('advancePaymentMethod').optional().isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('advanceCashAmount').optional().isFloat({ min: 0 }),
  body('advanceOnlineAmount').optional().isFloat({ min: 0 }),
  body('directBill').optional().toBoolean(),
  body('collectPaymentNow').optional().toBoolean(),
  body('paymentMethod').optional().isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('paymentCashAmount').optional().isFloat({ min: 0 }),
  body('paymentOnlineAmount').optional().isFloat({ min: 0 })
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

    const { customerId, carId, serviceIds, services: servicesBody, beforeImages, notes, estimatedDelivery: estimatedDeliveryBody, assignedTo: assignedToBody, customerPackageId, advancePayment: advanceBody } = req.body;
    const directBill = !!req.body.directBill;
    const collectPaymentNow = req.body.collectPaymentNow === true;

    if (directBill && !isModuleEnabled(req.businessModules, 'variableServices')) {
      return moduleDisabledResponse(res, 'variableServices');
    }

    const hasServicesArray = Array.isArray(servicesBody) && servicesBody.length > 0;
    const hasServiceIds = Array.isArray(serviceIds) && serviceIds.length > 0;
    if (!hasServicesArray && !hasServiceIds) {
      return res.status(400).json({
        success: false,
        message: 'At least one service is required'
      });
    }

    if (!req.branchId) {
      return res.status(400).json({
        success: false,
        message: 'Select an active branch before creating a job or sale'
      });
    }

    // Check capacity (direct bill skips bay — job is created as DELIVERED)
    if (!directBill) {
      const capacityCheck = await canAcceptNewJob(req.businessId, req.branchId);
      if (!capacityCheck.canAccept) {
        return res.status(400).json({
          success: false,
          message: capacityCheck.reason
        });
      }
    }

    // Verify customer and car belong to business
    const customer = await Customer.findOne({
      _id: customerId,
      businessId: req.businessId
    });

    const car = carId
      ? await Car.findOne({
        _id: carId,
        businessId: req.businessId,
        customerId: customerId
      })
      : null;

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    if (!directBill && !car) {
      return res.status(404).json({
        success: false,
        message: 'Customer or car not found'
      });
    }

    if (directBill && carId && !car) {
      return res.status(404).json({
        success: false,
        message: 'Car not found for this customer'
      });
    }

    // Fetch and validate services (supports variable pricing via services[] body)
    let lines;
    let catalogServices;
    let totalPrice;
    try {
      ({ lines, totalPrice, catalogServices } = await resolveJobServiceLines(req.businessId, {
        serviceIds: hasServiceIds ? serviceIds : undefined,
        services: hasServicesArray ? servicesBody : undefined
      }));
    } catch (svcErr) {
      return res.status(svcErr.status || 400).json({
        success: false,
        message: svcErr.message || 'Invalid services',
        ...(svcErr.missingServiceIds ? { missingServiceIds: svcErr.missingServiceIds } : {})
      });
    }

    if (directBill) {
      try {
        assertDirectBillEligible(catalogServices);
      } catch (billErr) {
        return res.status(billErr.status || 400).json({ success: false, message: billErr.message });
      }
    } else {
      const productSalesOnJob = catalogServices.filter((s) => s.isVariable && s.skipWorkProcess);
      if (productSalesOnJob.length) {
        return res.status(400).json({
          success: false,
          message: 'Product sale services (skip work process) must be sold as direct sales from the Variable Service tab'
        });
      }
    }

    const advancePayment = directBill
      ? 0
      : (advanceBody != null && advanceBody !== '' ? Math.max(0, Number(advanceBody)) : 0);
    if (advancePayment > totalPrice + 1e-6) {
      return res.status(400).json({
        success: false,
        message: 'Advance payment cannot exceed the job service total'
      });
    }
    let advanceFields;
    try {
      advanceFields = directBill
        ? normalizeJobAdvanceForCreate({ ...req.body, advancePayment: 0 }, 0)
        : normalizeJobAdvanceForCreate(req.body, advancePayment);
    } catch (advErr) {
      return res.status(advErr.status || 400).json({ success: false, message: advErr.message || 'Invalid advance split' });
    }
    const now = new Date();
    const estimatedDelivery = directBill
      ? now
      : ((estimatedDeliveryBody && !isNaN(Date.parse(estimatedDeliveryBody)))
        ? new Date(estimatedDeliveryBody)
        : calculateETA(catalogServices));

    // Create job with retry logic for duplicate token numbers
    let job;
    let attempts = 0;
    const maxAttempts = 5;
    
    while (attempts < maxAttempts) {
      try {
        // Generate token number
        const tokenNumber = await generateTokenNumber(req.businessId, req.branchId);

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
          branchId: req.branchId || null,
          customerId,
          ...(car?._id ? { carId: car._id } : {}),
          tokenNumber,
          totalPrice,
          ...advanceFields,
          estimatedDelivery,
          beforeImages: directBill ? [] : (Array.isArray(beforeImages) ? beforeImages : []),
          notes,
          assignedTo,
          customerPackageId: customerPackageId || null,
          services: lines,
          ...(directBill
            ? {
              status: 'DELIVERED',
              actualDelivery: now,
              directBill: true,
              statusHistory: directBillStatusHistory(now)
            }
            : {
              statusHistory: [{ status: 'RECEIVED', changedAt: now }]
            })
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

    if (directBill) {
      let invoice;
      let paid = false;
      let settlementWarning = null;
      try {
        ({ invoice, paid, settlementWarning } = await finalizeDirectBillSale({
          job,
          businessId: req.businessId,
          userId: req.user._id,
          customer,
          car,
          catalogServices,
          collectPaymentNow,
          paymentBody: {
            paymentMethod: req.body.paymentMethod,
            paymentCashAmount: req.body.paymentCashAmount,
            paymentOnlineAmount: req.body.paymentOnlineAmount
          }
        }));
      } catch (billErr) {
        return res.status(billErr.status || 400).json({
          success: false,
          message: billErr.message || 'Failed to create invoice for direct sale'
        });
      }

      await job.populate('customerId', 'name phone whatsappNumber');
      await job.populate('carId', 'carNumber brand model color');
      await job.populate('services.serviceId', 'name isVariable');

      return res.status(201).json({
        success: true,
        job,
        invoice,
        directBill: true,
        paid,
        ...(settlementWarning ? { settlementWarning } : {})
      });
    }

    // Populate for response
    await job.populate('customerId', 'name phone whatsappNumber');
    await job.populate('carId', 'carNumber brand model color');
    await job.populate('services.serviceId', 'name isVariable');

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

    // Push notification to business owner + assigned employee (job_received)
    try {
      const ownerId = req.user.role === 'CAR_WASH_ADMIN'
        ? req.user._id
        : (await User.findOne({ businessId: req.businessId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' }).select('_id').lean())?._id;
      if (ownerId) {
        const pushRes = await sendPushNotification({
          businessOwnerId: ownerId,
          title: 'New booking received',
          body: `Token ${job.tokenNumber} · ${customer?.name || 'Customer'}`,
          data: { type: 'job_received', bookingId: job._id, url: `/admin/jobs/${job._id}` }
        });
        console.log('Push job_received:', pushRes);
      }

      // If job is assigned, notify that employee too
      if (job.assignedTo) {
        const pushEmp = await sendPushNotification({
          businessOwnerId: job.assignedTo,
          title: 'New job assigned',
          body: `Token ${job.tokenNumber} · ${customer?.name || 'Customer'}`,
          data: { type: 'job_received', bookingId: job._id, url: `/employee/jobs/${job._id}` }
        });
        console.log('Push job_received (employee):', pushEmp);
      }
    } catch (pushErr) {
      console.warn('Push notification error (job_received):', pushErr?.message || pushErr);
    }
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

    const jobFilter = jobAccessFilter(req, { _id: req.params.id });
    const job = await Job.findOne(jobFilter).populate('customerId', 'name whatsappNumber phone').populate('carId', 'carNumber');

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }
    assertBranchAccess(req, job, { allowLegacyNull: true });

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

    // Package integration (optional): deduct ONE visit only on completion (DELIVERED).
    // Idempotent: uses bookingId=job._id to avoid double-deduct on repeated status updates.
    if (status === 'DELIVERED' && job.customerPackageId) {
      try {
        const already = await PackageVisit.findOne({
          businessId: req.businessId,
          customerPackageId: job.customerPackageId,
          bookingId: job._id,
          status: 'completed'
        }).select('_id').lean();
        if (!already) {
          const now = new Date();
          const decremented = await CustomerPackage.findOneAndUpdate(
            {
              _id: job.customerPackageId,
              businessId: req.businessId,
              status: 'active',
              visitsRemaining: { $gt: 0 },
              expiryDate: { $gte: now }
            },
            { $inc: { visitsUsed: 1, visitsRemaining: -1 } },
            { new: true }
          );
          if (decremented) {
            if (decremented.visitsRemaining === 0) {
              await CustomerPackage.updateOne({ _id: decremented._id }, { $set: { status: 'completed' } });
            }
            await PackageVisit.create({
              businessId: req.businessId,
              branchId: job.branchId || req.branchId || null,
              customerPackageId: decremented._id,
              bookingId: job._id,
              date: now,
              status: 'completed',
              notes: `Auto from job ${job.tokenNumber}`
            });
          }
        }
      } catch (pkgErr) {
        console.error('Package visit completion error:', pkgErr);
      }
    }

    // Send WhatsApp notification
    try {
      const template = await WhatsAppTemplate.findOne({
        $or: [
          { businessId: req.businessId, name: `Job ${status}`, isActive: true },
          { isGlobal: true, name: `Job ${status}`, isActive: true }
        ]
      });

      if (template && job.customerId?.whatsappNumber) {
        const message = formatTemplate(template.template, {
          customerName: job.customerId?.name || 'Customer',
          carNumber: job.carId?.carNumber || '—',
          tokenNumber: job.tokenNumber,
          status,
          totalPrice: String(job.totalPrice ?? 0)
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
    await job.populate('services.serviceId', 'name isVariable');

    res.json({
      success: true,
      job
    });
  } catch (error) {
    console.error('Update job status error:', error);
    res.status(error?.status || 500).json({
      success: false,
      message: error?.message || 'Server error'
    });
  }
});

// @route   PUT /api/admin/jobs/:id
// @desc    Edit job (services/notes/ETA) while not delivered
// @access  Private (Car Wash Admin, Employee on assigned job)
router.put('/jobs/:id', [
  body('serviceIds').optional().isArray({ min: 1 }),
  body('services').optional().isArray({ min: 1 }),
  body('notes').optional().isString(),
  body('estimatedDelivery').optional().isISO8601()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const errList = errors.array();
      const firstMsg = errList[0]?.msg || errList[0]?.message || 'Validation failed';
      return res.status(400).json({ success: false, message: firstMsg, errors: errList });
    }

    const job = await Job.findOne(jobAccessFilter(req, { _id: req.params.id }));
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    assertBranchAccess(req, job, { allowLegacyNull: true });

    if (job.status === 'DELIVERED' || job.status === 'CANCELLED') {
      return res.status(400).json({
        success: false,
        message: 'Delivered/cancelled jobs cannot be edited'
      });
    }

    const { serviceIds, services: servicesBody, notes, estimatedDelivery } = req.body;

    if (typeof notes === 'string') {
      job.notes = notes.trim();
    }

    const hasServicesArray = Array.isArray(servicesBody) && servicesBody.length > 0;
    const hasServiceIds = Array.isArray(serviceIds) && serviceIds.length > 0;

    // Update services (and total/ETA) if provided
    if (hasServicesArray || hasServiceIds) {
      let lines;
      let catalogServices;
      let totalPrice;
      try {
        ({ lines, totalPrice, catalogServices } = await resolveJobServiceLines(req.businessId, {
          serviceIds: hasServiceIds ? serviceIds : undefined,
          services: hasServicesArray ? servicesBody : undefined
        }));
      } catch (svcErr) {
        return res.status(svcErr.status || 400).json({
          success: false,
          message: svcErr.message || 'Invalid services'
        });
      }

      job.services = lines;
      job.totalPrice = totalPrice;

      const advanceOnJob = Math.max(0, Number(job.advancePayment) || 0);
      if (advanceOnJob > totalPrice + 1e-6) {
        return res.status(400).json({
          success: false,
          message: 'Job advance payment exceeds the new services total. Adjust advance before removing or changing services.'
        });
      }

      job.estimatedDelivery = (estimatedDelivery && !isNaN(Date.parse(estimatedDelivery)))
        ? new Date(estimatedDelivery)
        : calculateETA(catalogServices);

      const draftInvoice = await Invoice.findOne({
        businessId: req.businessId,
        jobId: job._id,
        paymentStatus: { $ne: 'RECEIVED' }
      });
      if (draftInvoice) {
        await job.populate('services.serviceId', 'name');
        await syncDraftInvoiceFromJob(draftInvoice, job);
      }
    } else if (estimatedDelivery && !isNaN(Date.parse(estimatedDelivery))) {
      // Allow ETA-only edit without touching services
      job.estimatedDelivery = new Date(estimatedDelivery);
    }

    await job.save();

    await job.populate('customerId', 'name phone whatsappNumber');
    await job.populate('carId', 'carNumber brand model color');
    await job.populate('services.serviceId', 'name isVariable');
    await job.populate('assignedTo', 'name employeeCode email');

    res.json({ success: true, job });
  } catch (error) {
    console.error('Edit job error:', error);
    res.status(error?.status || 500).json({ success: false, message: error?.message || 'Server error' });
  }
});

// @route   DELETE /api/admin/jobs/:id
// @desc    Permanently delete a job (business owner only). Not allowed for DELIVERED or if an invoice exists.
// @access  Private — CAR_WASH_ADMIN only
router.delete('/jobs/:id', async (req, res) => {
  try {
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can delete jobs.'
      });
    }

    const job = await Job.findOne(jobAccessFilter(req, { _id: req.params.id }));
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    assertBranchAccess(req, job, { allowLegacyNull: true });

    if (job.status === 'DELIVERED') {
      return res.status(400).json({
        success: false,
        message: 'Delivered jobs cannot be deleted.'
      });
    }

    const invoice = await Invoice.findOne({ businessId: req.businessId, jobId: job._id }).select('_id').lean();
    if (invoice) {
      return res.status(400).json({
        success: false,
        message: 'This job has an invoice and cannot be deleted.'
      });
    }

    await WhatsAppMessage.deleteMany({ businessId: req.businessId, jobId: job._id });
    await Job.deleteOne({ _id: job._id });

    res.json({ success: true, message: 'Job deleted successfully' });
  } catch (error) {
    console.error('Delete job error:', error);
    res.status(error?.status || 500).json({ success: false, message: error?.message || 'Server error' });
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
    if (!isBusinessOwner(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the business owner can update business profile.' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const allowedFields = [
      'businessName', 'ownerName', 'email', 'phone', 'whatsappNumber', 'address', 'location',
      'workingHoursStart', 'workingHoursEnd', 'carHandlingCapacity', 'maxConcurrentJobs',
      'defaultCurrency', 'defaultLanguage', 'logo', 'googleReviewLink'
    ];
    const update = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    const business = await Business.findByIdAndUpdate(
      req.businessId,
      update,
      { new: true, runValidators: true }
    );

    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }

    if (req.body.maxConcurrentJobs != null || req.body.carHandlingCapacity != null) {
      const { syncMaxConcurrentJobsForBusiness } = await import('../services/branchService.js');
      await syncMaxConcurrentJobsForBusiness(req.businessId, { business });
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
    settingsObj.whatsappTemplates = normalizeWhatsappTemplates(settingsObj.whatsappTemplates);
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
  body('whatsappTemplates.workStarted').optional().isString(),
  body('whatsappTemplates.inProgress').optional().isString(),
  body('whatsappTemplates.washing').optional().isString(),
  body('whatsappTemplates.drying').optional().isString(),
  body('whatsappTemplates.completed').optional().isString(),
  body('whatsappTemplates.delivered').optional().isString(),
  body('whatsappTemplates.invoiceShare').optional().isString(),
  body('whatsappTemplates.invoicePackage').optional().isString(),
  body('whatsappTemplates.googleReview').optional().isString(),
  body('upiId').optional().trim().isString(),
  body('qrCodeImage').optional().trim().isString(),
  body('paymentMobileNumber').optional().trim().isString(),
  body('gstNumber').optional({ nullable: true }).trim().isString(),
  body('taxPercentage').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
  body('loyaltyPointValueInr').optional({ nullable: true }).isFloat({ min: 0 }),
  body('loyaltyMaxRedeemPointsPerJob').optional({ nullable: true }).isInt({ min: 0 })
], async (req, res) => {
  try {
    if (!isBusinessOwner(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the business owner can change shop settings.' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    let settings = await BusinessSettings.findOne({ businessId: req.businessId });

    const updateFields = {};
    if (req.body.capacity !== undefined) updateFields.capacity = req.body.capacity;
    if (req.body.timezone !== undefined) updateFields.timezone = req.body.timezone;
    if (req.body.autoSendWhatsApp !== undefined) updateFields.autoSendWhatsApp = req.body.autoSendWhatsApp;
    if (req.body.workingHours !== undefined) updateFields.workingHours = req.body.workingHours;
    if (req.body.notificationPreferences !== undefined) updateFields.notificationPreferences = req.body.notificationPreferences;
    if (req.body.shopWhatsappNumber !== undefined) updateFields.shopWhatsappNumber = req.body.shopWhatsappNumber?.trim() || null;
    if (req.body.googleReviewLink !== undefined) updateFields.googleReviewLink = req.body.googleReviewLink?.trim() || null;
    if (req.body.whatsappTemplates !== undefined) {
      const existing = normalizeWhatsappTemplates(settings?.whatsappTemplates);
      updateFields.whatsappTemplates = normalizeWhatsappTemplates({
        ...existing,
        ...req.body.whatsappTemplates
      });
    }
    if (req.body.upiId !== undefined) updateFields.upiId = req.body.upiId?.trim() || null;
    if (req.body.qrCodeImage !== undefined) updateFields.qrCodeImage = req.body.qrCodeImage?.trim() || null;
    if (req.body.paymentMobileNumber !== undefined) updateFields.paymentMobileNumber = req.body.paymentMobileNumber?.trim() || null;
    if (req.body.gstNumber !== undefined) {
      updateFields.gstNumber = req.body.gstNumber?.trim() || null;
      if (!updateFields.gstNumber) updateFields.taxPercentage = null;
    }
    if (req.body.taxPercentage !== undefined) updateFields.taxPercentage = req.body.taxPercentage;
    if (req.body.loyaltyPointValueInr !== undefined) updateFields.loyaltyPointValueInr = req.body.loyaltyPointValueInr === '' ? 0 : Number(req.body.loyaltyPointValueInr);
    if (req.body.loyaltyMaxRedeemPointsPerJob !== undefined) updateFields.loyaltyMaxRedeemPointsPerJob = req.body.loyaltyMaxRedeemPointsPerJob === '' ? 0 : Number(req.body.loyaltyMaxRedeemPointsPerJob);

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
    settingsObj.whatsappTemplates = normalizeWhatsappTemplates(settingsObj.whatsappTemplates);
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

async function getPlatformDefaultCurrency() {
  const platform = await PlatformSettings.findOne({}).select('defaultCurrency').lean();
  return platform?.defaultCurrency || 'USD';
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
      invalidateSubscriptionCache(req.businessId);
      await subscription.populate('planId', 'name description validityDays features isActive isFreeTrial price');
    }
    const subObj = subscription.toObject ? subscription.toObject() : subscription;
    if (subObj.expiryDate && new Date(subObj.expiryDate) < new Date() && subObj.status === 'ACTIVE') {
      await ShopSubscription.updateOne(
        { _id: subscription._id },
        { status: 'EXPIRED' }
      );
      invalidateSubscriptionCache(req.businessId);
      subObj.status = 'EXPIRED';
    }
    const business = await Business.findById(req.businessId).select('freeTrialUsed').lean();
    const freeTrialUsed = business?.freeTrialUsed === true;
    const hasPendingUpgrade = await PlanUpgradeRequest.exists({ shopId: req.businessId, status: 'PENDING' });
    const canRequestUpgrade = !hasPendingUpgrade;
    const currency = await getPlatformDefaultCurrency();
    const enabledModules = await getBusinessModules(req.businessId);
    res.json({ success: true, subscription: subObj, canRequestUpgrade, freeTrialUsed, currency, enabledModules });
  } catch (error) {
    console.error('Get my-subscription error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/branch-licenses
// @desc    Branch subscription licenses for business owner (My Plan)
// @access  Private (Car Wash Admin / business owner only)
router.get('/branch-licenses', async (req, res) => {
  try {
    if (!isBusinessOwner(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const modules = await getBusinessModules(req.businessId);
    if (!isModuleEnabled(modules, 'branches')) {
      return res.json({
        success: true,
        branchesEnabled: false,
        config: null,
        branches: [],
        requests: [],
        pendingCreate: false
      });
    }
    await ensureDefaultBranchForBusiness(req.businessId);
    const config = await getBranchUsageStats(req.businessId);
    const branches = await Branch.find({
      businessId: req.businessId,
      status: { $in: ['ACTIVE', 'EXPIRED', 'INACTIVE'] }
    })
      .sort({ isDefault: -1, name: 1 })
      .lean();
    const subs = await BranchSubscription.find({ businessId: req.businessId }).lean();
    const subByBranch = new Map(subs.map((s) => [String(s.branchId), s]));
    const requests = await BranchCreationRequest.find({ businessId: req.businessId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const pendingRenewalBranchIds = new Set(
      requests
        .filter((r) => r.status === 'PENDING' && r.requestType === 'RENEW')
        .map((r) => String(r.renewBranchId))
    );
    const pendingCreate = requests.some((r) => r.status === 'PENDING' && r.requestType === 'CREATE');
    const pendingRenewals = requests.filter((r) => r.status === 'PENDING' && r.requestType === 'RENEW');

    const enriched = await Promise.all(branches.map(async (b) => ({
      _id: b._id,
      name: b.name,
      code: b.code,
      isDefault: b.isDefault,
      status: b.status,
      moduleSuspended: b.status === 'INACTIVE',
      subscription: b.isDefault ? null : (subByBranch.get(String(b._id)) || null),
      operational: await isBranchOperational(b),
      pendingRenewal: pendingRenewalBranchIds.has(String(b._id)),
      canRequestRenewal: !b.isDefault
        && !!subByBranch.get(String(b._id))
        && !pendingRenewalBranchIds.has(String(b._id))
        && !pendingCreate
        && branchLicenseNeedsRenewal(b, subByBranch.get(String(b._id)))
    })));

    res.json({
      success: true,
      branchesEnabled: true,
      config,
      branches: enriched,
      requests,
      pendingCreate,
      pendingRenewals
    });
  } catch (error) {
    console.error('Get branch-licenses error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/branch-renewal-requests
// @desc    Branch license renewal requests for business owner
// @access  Private (Car Wash Admin / business owner only)
router.get('/branch-renewal-requests', async (req, res) => {
  try {
    if (!isBusinessOwner(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const requests = await BranchCreationRequest.find({
      businessId: req.businessId,
      requestType: 'RENEW'
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('renewBranchId', 'name code');
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Get branch-renewal-requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/admin/branch-renewal-request
// @desc    Submit branch license renewal request (like plan upgrade)
// @access  Private (Car Wash Admin / business owner only)
router.post('/branch-renewal-request', [
  body('branchId').notEmpty(),
  body('message').optional().trim()
], async (req, res) => {
  try {
    if (!isBusinessOwner(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const modules = await getBusinessModules(req.businessId);
    if (!isModuleEnabled(modules, 'branches')) {
      return moduleDisabledResponse(res, 'branches');
    }
    const config = await getBranchPlatformConfig();
    const request = await submitBranchRenewalRequest(
      req.businessId,
      req.user._id,
      req.body.branchId,
      req.body.message
    );
    res.status(201).json({
      success: true,
      request,
      expectedFee: config.branchAnnualFee,
      validityDays: config.branchValidityDays,
      message: `Renewal request submitted. ₹${config.branchAnnualFee}/year applies after Super Admin verifies payment.`
    });
  } catch (error) {
    console.error('Branch renewal request error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
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
    const currency = await getPlatformDefaultCurrency();
    res.json({ success: true, plans, freeTrialUsed, currency });
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
    if (business?.freeTrialUsed && isFreeTrialPlan(requestedPlan)) {
      return res.status(400).json({ success: false, message: 'Free trial is no longer available for your account.' });
    }
    const request = await PlanUpgradeRequest.create({
      shopId: req.businessId,
      currentPlanId: subscription.planId._id,
      requestedPlanId: req.body.requestedPlanId,
      message: req.body.message || undefined,
      status: 'PENDING'
    });

    // If the subscription is already expired, mark it as pending upgrade to keep the shop locked until Super Admin assigns a plan.
    try {
      const now = new Date();
      const exp = subscription?.expiryDate ? new Date(subscription.expiryDate) : null;
      const isExpired = subscription?.status === 'EXPIRED' || (exp && exp < now);
      if (isExpired) {
        await ShopSubscription.updateOne(
          { shopId: req.businessId },
          { status: 'PENDING_UPGRADE' }
        );
        invalidateSubscriptionCache(req.businessId);
      }
    } catch (_) {}

    await request.populate('currentPlanId', 'name');
    await request.populate('requestedPlanId', 'name validityDays features');
    res.status(201).json({ success: true, request });
  } catch (error) {
    console.error('Create upgrade request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== SETTLEMENT CHANGE REQUESTS ====================

async function loadJobInvoiceForSettlementRequest(req, jobId) {
  const jobFilter = { _id: jobId, businessId: req.businessId, status: 'DELIVERED' };
  if (req.user.role === 'EMPLOYEE') {
    jobFilter.assignedTo = req.user._id;
  }
  const job = await Job.findOne(jobFilter);
  if (!job) return { error: { status: 404, message: 'Delivered job not found or not assigned to you' } };

  const invoice = await Invoice.findOne({
    businessId: req.businessId,
    jobId: job._id,
    paymentStatus: 'RECEIVED'
  });
  if (!invoice) {
    return { error: { status: 400, message: 'Paid invoice required before requesting a settlement date change' } };
  }
  return { job, invoice };
}

// GET /api/admin/settlement-change-requests?status=PENDING|APPROVED|REJECTED|history&jobId=
router.get('/settlement-change-requests', async (req, res) => {
  try {
    const { status, jobId } = req.query;
    const query = { businessId: req.businessId };

    if (req.user.role === 'EMPLOYEE') {
      query.requestedBy = req.user._id;
      if (jobId && mongoose.isValidObjectId(String(jobId))) {
        query.jobId = jobId;
      }
    } else if (status === 'history') {
      query.status = { $in: ['APPROVED', 'REJECTED'] };
    } else if (status && ['PENDING', 'APPROVED', 'REJECTED'].includes(String(status))) {
      query.status = status;
    }

    const requests = await SettlementChangeRequest.find(query)
      .sort({ createdAt: -1 })
      .limit(req.user.role === 'EMPLOYEE' ? 20 : 100)
      .populate('requestedBy', 'name email employeeCode role')
      .populate('actionedBy', 'name email')
      .populate('jobId', 'tokenNumber status actualDelivery')
      .populate('invoiceId', 'invoiceNumber paymentReceivedAt createdAt')
      .lean();

    const pendingCount =
      isAdminPanelRole(req.user.role)
        ? await SettlementChangeRequest.countDocuments({ businessId: req.businessId, status: 'PENDING' })
        : 0;

    res.json({ success: true, requests, pendingCount });
  } catch (error) {
    console.error('List settlement change requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/settlement-change-requests
router.post('/settlement-change-requests', [
  body('jobId').notEmpty().isMongoId(),
  body('proposedDeliveredAt').isISO8601().withMessage('Valid delivery date/time required'),
  body('proposedInvoiceAt').optional({ checkFalsy: true }).isISO8601(),
  body('reason').trim().notEmpty().isLength({ min: 3, max: 500 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    if (isAdminPanelRole(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Admins can edit settlement dates directly on the job or invoice page.'
      });
    }

    const { jobId, proposedDeliveredAt, reason } = req.body;
    const proposedInvoiceAt = req.body.proposedInvoiceAt || proposedDeliveredAt;

    const loaded = await loadJobInvoiceForSettlementRequest(req, jobId);
    if (loaded.error) {
      return res.status(loaded.error.status).json({ success: false, message: loaded.error.message });
    }
    const { job, invoice } = loaded;

    const existingPending = await SettlementChangeRequest.findOne({
      businessId: req.businessId,
      invoiceId: invoice._id,
      status: 'PENDING'
    });
    if (existingPending) {
      return res.status(400).json({
        success: false,
        message: 'A pending settlement change request already exists for this invoice'
      });
    }

    const request = await SettlementChangeRequest.create({
      businessId: req.businessId,
      jobId: job._id,
      invoiceId: invoice._id,
      requestedBy: req.user._id,
      tokenNumber: job.tokenNumber,
      previousDeliveredAt: job.actualDelivery || null,
      previousInvoiceAt: invoice.paymentReceivedAt || invoice.createdAt || null,
      proposedDeliveredAt: new Date(proposedDeliveredAt),
      proposedInvoiceAt: new Date(proposedInvoiceAt),
      reason,
      status: 'PENDING'
    });

    try {
      const ownerId =
        req.user.role === 'CAR_WASH_ADMIN'
          ? req.user._id
          : (
              await User.findOne({
                businessId: req.businessId,
                role: 'CAR_WASH_ADMIN',
                status: 'ACTIVE'
              })
                .select('_id')
                .lean()
            )?._id;
      if (ownerId && req.user.role === 'EMPLOYEE') {
        await sendPushNotification({
          businessOwnerId: ownerId,
          title: 'Settlement date change request',
          body: `${job.tokenNumber}: review in Settings`,
          data: {
            type: 'settlement_change_request',
            jobId: String(job._id),
            requestId: String(request._id),
            url: '/admin/settings?tab=settlement-requests'
          }
        });
      }
    } catch (pushErr) {
      console.warn('Push settlement change request error:', pushErr?.message || pushErr);
    }

    await request.populate('requestedBy', 'name email employeeCode role');
    await request.populate('jobId', 'tokenNumber status actualDelivery');
    await request.populate('invoiceId', 'invoiceNumber paymentReceivedAt createdAt');

    res.status(201).json({ success: true, request });
  } catch (error) {
    console.error('Create settlement change request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/settlement-change-requests/:id/approve
router.patch('/settlement-change-requests/:id/approve', adminPanelOnly, async (req, res) => {
  try {
    const request = await SettlementChangeRequest.findOne({
      _id: req.params.id,
      businessId: req.businessId
    });
    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    if (request.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: 'Request is not pending' });
    }

    const job = await Job.findOne({ _id: request.jobId, businessId: req.businessId, status: 'DELIVERED' });
    const invoice = await Invoice.findOne({
      _id: request.invoiceId,
      businessId: req.businessId,
      jobId: request.jobId,
      paymentStatus: 'RECEIVED'
    });
    if (!job || !invoice) {
      return res.status(400).json({ success: false, message: 'Job or paid invoice no longer available' });
    }

    const { deliveredAt, invoiceAt } = await applySettlementDateChange({
      job,
      invoice,
      proposedDeliveredAt: request.proposedDeliveredAt,
      proposedInvoiceAt: request.proposedInvoiceAt
    });

    request.status = 'APPROVED';
    request.actionedBy = req.user._id;
    request.actionedAt = new Date();
    request.appliedDeliveredAt = deliveredAt;
    request.appliedInvoiceAt = invoiceAt;
    await request.save();

    await request.populate('requestedBy', 'name email employeeCode role');
    await request.populate('actionedBy', 'name email');
    await request.populate('jobId', 'tokenNumber status actualDelivery');
    await request.populate('invoiceId', 'invoiceNumber paymentReceivedAt createdAt');

    res.json({ success: true, request, message: 'Settlement dates updated' });
  } catch (error) {
    console.error('Approve settlement change request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/settlement-change-requests/:id/reject
router.patch('/settlement-change-requests/:id/reject', adminPanelOnly, [
  body('reviewNote').optional().trim().isLength({ max: 500 })
], async (req, res) => {
  try {
    const request = await SettlementChangeRequest.findOne({
      _id: req.params.id,
      businessId: req.businessId
    });
    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    if (request.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: 'Request is not pending' });
    }

    request.status = 'REJECTED';
    request.actionedBy = req.user._id;
    request.actionedAt = new Date();
    request.reviewNote = req.body.reviewNote || undefined;
    await request.save();

    await request.populate('requestedBy', 'name email employeeCode role');
    await request.populate('actionedBy', 'name email');
    await request.populate('jobId', 'tokenNumber status actualDelivery');
    await request.populate('invoiceId', 'invoiceNumber paymentReceivedAt createdAt');

    res.json({ success: true, request, message: 'Request rejected' });
  } catch (error) {
    console.error('Reject settlement change request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/jobs/:id/settlement-dates — business owner direct edit (no approval workflow)
router.patch('/jobs/:id/settlement-dates', adminPanelOnly, [
  body('deliveredAt').isISO8601().withMessage('Valid delivery date/time required'),
  body('invoiceAt').optional({ checkFalsy: true }).isISO8601(),
  body('note').optional().trim().isLength({ max: 500 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const job = await Job.findOne({
      _id: req.params.id,
      businessId: req.businessId,
      status: 'DELIVERED'
    });
    if (!job) {
      return res.status(404).json({ success: false, message: 'Delivered job not found' });
    }

    const invoice = await Invoice.findOne({
      businessId: req.businessId,
      jobId: job._id,
      paymentStatus: 'RECEIVED'
    });
    if (!invoice) {
      return res.status(400).json({ success: false, message: 'Paid invoice required to edit settlement dates' });
    }

    const deliveredAtInput = new Date(req.body.deliveredAt);
    const invoiceAtInput = new Date(req.body.invoiceAt || req.body.deliveredAt);
    const previousDeliveredAt = job.actualDelivery || null;
    const previousInvoiceAt = invoice.paymentReceivedAt || invoice.createdAt || null;

    const { deliveredAt, invoiceAt } = await applySettlementDateChange({
      job,
      invoice,
      proposedDeliveredAt: deliveredAtInput,
      proposedInvoiceAt: invoiceAtInput
    });

    await SettlementChangeRequest.updateMany(
      { businessId: req.businessId, invoiceId: invoice._id, status: 'PENDING' },
      {
        status: 'REJECTED',
        actionedBy: req.user._id,
        actionedAt: new Date(),
        reviewNote: 'Superseded by owner direct edit'
      }
    );

    const audit = await SettlementChangeRequest.create({
      businessId: req.businessId,
      jobId: job._id,
      invoiceId: invoice._id,
      requestedBy: req.user._id,
      tokenNumber: job.tokenNumber,
      previousDeliveredAt,
      previousInvoiceAt,
      proposedDeliveredAt: deliveredAt,
      proposedInvoiceAt: invoiceAt,
      reason: req.body.note?.trim() || 'Direct edit by business owner',
      status: 'APPROVED',
      actionedBy: req.user._id,
      actionedAt: new Date(),
      appliedDeliveredAt: deliveredAt,
      appliedInvoiceAt: invoiceAt
    });

    res.json({
      success: true,
      message: 'Settlement dates updated',
      job: {
        _id: job._id,
        actualDelivery: deliveredAt,
        tokenNumber: job.tokenNumber
      },
      invoice: {
        _id: invoice._id,
        paymentReceivedAt: invoiceAt,
        createdAt: invoiceAt
      },
      auditId: audit._id
    });
  } catch (error) {
    console.error('Direct settlement date edit error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
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
