import express from 'express';
import mongoose from 'mongoose';
import { body, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveBranchContext } from '../middleware/branchContext.middleware.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import { adminPanelOnly } from '../middleware/adminPanel.middleware.js';
import { isAdminPanelRole } from '../utils/adminRoles.js';
import { moduleDisabledResponse } from '../middleware/businessModules.middleware.js';
import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import OtherRevenueType from '../models/OtherRevenueType.model.js';
import OtherRevenue from '../models/OtherRevenue.model.js';
import {
  resolveExpensePaymentFields,
  sumExpenseChannelTotals,
  applyExpensePayablePayment,
  expensePaymentStatusQuery
} from '../utils/expensePayment.js';
import { scopedFilter, assertBranchAccess, findScoped } from '../utils/branchAccess.js';
import { applyBranchScope } from '../utils/branchQuery.js';
import { parseBusinessCalendarDate } from '../utils/calendarDate.js';
import { parseBusinessDateRange } from '../utils/businessDateRange.js';

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
router.use(enforceActiveSubscription());

async function requireOtherRevenueEnabled(req, res, next) {
  try {
    const settings = await BusinessSettings.findOne({ businessId: req.businessId })
      .select('otherRevenueEnabled')
      .lean();
    if (!settings?.otherRevenueEnabled) {
      return res.status(403).json({
        success: false,
        message: 'Other Revenue is disabled. Enable it in Settings.',
        code: 'OTHER_REVENUE_DISABLED'
      });
    }
    next();
  } catch (e) {
    next(e);
  }
}

router.use((req, res, next) => {
  if (isAdminPanelRole(req.user?.role) || req.user?.role === 'EMPLOYEE') return next();
  return res.status(403).json({ success: false, message: 'Access denied' });
});

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      message: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array()
    });
    return false;
  }
  return true;
}

function dateRangeQuery(start, end, exclusiveEnd) {
  return exclusiveEnd ? { $gte: start, $lt: end } : { $gte: start, $lte: end };
}

function parseRevenueDateRange(range, from, to, businessTz) {
  if (businessTz !== undefined) {
    const { startUtc, endUtc } = parseBusinessDateRange(businessTz, range, from, to);
    return { start: startUtc, end: endUtc, exclusiveEnd: true };
  }
  const now = new Date();
  let start;
  let end;
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

async function loadReportDateRange(businessId, range, from, to) {
  const settings = await BusinessSettings.findOne({ businessId }).select('timezone').lean();
  return parseRevenueDateRange(range, from, to, settings?.timezone);
}

// ---------- Types ----------
router.get('/other-revenue-types', async (req, res) => {
  try {
    const types = await OtherRevenueType.find({ businessId: req.businessId }).sort({ revenueName: 1 }).lean();
    res.json({ success: true, otherRevenueTypes: types });
  } catch (error) {
    console.error('List other revenue types error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/other-revenue-types', adminPanelOnly, [
  body('revenueName').notEmpty().trim()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const name = String(req.body.revenueName || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Enter a revenue type name' });
    }
    const exists = await OtherRevenueType.findOne({
      businessId: req.businessId,
      revenueName: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    }).lean();
    if (exists) {
      return res.status(400).json({ success: false, message: 'A revenue type with this name already exists' });
    }
    const otherRevenueType = await OtherRevenueType.create({
      businessId: req.businessId,
      revenueName: name
    });
    res.status(201).json({ success: true, otherRevenueType });
  } catch (error) {
    console.error('Create other revenue type error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/other-revenue-types/:id', adminPanelOnly, [
  body('revenueName').optional().notEmpty().trim()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const otherRevenueType = await OtherRevenueType.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!otherRevenueType) {
      return res.status(404).json({ success: false, message: 'Revenue type not found' });
    }
    if (req.body.revenueName != null) {
      const name = String(req.body.revenueName || '').trim();
      if (!name) {
        return res.status(400).json({ success: false, message: 'Enter a revenue type name' });
      }
      const clash = await OtherRevenueType.findOne({
        businessId: req.businessId,
        _id: { $ne: otherRevenueType._id },
        revenueName: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      }).lean();
      if (clash) {
        return res.status(400).json({ success: false, message: 'A revenue type with this name already exists' });
      }
      otherRevenueType.revenueName = name;
    }
    await otherRevenueType.save();
    res.json({ success: true, otherRevenueType });
  } catch (error) {
    console.error('Update other revenue type error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/other-revenue-types/:id', adminPanelOnly, async (req, res) => {
  try {
    const inUse = await OtherRevenue.countDocuments({
      businessId: req.businessId,
      otherRevenueTypeId: req.params.id
    });
    if (inUse > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete: ${inUse} revenue entr${inUse === 1 ? 'y uses' : 'ies use'} this type`
      });
    }
    const otherRevenueType = await OtherRevenueType.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId
    });
    if (!otherRevenueType) {
      return res.status(404).json({ success: false, message: 'Revenue type not found' });
    }
    res.json({ success: true, message: 'Revenue type deleted' });
  } catch (error) {
    console.error('Delete other revenue type error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Entries (feature must be enabled) ----------
router.get('/other-revenues', requireOtherRevenueEnabled, async (req, res) => {
  try {
    const { range = 'today', from, to, search, otherRevenueTypeId, paymentStatus } = req.query;
    const settings = await BusinessSettings.findOne({ businessId: req.businessId }).select('timezone').lean();
    const { start, end, exclusiveEnd } = parseRevenueDateRange(range, from, to, settings?.timezone);
    const query = scopedFilter(req, { revenueDate: dateRangeQuery(start, end, exclusiveEnd) });
    if (otherRevenueTypeId && String(otherRevenueTypeId).trim()) {
      query.otherRevenueTypeId = String(otherRevenueTypeId).trim();
    }
    const andClauses = [];
    const statusFilter = expensePaymentStatusQuery(paymentStatus);
    if (statusFilter) andClauses.push(statusFilter);
    if (search && typeof search === 'string' && search.trim()) {
      const termRaw = search.trim();
      const term = termRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const or = [{ notes: { $regex: term, $options: 'i' } }];
      const asNumber = Number(termRaw);
      if (!Number.isNaN(asNumber)) or.push({ amount: asNumber });
      const typeIds = await OtherRevenueType.find({
        businessId: req.businessId,
        revenueName: { $regex: term, $options: 'i' }
      }).distinct('_id');
      if (typeIds?.length) or.push({ otherRevenueTypeId: { $in: typeIds } });
      andClauses.push({ $or: or });
    }
    if (andClauses.length === 1) Object.assign(query, andClauses[0]);
    else if (andClauses.length > 1) query.$and = andClauses;

    const otherRevenues = await OtherRevenue.find(query)
      .populate('otherRevenueTypeId', 'revenueName')
      .populate('createdBy', 'name email')
      .sort({ revenueDate: -1, createdAt: -1 })
      .lean();
    const totals = sumExpenseChannelTotals(otherRevenues);
    res.json({
      success: true,
      otherRevenues,
      totalAmount: totals.totalAmount,
      totalCashAmount: totals.totalCashAmount,
      totalOnlineAmount: totals.totalOnlineAmount,
      totalPaidAmount: totals.totalPaidAmount,
      totalOutstandingReceivable: totals.totalOutstandingPayable,
      start,
      end
    });
  } catch (error) {
    console.error('List other revenues error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/other-revenues', requireOtherRevenueEnabled, [
  body('revenueDate').optional().isISO8601(),
  body('entries').isArray({ min: 1 }),
  body('entries.*.otherRevenueTypeId').notEmpty(),
  body('entries.*.amount').isFloat({ min: 0.01 }),
  body('entries.*.notes').optional().trim(),
  body('entries.*.receiptImage').optional().trim(),
  body('entries.*.settlementMode').optional().isIn(['FULL', 'CREDIT']),
  body('entries.*.amountPaidNow').optional().isFloat({ min: 0 }),
  body('entries.*.creditDueDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('entries.*.paymentMethod').optional().isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('entries.*.paymentCashAmount').optional().isFloat({ min: 0 }),
  body('entries.*.paymentOnlineAmount').optional().isFloat({ min: 0 })
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const settings = await BusinessSettings.findOne({ businessId: req.businessId }).select('timezone').lean();
    const revenueDate = parseBusinessCalendarDate(req.body.revenueDate, settings?.timezone);
    const modules = req.businessModules || await getBusinessModules(req.businessId);
    const creditEnabled = isModuleEnabled(modules, 'credit');
    const typeIds = [...new Set(req.body.entries.map((e) => String(e.otherRevenueTypeId)))];
    const types = await OtherRevenueType.find({
      _id: { $in: typeIds },
      businessId: req.businessId
    }).lean();
    const typeById = new Map(types.map((t) => [String(t._id), t]));
    const created = [];
    for (const entry of req.body.entries) {
      const revenueType = typeById.get(String(entry.otherRevenueTypeId));
      if (!revenueType) {
        return res.status(400).json({ success: false, message: 'Invalid revenue type' });
      }
      const wantsCredit = String(entry.settlementMode || '').toUpperCase() === 'CREDIT';
      if (wantsCredit && !creditEnabled) {
        return moduleDisabledResponse(res, 'credit');
      }
      let paymentFields;
      try {
        paymentFields = resolveExpensePaymentFields(Number(entry.amount), {
          settlementMode: wantsCredit ? 'CREDIT' : 'FULL',
          amountPaidNow: entry.amountPaidNow,
          creditDueDate: entry.creditDueDate,
          paymentMethod: entry.paymentMethod,
          paymentCashAmount: entry.paymentCashAmount,
          paymentOnlineAmount: entry.paymentOnlineAmount
        });
      } catch (payErr) {
        return res.status(payErr.status || 400).json({ success: false, message: payErr.message });
      }
      const row = await OtherRevenue.create({
        businessId: req.businessId,
        branchId: req.branchId || null,
        otherRevenueTypeId: revenueType._id,
        amount: Number(entry.amount),
        notes: entry.notes || '',
        receiptImage: entry.receiptImage || undefined,
        revenueDate,
        createdBy: req.user._id,
        ...paymentFields
      });
      await row.populate('otherRevenueTypeId', 'revenueName');
      created.push(row);
    }
    res.status(201).json({ success: true, otherRevenues: created });
  } catch (error) {
    console.error('Create other revenues error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/other-revenues/:id', requireOtherRevenueEnabled, [
  body('otherRevenueTypeId').optional().notEmpty(),
  body('amount').optional().isFloat({ min: 0.01 }),
  body('notes').optional().trim(),
  body('receiptImage').optional().trim(),
  body('revenueDate').optional().isISO8601(),
  body('settlementMode').optional().isIn(['FULL', 'CREDIT']),
  body('amountPaidNow').optional().isFloat({ min: 0 }),
  body('creditDueDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('paymentMethod').optional().isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('paymentCashAmount').optional().isFloat({ min: 0 }),
  body('paymentOnlineAmount').optional().isFloat({ min: 0 })
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const row = await findScoped(OtherRevenue, req, { _id: req.params.id });
    if (!row) {
      return res.status(404).json({ success: false, message: 'Other revenue not found' });
    }
    assertBranchAccess(req, row);
    if (req.body.otherRevenueTypeId != null) {
      const revenueType = await OtherRevenueType.findOne({
        _id: req.body.otherRevenueTypeId,
        businessId: req.businessId
      });
      if (!revenueType) {
        return res.status(400).json({ success: false, message: 'Invalid revenue type' });
      }
      row.otherRevenueTypeId = revenueType._id;
    }
    if (req.body.amount != null) row.amount = Number(req.body.amount);
    const paymentTouched =
      req.body.paymentMethod !== undefined ||
      req.body.paymentCashAmount !== undefined ||
      req.body.paymentOnlineAmount !== undefined ||
      req.body.settlementMode !== undefined ||
      req.body.amountPaidNow !== undefined ||
      req.body.creditDueDate !== undefined ||
      req.body.amount != null;
    if (paymentTouched) {
      const modules = req.businessModules || await getBusinessModules(req.businessId);
      const creditEnabled = isModuleEnabled(modules, 'credit');
      const existingIsCredit = String(row.settlementMode || '').toUpperCase() === 'CREDIT';
      const requestedMode = req.body.settlementMode !== undefined
        ? String(req.body.settlementMode || '').toUpperCase()
        : (existingIsCredit ? 'CREDIT' : 'FULL');
      if (requestedMode === 'CREDIT' && !creditEnabled && !existingIsCredit) {
        return moduleDisabledResponse(res, 'credit');
      }
      const settlementMode =
        requestedMode === 'CREDIT' && (creditEnabled || existingIsCredit) ? 'CREDIT' : 'FULL';
      try {
        const paymentFields = resolveExpensePaymentFields(
          req.body.amount != null ? Number(req.body.amount) : row.amount,
          {
            settlementMode,
            amountPaidNow: req.body.amountPaidNow,
            creditDueDate: req.body.creditDueDate,
            paymentMethod: req.body.paymentMethod,
            paymentCashAmount: req.body.paymentCashAmount,
            paymentOnlineAmount: req.body.paymentOnlineAmount
          },
          row
        );
        Object.assign(row, paymentFields);
      } catch (payErr) {
        return res.status(payErr.status || 400).json({ success: false, message: payErr.message });
      }
    }
    if (req.body.notes !== undefined) row.notes = req.body.notes || '';
    if (req.body.receiptImage !== undefined) row.receiptImage = req.body.receiptImage || '';
    if (req.body.revenueDate != null) {
      const settings = await BusinessSettings.findOne({ businessId: req.businessId }).select('timezone').lean();
      row.revenueDate = parseBusinessCalendarDate(req.body.revenueDate, settings?.timezone);
    }
    await row.save();
    await row.populate('otherRevenueTypeId', 'revenueName');
    res.json({ success: true, otherRevenue: row });
  } catch (error) {
    console.error('Update other revenue error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/other-revenues/:id/pay', requireOtherRevenueEnabled, [
  body('amount').optional().isFloat({ min: 0.01 }),
  body('paymentMethod').optional().isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('paymentCashAmount').optional().isFloat({ min: 0 }),
  body('paymentOnlineAmount').optional().isFloat({ min: 0 })
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const row = await findScoped(OtherRevenue, req, { _id: req.params.id });
    if (!row) {
      return res.status(404).json({ success: false, message: 'Other revenue not found' });
    }
    assertBranchAccess(req, row);
    try {
      applyExpensePayablePayment(row, req.body);
    } catch (payErr) {
      return res.status(payErr.status || 400).json({ success: false, message: payErr.message });
    }
    await row.save();
    await row.populate('otherRevenueTypeId', 'revenueName');
    res.json({ success: true, otherRevenue: row });
  } catch (error) {
    console.error('Collect other revenue receivable error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/other-revenues/:id', requireOtherRevenueEnabled, async (req, res) => {
  try {
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Only business owners and branch admins can delete other revenue'
      });
    }
    const row = await OtherRevenue.findOneAndDelete(scopedFilter(req, { _id: req.params.id }));
    if (!row) {
      return res.status(404).json({ success: false, message: 'Other revenue not found' });
    }
    res.json({ success: true, message: 'Other revenue deleted' });
  } catch (error) {
    console.error('Delete other revenue error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/reports/other-revenues', requireOtherRevenueEnabled, adminPanelOnly, async (req, res) => {
  try {
    const { range = 'daily', from, to, otherRevenueTypeId, paymentStatus } = req.query;
    const { start, end, exclusiveEnd } = await loadReportDateRange(req.businessId, range, from, to);
    const query = applyBranchScope({
      businessId: req.businessId,
      revenueDate: dateRangeQuery(start, end, exclusiveEnd)
    }, req);
    if (otherRevenueTypeId && mongoose.isValidObjectId(String(otherRevenueTypeId))) {
      const type = await OtherRevenueType.findOne({
        _id: otherRevenueTypeId,
        businessId: req.businessId
      }).select('_id').lean();
      if (!type) {
        return res.status(400).json({ success: false, message: 'Invalid revenue type' });
      }
      query.otherRevenueTypeId = type._id;
    }
    const statusFilter = expensePaymentStatusQuery(paymentStatus);
    if (statusFilter) Object.assign(query, statusFilter);
    const otherRevenues = await OtherRevenue.find(query)
      .populate('otherRevenueTypeId', 'revenueName')
      .populate('createdBy', 'name email')
      .sort({ revenueDate: -1, createdAt: -1 })
      .lean();
    const totals = sumExpenseChannelTotals(otherRevenues);
    res.json({
      success: true,
      data: otherRevenues,
      totalAmount: totals.totalAmount,
      totalCashAmount: totals.totalCashAmount,
      totalOnlineAmount: totals.totalOnlineAmount,
      totalPaidAmount: totals.totalPaidAmount,
      totalOutstandingReceivable: totals.totalOutstandingPayable,
      summary: {
        totalEntries: otherRevenues.length,
        totalAmount: totals.totalAmount,
        totalCashAmount: totals.totalCashAmount,
        totalOnlineAmount: totals.totalOnlineAmount,
        totalPaidAmount: totals.totalPaidAmount,
        totalOutstandingReceivable: totals.totalOutstandingPayable
      },
      start,
      end
    });
  } catch (error) {
    console.error('Reports other revenues error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
