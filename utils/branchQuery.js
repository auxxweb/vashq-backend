import mongoose from 'mongoose';

/** Apply branch scope to a plain Mongo filter (ObjectId fields). */
export function applyBranchScopeOid(filter, req) {
  if (!req || req.branchScope === 'all' || !req.branchId) return filter;
  return {
    ...filter,
    branchId: new mongoose.Types.ObjectId(String(req.branchId))
  };
}

/** Apply branch scope to a plain Mongo filter (string/ObjectId branchId). */
export function applyBranchScope(filter, req) {
  if (!req || req.branchScope === 'all' || !req.branchId) return filter;
  return { ...filter, branchId: req.branchId };
}

/** Optional branchId on a filter (for dashboard helpers). */
export function withBranchOid(filter, branchId) {
  if (!branchId) return filter;
  return {
    ...filter,
    branchId: new mongoose.Types.ObjectId(String(branchId))
  };
}
