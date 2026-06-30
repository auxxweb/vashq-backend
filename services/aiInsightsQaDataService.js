import mongoose from 'mongoose';
import Job from '../models/Job.model.js';
import Customer from '../models/Customer.model.js';
import User from '../models/User.model.js';
import Service from '../models/Service.model.js';
import { parseAiInsightsDateRange } from '../utils/aiInsightsDateRange.js';
import { getBusinessContext } from './aiInsightsDataService.js';

function bizOid(businessId) {
  return new mongoose.Types.ObjectId(businessId);
}

async function topCustomersByVisits(businessId, limit = 25) {
  const bid = bizOid(businessId);
  const rows = await Job.aggregate([
    { $match: { businessId: bid } },
    {
      $group: {
        _id: '$customerId',
        totalVisits: { $sum: 1 },
        lastVisit: { $max: '$createdAt' },
        totalSpent: { $sum: '$totalPrice' }
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
      $group: {
        _id: '$customerId',
        lastVisit: { $max: '$createdAt' },
        totalVisits: { $sum: 1 },
        totalSpent: { $sum: '$totalPrice' }
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
export async function gatherQaBusinessData(businessId, { range = 'this_month', from, to } = {}) {
  const { start, end, label } = parseAiInsightsDateRange(range, from, to);
  const business = await getBusinessContext(businessId);

  const [
    topCustomersAllTime,
    inactiveCustomers30d,
    newCustomers,
    employees,
    topServices
  ] = await Promise.all([
    topCustomersByVisits(businessId, 25),
    inactiveCustomers(businessId, 30, 25),
    newCustomersInPeriod(businessId, start, end, 20),
    employeeLeaderboard(businessId, start, end, 15),
    topServicesInPeriod(businessId, start, end, 10)
  ]);

  const customerIndex = {};
  for (const list of [topCustomersAllTime, inactiveCustomers30d, newCustomers]) {
    for (const c of list) {
      if (c.customerId) customerIndex[c.customerId] = c;
    }
  }

  return {
    period: { start: start.toISOString(), end: end.toISOString(), label },
    business,
    summary: {
      totalCustomersIndexed: Object.keys(customerIndex).length,
      topCustomersCount: topCustomersAllTime.length,
      inactiveCount: inactiveCustomers30d.length,
      newCustomersInPeriod: newCustomers.length
    },
    topCustomersAllTime,
    inactiveCustomers30d,
    newCustomersInPeriod: newCustomers,
    employeeLeaderboard: employees,
    topServicesInPeriod: topServices,
    customerIndex
  };
}

export function enrichQaResultWithCustomers(result, customerIndex) {
  if (!result?.dataTable?.rows?.length) return result;

  const rows = result.dataTable.rows.map((row) => {
    const id = row.customerId;
    const customer = id ? customerIndex[id] : null;
    return {
      ...row,
      customerId: id || null,
      phone: customer?.whatsappNumber || customer?.phone || row.phone || null,
      name: customer?.name || row.name || null
    };
  });

  return {
    ...result,
    dataTable: { ...result.dataTable, rows }
  };
}
