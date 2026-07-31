import mongoose from 'mongoose';
import User from '../models/User.model.js';

/** Normalize any id-like value to a string, or null. */
export function toIdString(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && value._id != null) return String(value._id);
  return String(value);
}

/** True if employee userId is assigned on this job (legacy assignedTo or assignedToUsers). */
export function isEmployeeAssignedToJob(job, userId) {
  const uid = toIdString(userId);
  if (!job || !uid) return false;
  if (toIdString(job.assignedTo) === uid) return true;
  const list = Array.isArray(job.assignedToUsers) ? job.assignedToUsers : [];
  return list.some((id) => toIdString(id) === uid);
}

/** Mongo filter clause so an employee sees all jobs they are assigned to. */
export function employeeAssignedMatch(userId) {
  const uid = userId;
  return {
    $or: [
      { assignedTo: uid },
      { assignedToUsers: uid }
    ]
  };
}

/** Merge employee assignee scope into an existing Mongo match (mutates and returns match). */
export function applyEmployeeJobScope(match, userId) {
  if (!match || !userId) return match;
  const emp = employeeAssignedMatch(userId);
  if (match.$or) {
    match.$and = [...(match.$and || []), { $or: match.$or }, emp];
    delete match.$or;
  } else {
    Object.assign(match, emp);
  }
  return match;
}

/**
 * Resolve assignee list from request body.
 * Accepts assignedTo (single) and/or assignedToUsers (array).
 * Keeps assignedTo = first assignee for legacy reports / notifications.
 *
 * @returns {{ assignedTo: ObjectId|null, assignedToUsers: ObjectId[] }}
 */
export async function resolveJobAssignees({
  businessId,
  assignedToBody,
  assignedToUsersBody,
  multiEnabled,
  actorUser
}) {
  const raw = [];
  if (Array.isArray(assignedToUsersBody)) {
    for (const v of assignedToUsersBody) {
      const id = toIdString(v);
      if (id) raw.push(id);
    }
  }
  const single = toIdString(assignedToBody);
  if (single) raw.push(single);

  let unique = [...new Set(raw)].filter((id) => mongoose.Types.ObjectId.isValid(id));

  if (unique.length === 0 && actorUser?.role === 'EMPLOYEE') {
    unique = [String(actorUser._id)];
  }

  if (!multiEnabled && unique.length > 1) {
    const err = new Error('Multiple employee assignment is disabled. Enable it under Settings, or assign only one employee.');
    err.status = 400;
    throw err;
  }

  if (unique.length === 0) {
    return { assignedTo: null, assignedToUsers: [] };
  }

  const employees = await User.find({
    _id: { $in: unique },
    businessId,
    role: 'EMPLOYEE',
    status: 'ACTIVE'
  }).select('_id').lean();

  const validSet = new Set(employees.map((e) => String(e._id)));
  const ordered = unique.filter((id) => validSet.has(id));

  if (ordered.length === 0) {
    return { assignedTo: null, assignedToUsers: [] };
  }

  return {
    assignedTo: new mongoose.Types.ObjectId(ordered[0]),
    assignedToUsers: ordered.map((id) => new mongoose.Types.ObjectId(id))
  };
}
