import mongoose from 'mongoose';
import User from '../models/User.model.js';
import { isAdminPanelRole } from './adminRoles.js';
import { isSalesEmployee, EMPLOYEE_TYPE_SALES } from './employeeType.js';

export function canManageCrmPipeline(user) {
  return isAdminPanelRole(user?.role);
}

export function canBulkManageLeads(user) {
  return isAdminPanelRole(user?.role);
}

export function canImportLeads(user) {
  return isAdminPanelRole(user?.role);
}

/** Sales employees only see leads assigned to them. */
export function applySalesLeadScope(filter, user) {
  if (isSalesEmployee(user)) {
    filter.assignedTo = user._id;
  }
  return filter;
}

export function assertSalesCanAccessLead(user, lead) {
  if (!isSalesEmployee(user)) return;
  const assigned = lead?.assignedTo?._id || lead?.assignedTo;
  if (!assigned || String(assigned) !== String(user._id)) {
    const err = new Error('Lead not found or not assigned to you');
    err.status = 404;
    throw err;
  }
}

/**
 * Resolve a sales staff user for lead assignment within the business (and branch when scoped).
 */
export async function resolveSalesAssignee(businessId, assigneeId, { branchId = null } = {}) {
  if (!assigneeId) return null;
  if (!mongoose.isValidObjectId(assigneeId)) {
    const err = new Error('Invalid sales employee');
    err.status = 400;
    throw err;
  }
  const filter = {
    _id: assigneeId,
    businessId,
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    employeeType: EMPLOYEE_TYPE_SALES
  };
  if (branchId) filter.branchId = branchId;
  const user = await User.findOne(filter).select('_id name employeeCode employeeType branchId').lean();
  if (!user) {
    const err = new Error('Select an active sales employee');
    err.status = 400;
    throw err;
  }
  return user;
}

export async function listSalesStaff(businessId, { branchId = null } = {}) {
  const filter = {
    businessId,
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    employeeType: EMPLOYEE_TYPE_SALES
  };
  if (branchId) filter.branchId = branchId;
  return User.find(filter)
    .select('name email employeeCode branchId employeeType')
    .populate('branchId', 'name code')
    .sort({ name: 1, employeeCode: 1 })
    .lean();
}
