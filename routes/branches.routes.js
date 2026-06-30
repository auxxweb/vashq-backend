import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.middleware.js';
import Branch from '../models/Branch.model.js';
import BranchCreationRequest from '../models/BranchCreationRequest.model.js';
import BranchSubscription from '../models/BranchSubscription.model.js';
import User from '../models/User.model.js';
import Business from '../models/Business.model.js';
import {
  assertCanSubmitBranchRequest,
  getBranchUsageStats,
  ensureDefaultBranchForBusiness,
  isBranchOperational,
  suggestBranchCode,
  normalizeBranchCode,
  getBranchSettingsForOwner,
  updateBranchSettings,
  submitBranchRenewalRequest,
  getEffectiveMaxConcurrentJobs,
  applyMaxConcurrentJobsForBusiness
} from '../services/branchService.js';
import { getBranchPlatformConfig } from '../utils/branchConfig.js';
import { createEmployeeAccount, randomEmployeePassword } from '../utils/employeeAccount.js';
import { ROLES, isBusinessOwner, isBranchAdmin, isAdminPanelRole } from '../utils/adminRoles.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';
import { moduleDisabledResponse } from '../middleware/businessModules.middleware.js';

const router = express.Router();

async function loadBranchForBusiness(businessId, branchId) {
  const branch = await Branch.findOne({
    _id: branchId,
    businessId,
    status: { $in: ['ACTIVE', 'EXPIRED', 'INACTIVE'] }
  });
  if (!branch) {
    const err = new Error('Branch not found');
    err.status = 404;
    throw err;
  }
  return branch;
}

router.use(authenticate);

router.use((req, res, next) => {
  if (!req.user.businessId) {
    return res.status(403).json({ success: false, message: 'Business not assigned' });
  }
  req.businessId = req.user.businessId;
  next();
});

/** Branch managers may only access their assigned branch; owners may access any branch. */
function assertBranchSettingsAccess(req, res, next) {
  if (isBusinessOwner(req.user.role)) return next();
  if (isBranchAdmin(req.user.role)) {
    const assigned = String(req.user.branchId || '');
    const target = String(req.params.id || '');
    if (assigned && target && assigned === target) return next();
  }
  return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
}

router.use(async (req, res, next) => {
  const settingsPath = req.path.endsWith('/settings');
  if (settingsPath && isAdminPanelRole(req.user.role)) {
    return assertBranchSettingsAccess(req, res, next);
  }
  if (!isBusinessOwner(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
  }
  try {
    const modules = await getBusinessModules(req.businessId);
    if (!isModuleEnabled(modules, 'branches')) {
      return moduleDisabledResponse(res, 'branches');
    }
    next();
  } catch (err) {
    next(err);
  }
});

router.use(enforceActiveSubscription());

// GET /api/admin/branches/config
router.get('/config', async (req, res) => {
  try {
    const stats = await getBranchUsageStats(req.businessId);
    res.json({ success: true, config: stats });
  } catch (error) {
    console.error('Branch config error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/branches
router.get('/', async (req, res) => {
  try {
    await ensureDefaultBranchForBusiness(req.businessId);
    const branches = await Branch.find({ businessId: req.businessId })
      .sort({ isDefault: -1, name: 1 })
      .lean();

    const branchIds = branches.map((b) => b._id);
    const subs = await BranchSubscription.find({ branchId: { $in: branchIds } }).lean();
    const subByBranch = new Map(subs.map((s) => [String(s.branchId), s]));

    const enriched = await Promise.all(branches.map(async (b) => ({
      ...b,
      subscription: b.isDefault ? null : (subByBranch.get(String(b._id)) || null),
      operational: await isBranchOperational(b)
    })));

    res.json({ success: true, branches: enriched });
  } catch (error) {
    console.error('List branches error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/branches/requests
router.get('/requests/list', async (req, res) => {
  try {
    const requests = await BranchCreationRequest.find({ businessId: req.businessId })
      .sort({ createdAt: -1 })
      .populate('approvedBranchId', 'name code status')
      .lean();
    res.json({ success: true, requests });
  } catch (error) {
    console.error('List branch requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/branches/requests
router.post('/requests', [
  body('name').trim().notEmpty().withMessage('Branch name is required'),
  body('code').optional().trim(),
  body('address').optional().trim(),
  body('phone').optional().trim(),
  body('email').optional({ checkFalsy: true }).trim().isEmail().withMessage('Invalid email'),
  body('location').optional().trim(),
  body('workingHoursStart').optional().trim(),
  body('workingHoursEnd').optional().trim(),
  body('maxConcurrentJobs').optional().isInt({ min: 1 }),
  body('message').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    await ensureDefaultBranchForBusiness(req.businessId);
    const stats = await assertCanSubmitBranchRequest(req.businessId);

    const code = normalizeBranchCode(
      req.body.code?.trim() || suggestBranchCode(req.body.name)
    );

    const duplicateCode = await Branch.findOne({ businessId: req.businessId, code });
    if (duplicateCode) {
      return res.status(400).json({ success: false, message: `Branch code "${code}" is already in use` });
    }

    const pendingSameCode = await BranchCreationRequest.findOne({
      businessId: req.businessId,
      code,
      status: 'PENDING'
    });
    if (pendingSameCode) {
      return res.status(400).json({ success: false, message: 'A pending request already uses this branch code' });
    }

    const request = await BranchCreationRequest.create({
      businessId: req.businessId,
      requestedBy: req.user._id,
      name: req.body.name.trim(),
      code,
      address: req.body.address?.trim() || '',
      phone: req.body.phone?.trim() || '',
      email: req.body.email?.trim() || '',
      location: req.body.location?.trim() || '',
      workingHoursStart: req.body.workingHoursStart?.trim() || '09:00',
      workingHoursEnd: req.body.workingHoursEnd?.trim() || '18:00',
      maxConcurrentJobs: Number(req.body.maxConcurrentJobs) || 1,
      message: req.body.message?.trim() || undefined,
      status: 'PENDING'
    });

    const config = await getBranchPlatformConfig();
    const isAddon = stats.activeCount >= config.includedBranchesPerShop;

    res.status(201).json({
      success: true,
      request,
      isAddon,
      expectedFee: isAddon ? config.branchAnnualFee : 0,
      message: isAddon
        ? `Branch request submitted. ₹${config.branchAnnualFee}/year applies after Super Admin verifies payment.`
        : 'Branch request submitted for platform approval.'
    });
  } catch (error) {
    console.error('Create branch request error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// GET /api/admin/branches/:id — branch profile, settings, and logins
router.get('/:id', async (req, res) => {
  try {
    const { branch, settings } = await getBranchSettingsForOwner(req.businessId, req.params.id);
    const subscription = branch.isDefault
      ? null
      : await BranchSubscription.findOne({ branchId: branch._id }).lean();
    const operational = await isBranchOperational(branch);
    const logins = await User.find({
      businessId: req.businessId,
      branchId: branch._id,
      role: { $in: [ROLES.BRANCH_ADMIN, ROLES.EMPLOYEE] }
    })
      .select('name email phone employeeCode status createdAt')
      .sort({ createdAt: -1 })
      .lean();
    const business = await Business.findById(req.businessId)
      .select('maxConcurrentJobs carHandlingCapacity')
      .lean();
    const maxConcurrentJobs = getEffectiveMaxConcurrentJobs(business);
    res.json({
      success: true,
      branch: { ...branch, subscription, operational, maxConcurrentJobs },
      settings,
      logins,
      business: {
        maxConcurrentJobs,
        carHandlingCapacity: business?.carHandlingCapacity || 'SINGLE'
      }
    });
  } catch (error) {
    console.error('Get branch detail error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// PUT /api/admin/branches/:id — update branch profile fields
router.put('/:id', [
  body('name').optional().trim().notEmpty().withMessage('Branch name cannot be empty'),
  body('address').optional().trim(),
  body('phone').optional().trim(),
  body('email').optional({ checkFalsy: true }).trim().isEmail().withMessage('Invalid email'),
  body('location').optional().trim(),
  body('workingHoursStart').optional().trim(),
  body('workingHoursEnd').optional().trim(),
  body('maxConcurrentJobs').optional().isInt({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const branch = await loadBranchForBusiness(req.businessId, req.params.id);
    if (req.body.name != null) branch.name = req.body.name.trim();
    if (req.body.address != null) branch.address = req.body.address.trim();
    if (req.body.phone != null) branch.phone = req.body.phone.trim();
    if (req.body.email != null) branch.email = req.body.email.trim();
    if (req.body.location != null) branch.location = req.body.location.trim();
    if (req.body.workingHoursStart != null) branch.workingHoursStart = req.body.workingHoursStart.trim();
    if (req.body.workingHoursEnd != null) branch.workingHoursEnd = req.body.workingHoursEnd.trim();
    if (req.body.maxConcurrentJobs != null) {
      await applyMaxConcurrentJobsForBusiness(req.businessId, req.body.maxConcurrentJobs);
      branch.maxConcurrentJobs = getEffectiveMaxConcurrentJobs(
        await Business.findById(req.businessId).select('maxConcurrentJobs carHandlingCapacity').lean()
      );
    }
    await branch.save();
    const operational = await isBranchOperational(branch);
    const business = await Business.findById(req.businessId)
      .select('maxConcurrentJobs carHandlingCapacity')
      .lean();
    res.json({
      success: true,
      branch: {
        ...(branch.toObject ? branch.toObject() : branch),
        operational,
        maxConcurrentJobs: getEffectiveMaxConcurrentJobs(business)
      },
      business: {
        maxConcurrentJobs: getEffectiveMaxConcurrentJobs(business),
        carHandlingCapacity: business?.carHandlingCapacity || 'SINGLE'
      }
    });
  } catch (error) {
    console.error('Update branch error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// GET /api/admin/branches/:id/logins — portal staff for this branch
router.get('/:id/logins', async (req, res) => {
  try {
    await loadBranchForBusiness(req.businessId, req.params.id);
    const logins = await User.find({
      businessId: req.businessId,
      role: { $in: [ROLES.BRANCH_ADMIN, ROLES.EMPLOYEE] },
      branchId: req.params.id
    })
      .select('name email phone employeeCode status createdAt')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, logins });
  } catch (error) {
    console.error('List branch logins error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// POST /api/admin/branches/:id/logins — create branch portal login
router.post('/:id/logins', [
  body('name').notEmpty().trim().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('phone').optional().trim()
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
    await loadBranchForBusiness(req.businessId, req.params.id);
    const { user, temporaryPassword } = await createEmployeeAccount(req.businessId, {
      name: req.body.name.trim(),
      email: req.body.email.trim(),
      password: req.body.password,
      phone: req.body.phone?.trim(),
      branchId: req.params.id,
      role: ROLES.BRANCH_ADMIN
    });
    res.status(201).json({
      success: true,
      login: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        employeeCode: user.employeeCode,
        status: user.status,
        branchId: user.branchId
      },
      temporaryPassword,
      message: 'Share the portal link and login credentials with this staff member.'
    });
  } catch (error) {
    console.error('Create branch login error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// PUT /api/admin/branches/:id/logins/:userId — update branch manager login
router.put('/:id/logins/:userId', [
  body('name').optional().trim().notEmpty(),
  body('email').optional().isEmail().normalizeEmail(),
  body('password').optional().isLength({ min: 6 }),
  body('phone').optional().trim(),
  body('status').optional().isIn(['ACTIVE', 'SUSPENDED', 'INACTIVE'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    await loadBranchForBusiness(req.businessId, req.params.id);
    const user = await User.findOne({
      _id: req.params.userId,
      businessId: req.businessId,
      role: { $in: [ROLES.BRANCH_ADMIN, ROLES.EMPLOYEE] },
      branchId: req.params.id
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Branch login not found' });
    }
    if (req.body.name != null) user.name = req.body.name.trim();
    if (req.body.phone != null) user.phone = req.body.phone.trim();
    if (req.body.status != null) user.status = req.body.status;
    if (req.body.email != null) {
      const existing = await User.findOne({ email: req.body.email, _id: { $ne: user._id } });
      if (existing) {
        return res.status(400).json({ success: false, message: 'Email already in use' });
      }
      user.email = req.body.email.trim();
    }
    let temporaryPassword = null;
    if (req.body.password) {
      temporaryPassword = req.body.password;
      user.password = req.body.password;
    }
    await user.save();
    const out = {
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      employeeCode: user.employeeCode,
      status: user.status,
      branchId: user.branchId
    };
    res.json({
      success: true,
      login: out,
      ...(temporaryPassword ? { temporaryPassword } : {})
    });
  } catch (error) {
    console.error('Update branch login error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// POST /api/admin/branches/:id/logins/:userId/reset-password
router.post('/:id/logins/:userId/reset-password', async (req, res) => {
  try {
    await loadBranchForBusiness(req.businessId, req.params.id);
    const user = await User.findOne({
      _id: req.params.userId,
      businessId: req.businessId,
      role: { $in: [ROLES.BRANCH_ADMIN, ROLES.EMPLOYEE] },
      branchId: req.params.id
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Branch login not found' });
    }
    const newPassword = randomEmployeePassword(10);
    user.password = newPassword;
    await user.save();
    res.json({
      success: true,
      temporaryPassword: newPassword,
      message: 'Copy the new password and share it with the staff member.'
    });
  } catch (error) {
    console.error('Reset branch login password error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// GET /api/admin/branches/:id/settings
router.get('/:id/settings', async (req, res) => {
  try {
    const { branch, settings } = await getBranchSettingsForOwner(req.businessId, req.params.id);
    res.json({ success: true, branch, settings });
  } catch (error) {
    console.error('Get branch settings error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// PUT /api/admin/branches/:id/settings
router.put('/:id/settings', async (req, res) => {
  try {
    const settings = await updateBranchSettings(req.businessId, req.params.id, req.body);
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Update branch settings error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

// POST /api/admin/branches/:id/renewal-request
router.post('/:id/renewal-request', [
  body('message').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const config = await getBranchPlatformConfig();
    const request = await submitBranchRenewalRequest(
      req.businessId,
      req.user._id,
      req.params.id,
      req.body.message
    );
    res.status(201).json({
      success: true,
      request,
      expectedFee: config.branchAnnualFee,
      message: `Renewal request submitted. ₹${config.branchAnnualFee}/year applies after Super Admin verifies payment.`
    });
  } catch (error) {
    console.error('Branch renewal request error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Server error' });
  }
});

export default router;
