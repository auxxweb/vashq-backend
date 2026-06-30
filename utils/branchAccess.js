import mongoose from 'mongoose';
import { branchFilter } from '../middleware/branchContext.middleware.js';
import { applyBranchScope, applyBranchScopeOid } from './branchQuery.js';

/** Merge business + optional branch filter from request context. */
export function scopedFilter(req, extra = {}) {
  return { ...branchFilter(req), ...extra };
}

/** Job lookup with branch scope + optional employee assignment filter. */
export function jobAccessFilter(req, extra = {}) {
  const filter = { ...scopedFilter(req, extra) };
  if (req.user?.role === 'EMPLOYEE') {
    filter.assignedTo = req.user._id;
  }
  return filter;
}

export { applyBranchScope, applyBranchScopeOid };

/**
 * Reject cross-branch access when scoped to a single branch.
 * Legacy docs without branchId are treated as accessible only in "all" scope.
 */
export function assertBranchAccess(req, doc, { allowLegacyNull = false } = {}) {
  if (!doc || req.branchScope === 'all' || !req.branchId) return;
  const docBranch = doc.branchId;
  if (!docBranch) {
    if (allowLegacyNull) return;
    const err = new Error('Record not found');
    err.status = 404;
    throw err;
  }
  if (String(docBranch) !== String(req.branchId)) {
    const err = new Error('Record not found');
    err.status = 404;
    throw err;
  }
}

/** Find one document with branch scope enforced on the query (returns a Mongoose Query for chaining). */
export function scopedFindOne(model, req, filter = {}) {
  return model.findOne(scopedFilter(req, filter));
}

/** Find one document with branch scope enforced on the query. */
export async function findScoped(model, req, filter = {}) {
  return scopedFindOne(model, req, filter);
}

/** Customer IDs belonging to the active branch (for indirect filters). */
export async function scopedCustomerIds(req, Customer) {
  if (req.branchScope === 'all' || !req.branchId) return null;
  return Customer.find(scopedFilter(req)).distinct('_id');
}

/** Append branchId filter for aggregations on branch-scoped collections. */
export function branchScopedMatch(req, base = {}) {
  return applyBranchScopeOid({ ...base }, req);
}

export function requireBranchIdForWrite(req) {
  if (!req.branchId) {
    const err = new Error('Select a branch before creating or updating records');
    err.status = 400;
    throw err;
  }
  return req.branchId;
}

export function branchIdForCreate(req) {
  return requireBranchIdForWrite(req);
}
