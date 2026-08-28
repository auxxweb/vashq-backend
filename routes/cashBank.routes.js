import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveBranchContext } from '../middleware/branchContext.middleware.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import { isAdminPanelRole } from '../utils/adminRoles.js';
import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';
import { moduleDisabledResponse } from '../middleware/businessModules.middleware.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import CashMovementType from '../models/CashMovementType.model.js';
import MoneyAccount from '../models/MoneyAccount.model.js';
import MoneyLedger from '../models/MoneyLedger.model.js';
import CashDaySession from '../models/CashDaySession.model.js';
import { parseBusinessDateRange } from '../utils/businessDateRange.js';
import { branchIdForCreate } from '../utils/branchAccess.js';
import { roundMoney } from '../utils/invoicePayment.js';
import {
  isCashAndBankEnabled,
  ensureMoneyAccountsForBranch,
  ensureDefaultMovementTypes,
  getBranchBalances,
  getBusinessBalances,
  getCashBankSummary,
  getAccountBook,
  recordDepositOrWithdrawal,
  recordTransfer,
  setOpeningBalance,
  openCashDay,
  closeCashDay
} from '../services/moneyBookService.js';

const router = express.Router();

router.use((req, res, next) => {
  const p = req.path || '';
  const isCashBank =
    p === '/cash-bank' ||
    p.startsWith('/cash-bank/') ||
    p === '/cash-movement-types' ||
    p.startsWith('/cash-movement-types/');
  if (!isCashBank) return next('router');
  return next();
});

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

async function requireCashAndBankEnabled(req, res, next) {
  try {
    const modules = req.businessModules || (await getBusinessModules(req.businessId));
    if (!isModuleEnabled(modules, 'accounting')) {
      return moduleDisabledResponse(res, 'accounting');
    }
    if (!(await isCashAndBankEnabled(req.businessId))) {
      return res.status(403).json({
        success: false,
        message: 'Cash & Bank is disabled. Enable it in Settings.',
        code: 'CASH_AND_BANK_DISABLED'
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

router.use(requireCashAndBankEnabled);

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

function resolveWriteBranchId(req) {
  try {
    return branchIdForCreate(req);
  } catch (e) {
    return req.branchId || null;
  }
}

async function loadDateBounds(req) {
  const settings = await BusinessSettings.findOne({ businessId: req.businessId })
    .select('timezone')
    .lean();
  const tz = settings?.timezone || 'Asia/Kolkata';
  const range = String(req.query.range || 'today');
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  return parseBusinessDateRange(tz, range, from, to);
}

// GET /api/admin/cash-bank/summary
router.get('/cash-bank/summary', async (req, res) => {
  try {
    // Never block page load on historical sync
    try {
      const { scheduleMaybeCashAndBankBackfill } = await import('../utils/cashBankBackfill.js');
      scheduleMaybeCashAndBankBackfill(req.businessId, { createdBy: req.user?._id });
    } catch (_) {}

    const { startUtc, endUtc, rangeLabel } = await loadDateBounds(req);
    const branchId = req.branchScope === 'all' ? null : (req.branchId || null);
    if (branchId) await ensureMoneyAccountsForBranch(req.businessId, branchId);
    else await ensureDefaultMovementTypes(req.businessId);

    const summary = await getCashBankSummary({
      businessId: req.businessId,
      branchId,
      startUtc,
      endUtc
    });
    res.json({ success: true, rangeLabel, startUtc, endUtc, summary });
  } catch (error) {
    console.error('Cash bank summary error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// GET /api/admin/cash-bank/balances
router.get('/cash-bank/balances', async (req, res) => {
  try {
    if (req.branchScope === 'all' || !req.branchId) {
      const balances = await getBusinessBalances(req.businessId);
      return res.json({ success: true, scope: 'all', balances });
    }
    await ensureMoneyAccountsForBranch(req.businessId, req.branchId);
    const balances = await getBranchBalances(req.businessId, req.branchId);
    res.json({ success: true, scope: 'branch', branchId: req.branchId, balances });
  } catch (error) {
    console.error('Cash bank balances error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// GET /api/admin/cash-bank/book?accountType=CASH|BANK
router.get('/cash-bank/book', async (req, res) => {
  try {
    const accountType = String(req.query.accountType || 'CASH').toUpperCase() === 'BANK' ? 'BANK' : 'CASH';
    const branchId = req.branchId || resolveWriteBranchId(req);
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Select a branch to view the cash/bank book' });
    }
    const { startUtc, endUtc, rangeLabel } = await loadDateBounds(req);
    const book = await getAccountBook({
      businessId: req.businessId,
      branchId,
      accountType,
      startUtc,
      endUtc
    });
    res.json({ success: true, rangeLabel, startUtc, endUtc, book });
  } catch (error) {
    console.error('Cash bank book error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// GET /api/admin/cash-bank/accounts
router.get('/cash-bank/accounts', async (req, res) => {
  try {
    const branchId = req.branchId || resolveWriteBranchId(req);
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Select a branch' });
    }
    await ensureMoneyAccountsForBranch(req.businessId, branchId);
    const accounts = await MoneyAccount.find({
      businessId: req.businessId,
      branchId
    }).lean();
    res.json({ success: true, accounts });
  } catch (error) {
    console.error('Cash bank accounts error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/admin/cash-bank/opening
router.put('/cash-bank/opening', [
  body('accountType').isIn(['CASH', 'BANK']),
  body('openingBalance').isFloat({ min: 0 }),
  body('openingDate').optional().isISO8601()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only admins can set opening balance' });
    }
    const branchId = resolveWriteBranchId(req);
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Select a branch before setting opening balance' });
    }
    const account = await setOpeningBalance({
      businessId: req.businessId,
      branchId,
      accountType: req.body.accountType,
      openingBalance: req.body.openingBalance,
      openingDate: req.body.openingDate ? new Date(req.body.openingDate) : new Date(),
      createdBy: req.user._id
    });
    res.json({ success: true, account, message: 'Opening balance updated' });
  } catch (error) {
    console.error('Set opening balance error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// POST /api/admin/cash-bank/deposit
router.post('/cash-bank/deposit', [
  body('accountType').isIn(['CASH', 'BANK']),
  body('amount').isFloat({ min: 0.01 }),
  body('movementTypeId').isMongoId(),
  body('notes').optional().trim(),
  body('entryDate').optional().isISO8601()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const branchId = resolveWriteBranchId(req);
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Select a branch' });
    }
    const entry = await recordDepositOrWithdrawal({
      businessId: req.businessId,
      branchId,
      accountType: req.body.accountType,
      kind: 'DEPOSIT',
      amount: req.body.amount,
      movementTypeId: req.body.movementTypeId,
      notes: req.body.notes || '',
      entryDate: req.body.entryDate ? new Date(req.body.entryDate) : new Date(),
      createdBy: req.user._id
    });
    const balances = await getBranchBalances(req.businessId, branchId);
    res.status(201).json({ success: true, entry, balances, message: 'Deposit recorded' });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// POST /api/admin/cash-bank/withdrawal
router.post('/cash-bank/withdrawal', [
  body('accountType').isIn(['CASH', 'BANK']),
  body('amount').isFloat({ min: 0.01 }),
  body('movementTypeId').isMongoId(),
  body('notes').optional().trim(),
  body('entryDate').optional().isISO8601()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const branchId = resolveWriteBranchId(req);
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Select a branch' });
    }
    const entry = await recordDepositOrWithdrawal({
      businessId: req.businessId,
      branchId,
      accountType: req.body.accountType,
      kind: 'WITHDRAWAL',
      amount: req.body.amount,
      movementTypeId: req.body.movementTypeId,
      notes: req.body.notes || '',
      entryDate: req.body.entryDate ? new Date(req.body.entryDate) : new Date(),
      createdBy: req.user._id
    });
    const balances = await getBranchBalances(req.businessId, branchId);
    res.status(201).json({ success: true, entry, balances, message: 'Withdrawal recorded' });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// POST /api/admin/cash-bank/transfer
router.post('/cash-bank/transfer', [
  body('fromAccountType').isIn(['CASH', 'BANK']),
  body('toAccountType').isIn(['CASH', 'BANK']),
  body('amount').isFloat({ min: 0.01 }),
  body('notes').optional().trim(),
  body('entryDate').optional().isISO8601()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const branchId = resolveWriteBranchId(req);
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Select a branch' });
    }
    const result = await recordTransfer({
      businessId: req.businessId,
      branchId,
      fromAccountType: req.body.fromAccountType,
      toAccountType: req.body.toAccountType,
      amount: req.body.amount,
      notes: req.body.notes || '',
      entryDate: req.body.entryDate ? new Date(req.body.entryDate) : new Date(),
      createdBy: req.user._id
    });
    const balances = await getBranchBalances(req.businessId, branchId);
    res.status(201).json({ success: true, ...result, balances, message: 'Transfer recorded' });
  } catch (error) {
    console.error('Transfer error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Day sessions
router.get('/cash-bank/day-sessions', async (req, res) => {
  try {
    const branchId = req.branchId || resolveWriteBranchId(req);
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Select a branch' });
    }
    const sessions = await CashDaySession.find({
      businessId: req.businessId,
      branchId
    })
      .sort({ sessionDateKey: -1 })
      .limit(60)
      .populate('openedBy', 'name')
      .populate('closedBy', 'name')
      .lean();
    res.json({ success: true, sessions });
  } catch (error) {
    console.error('Day sessions list error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/cash-bank/day-sessions/open', [
  body('sessionDateKey').matches(/^\d{4}-\d{2}-\d{2}$/),
  body('countedCash').optional({ nullable: true }).isFloat({ min: 0 }),
  body('notes').optional().trim()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const branchId = resolveWriteBranchId(req);
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Select a branch' });
    }
    const session = await openCashDay({
      businessId: req.businessId,
      branchId,
      sessionDateKey: req.body.sessionDateKey,
      countedCash: req.body.countedCash,
      notes: req.body.notes || '',
      userId: req.user._id
    });
    res.status(201).json({ success: true, session });
  } catch (error) {
    console.error('Open day error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

router.post('/cash-bank/day-sessions/close', [
  body('sessionDateKey').matches(/^\d{4}-\d{2}-\d{2}$/),
  body('countedCash').isFloat({ min: 0 }),
  body('postVarianceAdjustment').optional().isBoolean(),
  body('notes').optional().trim()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only admins can close the day' });
    }
    const branchId = resolveWriteBranchId(req);
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Select a branch' });
    }
    const session = await closeCashDay({
      businessId: req.businessId,
      branchId,
      sessionDateKey: req.body.sessionDateKey,
      countedCash: req.body.countedCash,
      postVarianceAdjustment: !!req.body.postVarianceAdjustment,
      notes: req.body.notes || '',
      userId: req.user._id
    });
    const balances = await getBranchBalances(req.businessId, branchId);
    res.json({ success: true, session, balances });
  } catch (error) {
    console.error('Close day error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// ---- Movement types (dynamic deposit / withdrawal categories) ----

router.get('/cash-movement-types', async (req, res) => {
  try {
    await ensureDefaultMovementTypes(req.businessId);
    const kind = req.query.kind ? String(req.query.kind).toUpperCase() : null;
    const q = { businessId: req.businessId };
    if (kind === 'DEPOSIT' || kind === 'WITHDRAWAL') q.kind = kind;
    if (req.query.active !== '0') q.isActive = true;
    const types = await CashMovementType.find(q).sort({ kind: 1, sortOrder: 1, name: 1 }).lean();
    res.json({ success: true, types });
  } catch (error) {
    console.error('List cash movement types error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/cash-movement-types', [
  body('name').trim().notEmpty().isLength({ max: 80 }),
  body('kind').isIn(['DEPOSIT', 'WITHDRAWAL']),
  body('isOwnerCapital').optional().isBoolean()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only admins can manage types' });
    }
    const type = await CashMovementType.create({
      businessId: req.businessId,
      name: req.body.name.trim(),
      kind: req.body.kind,
      isOwnerCapital: req.body.isOwnerCapital !== false,
      isActive: true
    });
    res.status(201).json({ success: true, type });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ success: false, message: 'A type with this name already exists' });
    }
    console.error('Create cash movement type error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/cash-movement-types/:id', [
  body('name').optional().trim().notEmpty().isLength({ max: 80 }),
  body('isOwnerCapital').optional().isBoolean(),
  body('isActive').optional().isBoolean(),
  body('sortOrder').optional().isInt()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only admins can manage types' });
    }
    const type = await CashMovementType.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!type) return res.status(404).json({ success: false, message: 'Type not found' });
    if (req.body.name != null) type.name = req.body.name.trim();
    if (req.body.isOwnerCapital !== undefined) type.isOwnerCapital = !!req.body.isOwnerCapital;
    if (req.body.isActive !== undefined) type.isActive = !!req.body.isActive;
    if (req.body.sortOrder !== undefined) type.sortOrder = Number(req.body.sortOrder) || 0;
    await type.save();
    res.json({ success: true, type });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ success: false, message: 'A type with this name already exists' });
    }
    console.error('Update cash movement type error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/cash-movement-types/:id', async (req, res) => {
  try {
    if (!isAdminPanelRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only admins can manage types' });
    }
    const type = await CashMovementType.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!type) return res.status(404).json({ success: false, message: 'Type not found' });
    const inUse = await MoneyLedger.countDocuments({
      businessId: req.businessId,
      movementTypeId: type._id
    });
    if (inUse > 0) {
      type.isActive = false;
      await type.save();
      return res.json({ success: true, type, message: 'Type deactivated (already used on entries)' });
    }
    await type.deleteOne();
    res.json({ success: true, message: 'Type deleted' });
  } catch (error) {
    console.error('Delete cash movement type error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
