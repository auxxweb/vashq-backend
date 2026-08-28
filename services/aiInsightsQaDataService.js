import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import Job from '../models/Job.model.js';
import Customer from '../models/Customer.model.js';
import User from '../models/User.model.js';
import Service from '../models/Service.model.js';
import { parseAiInsightsDateRange } from '../utils/aiInsightsDateRange.js';
import { getBusinessContext, gatherAiInsightsData, VALID_MODULES } from './aiInsightsDataService.js';

function bizOid(businessId) {
  return new mongoose.Types.ObjectId(businessId);
}

function latestStatusChangedAt(statusHistory, status) {
  if (!Array.isArray(statusHistory)) return null;
  let latest = null;
  for (const entry of statusHistory) {
    if (entry?.status !== status || !entry.changedAt) continue;
    const t = new Date(entry.changedAt);
    if (Number.isNaN(t.getTime())) continue;
    if (!latest || t > latest) latest = t;
  }
  return latest;
}

function localYmd(date, timeZone) {
  if (!date) return null;
  const dt = DateTime.fromJSDate(date instanceof Date ? date : new Date(date), { zone: 'utc' }).setZone(timeZone);
  if (!dt.isValid) return null;
  return dt.toFormat('yyyy-MM-dd');
}

function localDateTime(date, timeZone) {
  if (!date) return null;
  const dt = DateTime.fromJSDate(date instanceof Date ? date : new Date(date), { zone: 'utc' }).setZone(timeZone);
  if (!dt.isValid) return null;
  return dt.toFormat("yyyy-MM-dd HH:mm");
}

function jobMilestoneDates(job, timeZone) {
  const workStartedAt = latestStatusChangedAt(job.statusHistory, 'WORK_STARTED');
  const completedAt = latestStatusChangedAt(job.statusHistory, 'COMPLETED');
  const deliveredFromHistory = latestStatusChangedAt(job.statusHistory, 'DELIVERED');
  const deliveredAt = job.actualDelivery ? new Date(job.actualDelivery) : deliveredFromHistory;
  const createdAt = job.createdAt ? new Date(job.createdAt) : null;
  return {
    createdAt,
    workStartedAt,
    completedAt,
    deliveredAt,
    createdLocalDate: localYmd(createdAt, timeZone),
    workStartedLocalDate: localYmd(workStartedAt, timeZone),
    completedLocalDate: localYmd(completedAt, timeZone),
    deliveredLocalDate: localYmd(deliveredAt, timeZone),
    createdLocalAt: localDateTime(createdAt, timeZone),
    workStartedLocalAt: localDateTime(workStartedAt, timeZone),
    completedLocalAt: localDateTime(completedAt, timeZone),
    deliveredLocalAt: localDateTime(deliveredAt, timeZone)
  };
}

function serializeJourneyJob(job, milestones) {
  return {
    jobId: String(job._id),
    tokenNumber: job.tokenNumber || null,
    status: job.status,
    customerId: job.customerId?._id ? String(job.customerId._id) : (job.customerId ? String(job.customerId) : null),
    customerName: job.customerId?.name || null,
    customerPhone: job.customerId?.phone || null,
    assignedTo: job.assignedTo?.name || null,
    totalPrice: Math.round((Number(job.totalPrice) || 0) * 100) / 100,
    createdLocalDate: milestones.createdLocalDate,
    workStartedLocalDate: milestones.workStartedLocalDate,
    completedLocalDate: milestones.completedLocalDate,
    deliveredLocalDate: milestones.deliveredLocalDate,
    createdLocalAt: milestones.createdLocalAt,
    workStartedLocalAt: milestones.workStartedLocalAt,
    completedLocalAt: milestones.completedLocalAt,
    deliveredLocalAt: milestones.deliveredLocalAt
  };
}

/**
 * Day-level job milestone history so AI can answer journey questions
 * (e.g. created yesterday + delivered today).
 */
async function gatherJobJourneyQaData(businessId, timeZone = 'Asia/Kolkata', periodStart, periodEnd) {
  const tz = timeZone || 'Asia/Kolkata';
  const nowZ = DateTime.now().setZone(tz);
  const todayStr = nowZ.toFormat('yyyy-MM-dd');
  const yesterdayStr = nowZ.minus({ days: 1 }).toFormat('yyyy-MM-dd');
  const lookbackDays = 30;
  const lookbackUtc = nowZ.startOf('day').minus({ days: lookbackDays }).toUTC().toJSDate();

  // Include period window + recent lookback so journey Qs always work
  const windowStartCandidates = [lookbackUtc];
  if (periodStart instanceof Date && !Number.isNaN(periodStart.getTime())) {
    windowStartCandidates.push(periodStart);
  }
  const windowStart = new Date(Math.min(...windowStartCandidates.map((d) => d.getTime())));

  const bid = bizOid(businessId);
  const jobs = await Job.find({
    businessId: bid,
    $or: [
      { createdAt: { $gte: windowStart } },
      { actualDelivery: { $gte: windowStart } },
      { 'statusHistory.changedAt': { $gte: windowStart } }
    ]
  })
    .select('tokenNumber status createdAt actualDelivery statusHistory totalPrice customerId assignedTo')
    .populate('customerId', 'name phone')
    .populate('assignedTo', 'name')
    .sort({ createdAt: -1 })
    .limit(800)
    .lean();

  const enriched = jobs.map((job) => {
    const milestones = jobMilestoneDates(job, tz);
    return { job, milestones, row: serializeJourneyJob(job, milestones) };
  });

  const filterJourney = (startField, startDate, endField, endDate) =>
    enriched
      .filter((e) => e.milestones[startField] === startDate && e.milestones[endField] === endDate)
      .map((e) => e.row);

  const createdYesterdayDeliveredToday = filterJourney(
    'createdLocalDate',
    yesterdayStr,
    'deliveredLocalDate',
    todayStr
  );
  const createdYesterdayCompletedToday = filterJourney(
    'createdLocalDate',
    yesterdayStr,
    'completedLocalDate',
    todayStr
  );
  const createdTodayDeliveredToday = filterJourney(
    'createdLocalDate',
    todayStr,
    'deliveredLocalDate',
    todayStr
  );
  const createdYesterdayStillOpen = enriched
    .filter((e) =>
      e.milestones.createdLocalDate === yesterdayStr &&
      !e.milestones.deliveredLocalDate &&
      e.job.status !== 'CANCELLED'
    )
    .map((e) => e.row);

  const createdByDay = {};
  const deliveredByDay = {};
  const completedByDay = {};
  for (const e of enriched) {
    const c = e.milestones.createdLocalDate;
    const d = e.milestones.deliveredLocalDate;
    const done = e.milestones.completedLocalDate;
    if (c) createdByDay[c] = (createdByDay[c] || 0) + 1;
    if (d) deliveredByDay[d] = (deliveredByDay[d] || 0) + 1;
    if (done) completedByDay[done] = (completedByDay[done] || 0) + 1;
  }

  // Compact list for the model (newest first) — enough to answer day-level questions
  const recentJobsWithMilestones = enriched.slice(0, 250).map((e) => e.row);

  return {
    timezone: tz,
    calendarToday: todayStr,
    calendarYesterday: yesterdayStr,
    lookbackDays,
    note:
      'Use createdLocalDate / deliveredLocalDate / completedLocalDate / workStartedLocalDate (business timezone) for day-to-day journey questions. Prefer precomputed journeys when they match the question.',
    dailyCounts: {
      createdByDay,
      completedByDay,
      deliveredByDay
    },
    precomputedJourneys: {
      createdYesterdayDeliveredToday: {
        label: `Created ${yesterdayStr} and delivered ${todayStr}`,
        count: createdYesterdayDeliveredToday.length,
        jobs: createdYesterdayDeliveredToday
      },
      createdYesterdayCompletedToday: {
        label: `Created ${yesterdayStr} and completed ${todayStr}`,
        count: createdYesterdayCompletedToday.length,
        jobs: createdYesterdayCompletedToday
      },
      createdTodayDeliveredToday: {
        label: `Created and delivered on ${todayStr}`,
        count: createdTodayDeliveredToday.length,
        jobs: createdTodayDeliveredToday
      },
      createdYesterdayStillOpen: {
        label: `Created ${yesterdayStr} and not yet delivered`,
        count: createdYesterdayStillOpen.length,
        jobs: createdYesterdayStillOpen
      }
    },
    recentJobsWithMilestones
  };
}

async function topCustomersByVisits(businessId, limit = 25) {
  const bid = bizOid(businessId);
  const rows = await Job.aggregate([
    { $match: { businessId: bid } },
    {
      $lookup: {
        from: 'invoices',
        localField: '_id',
        foreignField: 'jobId',
        as: 'inv'
      }
    },
    {
      $addFields: {
        billedAmount: {
          $ifNull: [{ $arrayElemAt: ['$inv.finalAmount', 0] }, '$totalPrice']
        }
      }
    },
    {
      $group: {
        _id: '$customerId',
        totalVisits: { $sum: 1 },
        lastVisit: { $max: '$createdAt' },
        totalSpent: { $sum: { $ifNull: ['$billedAmount', 0] } }
      }
    },
    { $sort: { totalVisits: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'customer'
      }
    },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } }
  ]);

  return rows.map((r) => ({
    customerId: String(r._id),
    name: r.customer?.name || 'Unknown',
    phone: r.customer?.phone || r.customer?.whatsappNumber || '',
    whatsappNumber: r.customer?.whatsappNumber || r.customer?.phone || '',
    totalVisits: r.totalVisits,
    lastVisit: r.lastVisit?.toISOString?.() || null,
    totalSpent: Math.round((r.totalSpent || 0) * 100) / 100,
    loyaltyPoints: r.customer?.loyaltyPoints || 0
  }));
}

async function inactiveCustomers(businessId, days = 30, limit = 25) {
  const bid = bizOid(businessId);
  const cutoff = new Date(Date.now() - days * 86400000);
  const rows = await Job.aggregate([
    { $match: { businessId: bid } },
    {
      $lookup: {
        from: 'invoices',
        localField: '_id',
        foreignField: 'jobId',
        as: 'inv'
      }
    },
    {
      $addFields: {
        billedAmount: {
          $ifNull: [{ $arrayElemAt: ['$inv.finalAmount', 0] }, '$totalPrice']
        }
      }
    },
    {
      $group: {
        _id: '$customerId',
        lastVisit: { $max: '$createdAt' },
        totalVisits: { $sum: 1 },
        totalSpent: { $sum: { $ifNull: ['$billedAmount', 0] } }
      }
    },
    { $match: { lastVisit: { $lt: cutoff } } },
    { $sort: { lastVisit: 1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'customer'
      }
    },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } }
  ]);

  return rows.map((r) => ({
    customerId: String(r._id),
    name: r.customer?.name || 'Unknown',
    phone: r.customer?.phone || r.customer?.whatsappNumber || '',
    whatsappNumber: r.customer?.whatsappNumber || r.customer?.phone || '',
    totalVisits: r.totalVisits,
    lastVisit: r.lastVisit?.toISOString?.() || null,
    daysSinceVisit: r.lastVisit ? Math.floor((Date.now() - new Date(r.lastVisit).getTime()) / 86400000) : null,
    totalSpent: Math.round((r.totalSpent || 0) * 100) / 100
  }));
}

async function newCustomersInPeriod(businessId, start, end, limit = 20) {
  const bid = bizOid(businessId);
  const customers = await Customer.find({
    businessId: bid,
    createdAt: { $gte: start, $lte: end }
  })
    .select('name phone whatsappNumber loyaltyPoints createdAt')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return customers.map((c) => ({
    customerId: String(c._id),
    name: c.name,
    phone: c.phone || c.whatsappNumber || '',
    whatsappNumber: c.whatsappNumber || c.phone || '',
    joinedAt: c.createdAt?.toISOString?.() || null,
    loyaltyPoints: c.loyaltyPoints || 0
  }));
}

async function employeeLeaderboard(businessId, start, end, limit = 15) {
  const bid = bizOid(businessId);
  const employees = await User.find({ businessId: bid, role: 'EMPLOYEE', status: 'ACTIVE' })
    .select('name employeeCode _id')
    .lean();

  const stats = await Promise.all(employees.map(async (emp) => {
    const jobs = await Job.find({
      businessId: bid,
      assignedTo: emp._id,
      createdAt: { $gte: start, $lte: end }
    }).select('status').lean();
    const completed = jobs.filter((j) => ['COMPLETED', 'DELIVERED'].includes(j.status)).length;
    return {
      employeeId: String(emp._id),
      name: emp.name,
      employeeCode: emp.employeeCode,
      assigned: jobs.length,
      completed,
      completionRate: jobs.length ? Math.round((completed / jobs.length) * 100) : 0
    };
  }));

  return stats.sort((a, b) => b.completed - a.completed).slice(0, limit);
}

async function topServicesInPeriod(businessId, start, end, limit = 10) {
  const bid = bizOid(businessId);
  const usage = await Job.aggregate([
    { $match: { businessId: bid, createdAt: { $gte: start, $lte: end } } },
    { $unwind: '$services' },
    {
      $group: {
        _id: '$services.serviceId',
        count: { $sum: 1 },
        revenue: { $sum: '$services.price' }
      }
    },
    { $sort: { count: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'services',
        localField: '_id',
        foreignField: '_id',
        as: 'service'
      }
    },
    { $unwind: { path: '$service', preserveNullAndEmptyArrays: true } }
  ]);

  return usage.map((u) => ({
    serviceId: String(u._id),
    name: u.service?.name || 'Unknown',
    bookings: u.count,
    revenue: Math.round((u.revenue || 0) * 100) / 100
  }));
}

/** Rich business snapshot for natural-language Q&A (includes customer IDs for actions). */
export async function gatherQaBusinessData(businessId, { range = 'this_month', from, to, module = 'reports' } = {}) {
  const { start, end, label } = parseAiInsightsDateRange(range, from, to);
  const analyticsModule = VALID_MODULES.includes(String(module || '').toLowerCase())
    ? String(module).toLowerCase()
    : 'reports';

  const business = await getBusinessContext(businessId);

  const [
    topCustomersAllTime,
    inactiveCustomers30d,
    newCustomers,
    employees,
    topServices,
    insightsPack,
    jobJourneys
  ] = await Promise.all([
    topCustomersByVisits(businessId, 40),
    inactiveCustomers(businessId, 30, 40),
    newCustomersInPeriod(businessId, start, end, 30),
    employeeLeaderboard(businessId, start, end, 25),
    topServicesInPeriod(businessId, start, end, 20),
    gatherAiInsightsData(businessId, analyticsModule === 'reports' ? 'reports' : analyticsModule, {
      range,
      from,
      to
    }),
    gatherJobJourneyQaData(businessId, business.timezone, start, end)
  ]);

  const customerIndex = {};
  for (const list of [topCustomersAllTime, inactiveCustomers30d, newCustomers]) {
    for (const c of list) {
      if (c.customerId) customerIndex[c.customerId] = c;
    }
  }
  for (const j of jobJourneys?.recentJobsWithMilestones || []) {
    if (j.customerId && !customerIndex[j.customerId]) {
      customerIndex[j.customerId] = {
        customerId: j.customerId,
        name: j.customerName,
        phone: j.customerPhone,
        whatsappNumber: j.customerPhone
      };
    }
  }

  const analytics = insightsPack?.data || {};
  const y2t = jobJourneys?.precomputedJourneys?.createdYesterdayDeliveredToday;

  const jobIndex = {};
  const addJobToIndex = (j) => {
    if (!j?.jobId) return;
    jobIndex[j.jobId] = {
      jobId: j.jobId,
      customerId: j.customerId || null,
      tokenNumber: j.tokenNumber || null
    };
  };
  for (const j of jobJourneys?.recentJobsWithMilestones || []) addJobToIndex(j);
  for (const journey of Object.values(jobJourneys?.precomputedJourneys || {})) {
    for (const j of journey?.jobs || []) addJobToIndex(j);
  }

  return {
    period: { start: start.toISOString(), end: end.toISOString(), label },
    business: insightsPack?.business || business,
    module: analyticsModule,
    summary: {
      totalCustomersIndexed: Object.keys(customerIndex).length,
      topCustomersCount: topCustomersAllTime.length,
      inactiveCount: inactiveCustomers30d.length,
      newCustomersInPeriod: newCustomers.length,
      jobsTotal: analytics.jobs?.totalJobs ?? null,
      jobsRevenue: analytics.jobs?.totalRevenue ?? null,
      invoiceRevenue: analytics.invoices?.totalRevenue ?? analytics.invoices?.totalBilled ?? null,
      expenseTotal: analytics.expenses?.totalAmount ?? analytics.expenses?.total ?? null,
      activeEmployees: analytics.employees?.employeeCount ?? null,
      createdYesterdayDeliveredToday: y2t?.count ?? 0,
      calendarToday: jobJourneys?.calendarToday || null,
      calendarYesterday: jobJourneys?.calendarYesterday || null
    },
    topCustomersAllTime,
    inactiveCustomers30d,
    newCustomersInPeriod: newCustomers,
    employeeLeaderboard: employees,
    topServicesInPeriod: topServices,
    /** Full business analytics for the selected period */
    analytics,
    /** Day-level job milestones + precomputed journeys (created yesterday → delivered today, etc.) */
    jobJourneys,
    customerIndex,
    jobIndex
  };
}

export function enrichQaResultWithCustomers(result, customerIndex, jobIndex = {}) {
  if (!result?.dataTable?.rows?.length) return result;

  const columns = (result.dataTable.columns || []).map((c) => String(c || '').toLowerCase());
  const mongoIdRe = /^[a-f\d]{24}$/i;

  const rows = result.dataTable.rows.map((row) => {
    const cells = Array.isArray(row.cells) ? row.cells : [];
    let customerId = row.customerId && customerIndex[row.customerId] ? row.customerId : (row.customerId || null);
    let jobId = row.jobId || null;
    let invoiceId = row.invoiceId || null;

    columns.forEach((col, i) => {
      const val = String(cells[i] ?? '').trim();
      if (!mongoIdRe.test(val)) return;
      if (/\bjob\b/.test(col) && !jobId) jobId = val;
      if (/\binvoice\b/.test(col) && !invoiceId) invoiceId = val;
      if (/\bcustomer\b/.test(col) && /\bid\b/.test(col) && !customerId) customerId = val;
    });

    // Match job from index when cell is a known job id
    if (!jobId) {
      for (const cell of cells) {
        const val = String(cell ?? '').trim();
        if (jobIndex[val]) {
          jobId = val;
          break;
        }
      }
    }

    if (jobId && jobIndex[jobId]?.customerId && !customerId) {
      customerId = jobIndex[jobId].customerId;
    }

    const customer = customerId ? customerIndex[customerId] : null;
    return {
      ...row,
      customerId: customerId || null,
      jobId: jobId || null,
      invoiceId: invoiceId || null,
      phone: customer?.whatsappNumber || customer?.phone || row.phone || null,
      name: customer?.name || row.name || null
    };
  });

  return {
    ...result,
    dataTable: { ...result.dataTable, rows }
  };
}
