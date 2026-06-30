import Business from '../models/Business.model.js';
import {
  BUSINESS_MODULE_KEYS,
  DEFAULT_ENABLED_MODULES,
  normalizeEnabledModules
} from '../constants/businessModules.js';
import { cacheGetOrSet, cacheDelete } from '../utils/cache.js';
import {
  restoreBranchesForModule,
  suspendBranchesForModule
} from './branchModuleLifecycle.js';

const MODULES_CACHE_TTL = 60_000;

export async function getBusinessModules(businessId) {
  if (!businessId) return { ...DEFAULT_ENABLED_MODULES };
  return cacheGetOrSet(`modules:${businessId}`, MODULES_CACHE_TTL, async () => {
    const business = await Business.findById(businessId).select('enabledModules').lean();
    return normalizeEnabledModules(business?.enabledModules);
  });
}

export function invalidateBusinessModulesCache(businessId) {
  if (businessId) cacheDelete(`modules:${businessId}`);
}

export async function updateBusinessModules(businessId, patch) {
  const business = await Business.findById(businessId);
  if (!business) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  const current = normalizeEnabledModules(business.enabledModules);
  const next = { ...current };
  for (const key of BUSINESS_MODULE_KEYS) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  const branchesWasOn = isModuleEnabled(current, 'branches');
  const branchesNowOn = isModuleEnabled(next, 'branches');

  business.enabledModules = next;
  await business.save();
  invalidateBusinessModulesCache(businessId);

  if (branchesWasOn && !branchesNowOn) {
    await suspendBranchesForModule(businessId);
  } else if (!branchesWasOn && branchesNowOn) {
    await restoreBranchesForModule(businessId);
  }

  return next;
}

export function isModuleEnabled(modules, key) {
  return modules?.[key] !== false;
}
