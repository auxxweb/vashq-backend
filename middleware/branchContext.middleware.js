import Branch from '../models/Branch.model.js';
import {
  ensureDefaultBranchForBusiness,
  isBranchOperational
} from '../services/branchService.js';
import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';
import { isBranchAdmin, isBusinessOwner } from '../utils/adminRoles.js';

/** Paths that skip branch context (branch management itself). */
const BRANCH_EXEMPT_PREFIXES = [
  '/branches',
  '/branch-requests',
  '/my-subscription',
  '/available-plans',
  '/upgrade-request',
  '/upgrade-requests'
];

function isBranchExempt(path) {
  return BRANCH_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Resolves active branch for operational routes.
 * - Owner: X-Branch-Id header or default branch
 * - Employee: user.branchId or default branch (future: assign employees to branches)
 * Sets req.branchId, req.branch, req.branchScope ('branch' | 'all')
 */
export async function resolveBranchContext(req, res, next) {
  try {
    if (!req.businessId || isBranchExempt(req.path)) {
      return next();
    }

    const modules = await getBusinessModules(req.businessId);
    const branchesModuleOn = isModuleEnabled(modules, 'branches');
    const defaultBranch = await ensureDefaultBranchForBusiness(req.businessId);

    if (!branchesModuleOn) {
      if (isBranchAdmin(req.user.role)) {
        return res.status(403).json({
          success: false,
          code: 'MODULE_DISABLED',
          message: 'Multi-branch is disabled for this business. Branch access is unavailable.'
        });
      }
      if (isBusinessOwner(req.user.role)) {
        req.branchScope = 'all';
        req.branchId = null;
        req.branch = null;
        return next();
      }
      const branchId = req.user.branchId || defaultBranch._id;
      const branch = await Branch.findOne({
        _id: branchId,
        businessId: req.businessId
      }).lean() || defaultBranch;
      req.branchScope = 'branch';
      req.branchId = branch?._id || defaultBranch._id;
      req.branch = branch || defaultBranch;
      return next();
    }

    // Branch managers are always locked to their assigned branch.
    if (isBranchAdmin(req.user.role)) {
      const branchId = req.user.branchId || defaultBranch._id;
      const branch = await Branch.findOne({
        _id: branchId,
        businessId: req.businessId
      }).lean();
      if (!branch) {
        return res.status(400).json({ success: false, message: 'Branch assignment not found' });
      }
      const operational = await isBranchOperational(branch);
      if (!operational) {
        return res.status(403).json({
          success: false,
          code: 'BRANCH_INACTIVE',
          message: 'This branch is inactive or its annual subscription has expired. Contact your business owner.'
        });
      }
      req.branchScope = 'branch';
      req.branchId = branch._id;
      req.branch = branch;
      return next();
    }

    const scopeHeader = String(req.headers['x-branch-scope'] || 'branch').toLowerCase();
    req.branchScope = scopeHeader === 'all' && isBusinessOwner(req.user.role) ? 'all' : 'branch';

    if (req.branchScope === 'all') {
      req.branchId = null;
      req.branch = null;
      const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (isWrite && !req.headers['x-branch-id']) {
        return res.status(400).json({
          success: false,
          message: 'Select a branch before creating or updating records'
        });
      }
      if (req.headers['x-branch-id']) {
        const branch = await Branch.findOne({
          _id: req.headers['x-branch-id'],
          businessId: req.businessId
        }).lean();
        if (!branch) {
          return res.status(400).json({ success: false, message: 'Invalid branch selected' });
        }
        const operational = await isBranchOperational(branch);
        if (!operational) {
          return res.status(403).json({
            success: false,
            code: 'BRANCH_INACTIVE',
            message: 'This branch is inactive or its subscription has expired'
          });
        }
        req.branchId = branch._id;
        req.branch = branch;
      }
      return next();
    }

    let branchId = req.headers['x-branch-id'] || req.query.branchId || req.user.branchId || defaultBranch._id;

    const branch = await Branch.findOne({
      _id: branchId,
      businessId: req.businessId
    }).lean();

    if (!branch) {
      return res.status(400).json({ success: false, message: 'Invalid branch selected' });
    }

    const operational = await isBranchOperational(branch);
    if (!operational) {
      return res.status(403).json({
        success: false,
        code: 'BRANCH_INACTIVE',
        message: branch.isDefault
          ? 'Branch is not active'
          : 'This branch is inactive or its annual subscription has expired. Renew from Branches.'
      });
    }

    req.branchId = branch._id;
    req.branch = branch;
    next();
  } catch (err) {
    console.error('Branch context error:', err);
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Failed to resolve branch context'
    });
  }
}

/** Mongo filter for branch-scoped queries. */
export function branchFilter(req) {
  const base = { businessId: req.businessId };
  if (req.branchScope === 'all' || !req.branchId) return base;
  return { ...base, branchId: req.branchId };
}
