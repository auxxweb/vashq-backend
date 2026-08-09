import { DateTime } from 'luxon';
import AttendanceDay from '../models/AttendanceDay.model.js';
import AttendanceCorrectionRequest from '../models/AttendanceCorrectionRequest.model.js';
import User from '../models/User.model.js';
import { getBusinessTimezone } from '../utils/businessTimezone.js';
import { isAdminPanelRole } from '../utils/adminRoles.js';

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export async function businessTodayKey(businessId) {
  const tz = await getBusinessTimezone(businessId);
  return DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
}

export async function listBranchEmployees(req) {
  const filter = {
    businessId: req.businessId,
    role: 'EMPLOYEE',
    status: { $ne: 'INACTIVE' }
  };
  if (req.branchScope !== 'all' && req.branchId) {
    filter.branchId = req.branchId;
  }
  return User.find(filter)
    .select('name email employeeCode branchId status employeeType')
    .sort({ employeeCode: 1, name: 1 })
    .lean();
}

function deriveLiveState(day) {
  if (!day?.sessions?.length) {
    return { state: 'NOT_STARTED', openSession: null, openBreak: null };
  }
  const openSession = [...day.sessions].reverse().find((s) => s.punchInAt && !s.punchOutAt) || null;
  if (!openSession) {
    return { state: 'PUNCHED_OUT', openSession: null, openBreak: null };
  }
  const openBreak = (day.breaks || []).find((b) => b.startAt && !b.endAt) || null;
  if (openBreak) {
    return { state: 'ON_BREAK', openSession, openBreak };
  }
  return { state: 'PUNCHED_IN', openSession, openBreak: null };
}

async function getOrCreateToday(req, userId) {
  const date = await businessTodayKey(req.businessId);
  let day = await AttendanceDay.findOne({
    businessId: req.businessId,
    userId,
    date
  });
  if (!day) {
    day = await AttendanceDay.create({
      businessId: req.businessId,
      branchId: req.branchId || req.user.branchId || null,
      userId,
      date,
      status: 'PRESENT',
      sessions: [],
      breaks: [],
      source: 'PUNCH'
    });
  }
  return day;
}

export async function getTodayAttendance(req, userId) {
  const date = await businessTodayKey(req.businessId);
  const day = await AttendanceDay.findOne({
    businessId: req.businessId,
    userId,
    date
  }).lean();
  const live = deriveLiveState(day);
  return {
    date,
    day: day || null,
    ...live
  };
}

export async function punchIn(req, userId) {
  const day = await getOrCreateToday(req, userId);
  const live = deriveLiveState(day);
  if (live.state === 'PUNCHED_IN' || live.state === 'ON_BREAK') {
    throw httpError('Already punched in. Punch out or end your break first.');
  }
  const now = new Date();
  day.sessions.push({ punchInAt: now, punchOutAt: null });
  day.status = 'PRESENT';
  day.source = 'PUNCH';
  if (!day.branchId) day.branchId = req.branchId || req.user.branchId || null;
  await day.save();
  return getTodayAttendance(req, userId);
}

export async function punchOut(req, userId) {
  const day = await getOrCreateToday(req, userId);
  const live = deriveLiveState(day);
  if (live.state === 'ON_BREAK') {
    throw httpError('End your break before punching out.');
  }
  if (live.state !== 'PUNCHED_IN') {
    throw httpError('You are not punched in.');
  }
  const open = day.sessions.find((s) => s.punchInAt && !s.punchOutAt);
  open.punchOutAt = new Date();
  await day.save();
  return getTodayAttendance(req, userId);
}

export async function breakStart(req, userId) {
  const day = await getOrCreateToday(req, userId);
  const live = deriveLiveState(day);
  if (live.state !== 'PUNCHED_IN') {
    throw httpError('Punch in before taking a break.');
  }
  day.breaks.push({ startAt: new Date(), endAt: null });
  await day.save();
  return getTodayAttendance(req, userId);
}

export async function breakEnd(req, userId) {
  const day = await getOrCreateToday(req, userId);
  const live = deriveLiveState(day);
  if (live.state !== 'ON_BREAK') {
    throw httpError('You are not on a break.');
  }
  const open = day.breaks.find((b) => b.startAt && !b.endAt);
  open.endAt = new Date();
  await day.save();
  return getTodayAttendance(req, userId);
}

function eachDateInclusive(fromKey, toKey) {
  const dates = [];
  let cursor = DateTime.fromISO(fromKey, { zone: 'utc' }).startOf('day');
  const end = DateTime.fromISO(toKey, { zone: 'utc' }).startOf('day');
  if (!cursor.isValid || !end.isValid || cursor > end) return dates;
  while (cursor <= end) {
    dates.push(cursor.toFormat('yyyy-MM-dd'));
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

function dayDisplayStatus(dayDoc, dateKey, todayKey) {
  if (dayDoc) {
    if (dayDoc.status === 'CORRECTED' || dayDoc.status === 'PRESENT') return 'PRESENT';
    if ((dayDoc.sessions || []).length > 0) return 'PRESENT';
    if (dayDoc.status === 'LEAVE') return 'LEAVE';
  }
  if (dateKey > todayKey) return 'FUTURE';
  if (dateKey === todayKey) return dayDoc?.sessions?.length ? 'PRESENT' : 'OPEN';
  return 'LEAVE';
}

export async function getCalendar(req, { from, to, userId: filterUserId } = {}) {
  if (!from || !to) throw httpError('from and to dates are required (YYYY-MM-DD)');
  const fromKey = String(from).slice(0, 10);
  const toKey = String(to).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey)) {
    throw httpError('Invalid date format. Use YYYY-MM-DD');
  }
  if (fromKey > toKey) throw httpError('from must be on or before to');

  const todayKey = await businessTodayKey(req.businessId);
  const isAdmin = isAdminPanelRole(req.user.role);
  let employees;
  if (isAdmin) {
    employees = await listBranchEmployees(req);
    if (filterUserId) {
      employees = employees.filter((e) => String(e._id) === String(filterUserId));
    }
  } else {
    employees = [{
      _id: req.user._id,
      name: req.user.name,
      employeeCode: req.user.employeeCode,
      branchId: req.user.branchId
    }];
  }

  const userIds = employees.map((e) => e._id);
  const dayFilter = {
    businessId: req.businessId,
    userId: { $in: userIds },
    date: { $gte: fromKey, $lte: toKey }
  };
  if (req.branchScope !== 'all' && req.branchId) {
    dayFilter.$or = [
      { branchId: req.branchId },
      { branchId: null },
      { branchId: { $exists: false } }
    ];
  }

  const days = await AttendanceDay.find(dayFilter).lean();
  const byUserDate = new Map();
  for (const d of days) {
    byUserDate.set(`${String(d.userId)}:${d.date}`, d);
  }

  const dateKeys = eachDateInclusive(fromKey, toKey);
  const people = employees.map((emp) => {
    const id = String(emp._id);
    const calendar = dateKeys.map((date) => {
      const doc = byUserDate.get(`${id}:${date}`) || null;
      const status = dayDisplayStatus(doc, date, todayKey);
      return {
        date,
        status,
        sessions: doc?.sessions || [],
        breaks: doc?.breaks || [],
        source: doc?.source || null
      };
    });
    const workingDays = calendar.filter((d) => d.status === 'PRESENT').length;
    const leaveDays = calendar.filter((d) => d.status === 'LEAVE').length;
    return {
      user: {
        _id: emp._id,
        name: emp.name,
        employeeCode: emp.employeeCode,
        branchId: emp.branchId
      },
      workingDays,
      leaveDays,
      calendar
    };
  });

  return {
    from: fromKey,
    to: toKey,
    today: todayKey,
    people,
    totals: {
      employees: people.length,
      workingDays: people.reduce((s, p) => s + p.workingDays, 0),
      leaveDays: people.reduce((s, p) => s + p.leaveDays, 0)
    }
  };
}

export async function createCorrectionRequest(req, {
  date,
  reason,
  proposedPunchInAt,
  proposedPunchOutAt
}) {
  const dateKey = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw httpError('Valid date (YYYY-MM-DD) is required');
  }
  const note = String(reason || '').trim();
  if (!note) throw httpError('Reason is required');

  const todayKey = await businessTodayKey(req.businessId);
  if (dateKey > todayKey) throw httpError('Cannot request review for a future date');
  if (dateKey === todayKey) throw httpError('Use punch controls for today. Correction is for past leave days.');

  const existingDay = await AttendanceDay.findOne({
    businessId: req.businessId,
    userId: req.user._id,
    date: dateKey
  }).lean();
  const status = dayDisplayStatus(existingDay, dateKey, todayKey);
  if (status === 'PRESENT') {
    throw httpError('This day is already marked present');
  }

  try {
    const doc = await AttendanceCorrectionRequest.create({
      businessId: req.businessId,
      branchId: req.branchId || req.user.branchId || null,
      userId: req.user._id,
      date: dateKey,
      reason: note,
      proposedPunchInAt: proposedPunchInAt ? new Date(proposedPunchInAt) : null,
      proposedPunchOutAt: proposedPunchOutAt ? new Date(proposedPunchOutAt) : null,
      status: 'PENDING'
    });
    return doc;
  } catch (e) {
    if (e?.code === 11000) {
      throw httpError('A pending review request already exists for this day');
    }
    throw e;
  }
}

export async function listCorrectionRequests(req, { status } = {}) {
  const filter = { businessId: req.businessId };
  if (status && ['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    filter.status = status;
  }
  if (isAdminPanelRole(req.user.role)) {
    if (req.branchScope !== 'all' && req.branchId) {
      filter.$or = [
        { branchId: req.branchId },
        { branchId: null },
        { branchId: { $exists: false } }
      ];
    }
  } else {
    filter.userId = req.user._id;
  }

  return AttendanceCorrectionRequest.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('userId', 'name employeeCode')
    .populate('actionedBy', 'name')
    .lean();
}

export async function approveCorrectionRequest(req, requestId, {
  punchInAt,
  punchOutAt,
  reviewNote
}) {
  if (!punchInAt || !punchOutAt) {
    throw httpError('Punch in and punch out times are required to approve');
  }
  const inAt = new Date(punchInAt);
  const outAt = new Date(punchOutAt);
  if (Number.isNaN(inAt.getTime()) || Number.isNaN(outAt.getTime())) {
    throw httpError('Invalid punch times');
  }
  if (outAt <= inAt) {
    throw httpError('Punch out must be after punch in');
  }

  const request = await AttendanceCorrectionRequest.findOne({
    _id: requestId,
    businessId: req.businessId,
    status: 'PENDING'
  });
  if (!request) throw httpError('Request not found', 404);

  await AttendanceDay.findOneAndUpdate(
    {
      businessId: req.businessId,
      userId: request.userId,
      date: request.date
    },
    {
      $set: {
        branchId: request.branchId || req.branchId || null,
        status: 'CORRECTED',
        source: 'ADMIN_CORRECTION',
        sessions: [{ punchInAt: inAt, punchOutAt: outAt }],
        breaks: []
      }
    },
    { upsert: true, new: true }
  );

  request.status = 'APPROVED';
  request.actionedBy = req.user._id;
  request.actionedAt = new Date();
  request.reviewNote = String(reviewNote || '').trim();
  request.appliedPunchInAt = inAt;
  request.appliedPunchOutAt = outAt;
  await request.save();
  return request;
}

export async function rejectCorrectionRequest(req, requestId, { reviewNote } = {}) {
  const request = await AttendanceCorrectionRequest.findOne({
    _id: requestId,
    businessId: req.businessId,
    status: 'PENDING'
  });
  if (!request) throw httpError('Request not found', 404);
  request.status = 'REJECTED';
  request.actionedBy = req.user._id;
  request.actionedAt = new Date();
  request.reviewNote = String(reviewNote || '').trim();
  await request.save();
  return request;
}
