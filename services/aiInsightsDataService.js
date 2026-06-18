import mongoose from 'mongoose';
import Job from '../models/Job.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import User from '../models/User.model.js';
import Invoice from '../models/Invoice.model.js';
import Expense from '../models/Expense.model.js';
import CustomerPackage from '../models/CustomerPackage.model.js';
import PackageVisit from '../models/PackageVisit.model.js';
import PackageTemplate from '../models/PackageTemplate.model.js';
import WhatsAppMessage from '../models/WhatsAppMessage.model.js';
import Business from '../models/Business.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import { parseAiInsightsDateRange } from '../utils/aiInsightsDateRange.js';
import { sumExpenseChannelTotals } from '../utils/expensePayment.js';

const VALID_MODULES = [
  'jobs', 'employees', 'customers', 'cars', 'services',
  'packages', 'expenses', 'invoices', 'reports', 'whatsapp'
];

export { VALID_MODULES };

function bizOid(businessId) {
  return new mongoose.Types.ObjectId(businessId);
}

function dateWindow(range, from, to) {
  return parseAiInsightsDateRange(range, from, to);
}

async function getBusinessContext(businessId) {
  const [business, settings] = await Promise.all([
    Business.findById(businessId).select('businessName defaultCurrency carHandlingCapacity maxConcurrentJobs workingHoursStart workingHoursEnd').lean(),
    BusinessSettings.findOne({ businessId }).select('timezone currency').lean()
  ]);
  return {
    businessName: business?.businessName || 'Business',
    currency: settings?.currency || business?.defaultCurrency || 'USD',
    timezone: settings?.timezone || 'UTC',
    capacity: business?.maxConcurrentJobs || 1,
    workingHours: business ? `${business.workingHoursStart}–${business.workingHoursEnd}` : null
  };
}

async function aggregateJobs(businessId, start, end) {
  const bid = bizOid(businessId);
  const [statusAgg, cancelCount, peakHours, avgCompletion, revenueJobs] = await Promise.all([
    Job.aggregate([
      { $match: { businessId: bid, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$status', count: { $sum: 1 }, revenue: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'DELIVERED']] }, '$totalPrice', 0] } } } }
    ]),
    Job.countDocuments({ businessId: bid, status: 'CANCELLED', createdAt: { $gte: start, $lte: end } }),
    Job.aggregate([
      { $match: { businessId: bid, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: { $hour: '$createdAt' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]),
    Job.aggregate([
      { $match: { businessId: bid, status: 'DELIVERED', actualDelivery: { $gte: start, $lte: end } } },
      { $group: { _id: null, avgMinutes: { $avg: { $divide: [{ $subtract: ['$actualDelivery', '$createdAt'] }, 60000] } } } }
    ]),
    Job.countDocuments({ businessId: bid, createdAt: { $gte: start, $lte: end } })
  ]);

  const byStatus = {};
  let totalRevenue = 0;
  for (const row of statusAgg) {
    byStatus[row._id] = row.count;
    totalRevenue += row.revenue || 0;
  }

  return {
    totalJobs: revenueJobs,
    cancelledJobs: cancelCount,
    cancellationRate: revenueJobs > 0 ? Math.round((cancelCount / revenueJobs) * 1000) / 10 : 0,
    byStatus,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    avgCompletionMinutes: Math.round(avgCompletion[0]?.avgMinutes || 0),
    peakHours: peakHours.map((h) => ({ hour: h._id, jobs: h.count }))
  };
}

async function aggregateEmployees(businessId, start, end) {
  const bid = bizOid(businessId);
  const employees = await User.find({ businessId: bid, role: 'EMPLOYEE', status: 'ACTIVE' })
    .select('name email employeeCode')
    .lean();

  const report = await Promise.all(employees.map(async (emp) => {
    const jobs = await Job.find({
      businessId: bid,
      assignedTo: emp._id,
      createdAt: { $gte: start, $lte: end }
    }).select('status _id createdAt actualDelivery').lean();
    const completed = jobs.filter((j) => ['COMPLETED', 'DELIVERED'].includes(j.status));
    const withDelivery = jobs.filter((j) => j.actualDelivery);
    const avgMinutes = withDelivery.length
      ? Math.round(withDelivery.reduce((s, j) => s + (j.actualDelivery - new Date(j.createdAt)) / 60000, 0) / withDelivery.length)
      : 0;
    return {
      name: emp.name || emp.email,
      employeeCode: emp.employeeCode,
      totalAssigned: jobs.length,
      completed: completed.length,
      completionRate: jobs.length ? Math.round((completed.length / jobs.length) * 100) : 0,
      avgCompletionMinutes: avgMinutes,
      cancelled: jobs.filter((j) => j.status === 'CANCELLED').length
    };
  }));

  report.sort((a, b) => b.completed - a.completed);
  return {
    employeeCount: employees.length,
    employees: report,
    topPerformers: report.slice(0, 3).filter((e) => e.completed > 0),
    needsImprovement: report.filter((e) => e.totalAssigned >= 3 && e.completionRate < 70).slice(0, 3)
  };
}

async function aggregateCustomers(businessId, start, end) {
  const bid = bizOid(businessId);
  const [totalCustomers, newCustomers, jobCustomers, repeatAgg] = await Promise.all([
    Customer.countDocuments({ businessId: bid }),
    Customer.countDocuments({ businessId: bid, createdAt: { $gte: start, $lte: end } }),
    Job.aggregate([
      { $match: { businessId: bid, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$customerId', visits: { $sum: 1 } } },
      { $group: { _id: null, unique: { $sum: 1 }, repeat: { $sum: { $cond: [{ $gt: ['$visits', 1] }, 1, 0] } } } }
    ]),
    Job.aggregate([
      { $match: { businessId: bid } },
      { $group: { _id: '$customerId', lastVisit: { $max: '$createdAt' }, totalVisits: { $sum: 1 } } },
      { $match: { lastVisit: { $lt: new Date(Date.now() - 30 * 86400000) } } },
      { $count: 'inactive30d' }
    ])
  ]);

  const periodStats = jobCustomers[0] || { unique: 0, repeat: 0 };
  const inactive30d = repeatAgg[0]?.inactive30d || 0;

  return {
    totalCustomers,
    newCustomersInPeriod: newCustomers,
    activeCustomersInPeriod: periodStats.unique,
    repeatCustomersInPeriod: periodStats.repeat,
    repeatRate: periodStats.unique > 0 ? Math.round((periodStats.repeat / periodStats.unique) * 100) : 0,
    inactiveOver30Days: inactive30d
  };
}

async function aggregateCars(businessId, start, end) {
  const bid = bizOid(businessId);
  const [totalCars, brandAgg, modelAgg, jobsByCar] = await Promise.all([
    Car.countDocuments({ businessId: bid }),
    Car.aggregate([
      { $match: { businessId: bid, brand: { $exists: true, $ne: '' } } },
      { $group: { _id: '$brand', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 }
    ]),
    Car.aggregate([
      { $match: { businessId: bid, model: { $exists: true, $ne: '' } } },
      { $group: { _id: '$model', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 }
    ]),
    Job.aggregate([
      { $match: { businessId: bid, createdAt: { $gte: start, $lte: end } } },
      { $lookup: { from: 'cars', localField: 'carId', foreignField: '_id', as: 'car' } },
      { $unwind: { path: '$car', preserveNullAndEmptyArrays: true } },
      { $group: { _id: '$car.brand', jobs: { $sum: 1 }, revenue: { $sum: '$totalPrice' } } },
      { $sort: { revenue: -1 } },
      { $limit: 8 }
    ])
  ]);

  return {
    totalCars,
    topBrands: brandAgg.map((b) => ({ brand: b._id, count: b.count })),
    topModels: modelAgg.map((m) => ({ model: m._id, count: m.count })),
    revenueByBrand: jobsByCar.map((r) => ({
      brand: r._id || 'Unknown',
      jobs: r.jobs,
      revenue: Math.round((r.revenue || 0) * 100) / 100
    }))
  };
}

async function aggregateServices(businessId, start, end) {
  const bid = bizOid(businessId);
  const services = await Service.find({ businessId: bid }).select('name price estimatedTime isActive').lean();
  const usage = await Job.aggregate([
    { $match: { businessId: bid, createdAt: { $gte: start, $lte: end } } },
    { $unwind: '$services' },
    { $group: {
      _id: '$services.serviceId',
      count: { $sum: 1 },
      revenue: { $sum: '$services.price' }
    }},
    { $sort: { count: -1 } }
  ]);

  const usageMap = new Map(usage.map((u) => [String(u._id), u]));
  const enriched = services.map((s) => {
    const u = usageMap.get(String(s._id)) || { count: 0, revenue: 0 };
    return {
      name: s.name,
      price: s.price,
      isActive: s.isActive !== false,
      bookings: u.count,
      revenue: Math.round((u.revenue || 0) * 100) / 100
    };
  }).sort((a, b) => b.bookings - a.bookings);

  return {
    totalServices: services.length,
    activeServices: services.filter((s) => s.isActive !== false).length,
    services: enriched,
    mostPopular: enriched.slice(0, 5),
    leastPopular: enriched.filter((s) => s.isActive).slice(-5).reverse()
  };
}

async function aggregatePackages(businessId, start, end) {
  const bid = bizOid(businessId);
  const [templates, activePackages, newPackages, visits, packageRevenue] = await Promise.all([
    PackageTemplate.countDocuments({ businessId: bid, isActive: { $ne: false } }),
    CustomerPackage.countDocuments({ businessId: bid, status: 'active' }),
    CustomerPackage.countDocuments({ businessId: bid, createdAt: { $gte: start, $lte: end } }),
    PackageVisit.aggregate([
      { $match: { businessId: bid, date: { $gte: start, $lte: end } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Invoice.aggregate([
      { $match: { businessId: bid, saleType: 'PACKAGE', paymentStatus: 'RECEIVED', paymentReceivedAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$finalAmount' }, count: { $sum: 1 } } }
    ])
  ]);

  const visitByStatus = visits.reduce((acc, v) => { acc[v._id] = v.count; return acc; }, {});

  return {
    templateCount: templates,
    activeCustomerPackages: activePackages,
    newPackagesInPeriod: newPackages,
    visitsInPeriod: visitByStatus,
    packageRevenue: Math.round((packageRevenue[0]?.total || 0) * 100) / 100,
    packageSalesCount: packageRevenue[0]?.count || 0
  };
}

async function aggregateExpenses(businessId, start, end) {
  const bid = bizOid(businessId);
  const expenses = await Expense.find({
    businessId: bid,
    expenseDate: { $gte: start, $lte: end }
  }).populate('expenseTypeId', 'expenseName').lean();

  const totals = sumExpenseChannelTotals(expenses);
  const byCategory = expenses.reduce((acc, e) => {
    const cat = e.expenseTypeId?.expenseName || 'Uncategorized';
    acc[cat] = (acc[cat] || 0) + (e.amount || 0);
    return acc;
  }, {});

  const sortedCategories = Object.entries(byCategory)
    .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);

  return {
    totalExpenses: expenses.length,
    totalAmount: Math.round(totals.totalAmount * 100) / 100,
    cashAmount: Math.round(totals.totalCashAmount * 100) / 100,
    onlineAmount: Math.round(totals.totalOnlineAmount * 100) / 100,
    byCategory: sortedCategories,
    topCategories: sortedCategories.slice(0, 5)
  };
}

async function aggregateInvoices(businessId, start, end) {
  const bid = bizOid(businessId);
  const invoices = await Invoice.find({
    businessId: bid,
    createdAt: { $gte: start, $lte: end }
  }).select('finalAmount paymentStatus paymentMethod saleType advancePayment discount subtotal gstAmount paymentCashAmount paymentOnlineAmount').lean();

  const received = invoices.filter((i) => i.paymentStatus === 'RECEIVED');
  const pending = invoices.filter((i) => i.paymentStatus !== 'RECEIVED');
  const totalRevenue = invoices.reduce((s, i) => s + (i.finalAmount || 0), 0);
  const outstanding = pending.reduce((s, i) => s + (i.finalAmount || 0), 0);
  const avgTransaction = received.length ? received.reduce((s, i) => s + (i.finalAmount || 0), 0) / received.length : 0;

  const byMethod = received.reduce((acc, i) => {
    acc[i.paymentMethod || 'CASH'] = (acc[i.paymentMethod || 'CASH'] || 0) + 1;
    return acc;
  }, {});

  const bySaleType = invoices.reduce((acc, i) => {
    const t = i.saleType || 'JOB';
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  return {
    totalInvoices: invoices.length,
    paidInvoices: received.length,
    pendingInvoices: pending.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    outstandingAmount: Math.round(outstanding * 100) / 100,
    avgTransactionValue: Math.round(avgTransaction * 100) / 100,
    paymentMethodBreakdown: byMethod,
    saleTypeBreakdown: bySaleType
  };
}

async function aggregateWhatsApp(businessId, start, end) {
  const bid = bizOid(businessId);
  const settings = await BusinessSettings.findOne({ businessId: bid })
    .select('shopWhatsappNumber googleReviewLink whatsappTemplates')
    .lean();

  const messages = await WhatsAppMessage.find({
    businessId: bid,
    createdAt: { $gte: start, $lte: end }
  }).select('status createdAt').lean();

  const byStatus = messages.reduce((acc, m) => {
    acc[m.status] = (acc[m.status] || 0) + 1;
    return acc;
  }, {});

  const jobsInPeriod = await Job.countDocuments({ businessId: bid, createdAt: { $gte: start, $lte: end } });

  return {
    shopWhatsappConfigured: !!settings?.shopWhatsappNumber,
    googleReviewLinkConfigured: !!settings?.googleReviewLink,
    templatesConfigured: !!settings?.whatsappTemplates,
    messagesLogged: messages.length,
    messagesByStatus: byStatus,
    jobsInPeriod,
    messagingRate: jobsInPeriod > 0 ? Math.round((messages.length / jobsInPeriod) * 100) : 0
  };
}

async function aggregateReports(businessId, start, end) {
  const [jobs, employees, customers, services, packages, expenses, invoices, whatsapp] = await Promise.all([
    aggregateJobs(businessId, start, end),
    aggregateEmployees(businessId, start, end),
    aggregateCustomers(businessId, start, end),
    aggregateServices(businessId, start, end),
    aggregatePackages(businessId, start, end),
    aggregateExpenses(businessId, start, end),
    aggregateInvoices(businessId, start, end),
    aggregateWhatsApp(businessId, start, end)
  ]);

  return { jobs, employees, customers, services, packages, expenses, invoices, whatsapp };
}

export async function gatherAiInsightsData(businessId, module, { range, from, to }) {
  const mod = String(module || 'reports').toLowerCase();
  if (!VALID_MODULES.includes(mod)) {
    throw new Error(`Invalid module: ${module}`);
  }

  const { start, end, label } = dateWindow(range, from, to);
  const context = await getBusinessContext(businessId);

  const base = {
    module: mod,
    period: { start: start.toISOString(), end: end.toISOString(), label },
    business: context
  };

  switch (mod) {
    case 'jobs':
      return { ...base, data: await aggregateJobs(businessId, start, end) };
    case 'employees':
      return { ...base, data: await aggregateEmployees(businessId, start, end) };
    case 'customers':
      return { ...base, data: await aggregateCustomers(businessId, start, end) };
    case 'cars':
      return { ...base, data: await aggregateCars(businessId, start, end) };
    case 'services':
      return { ...base, data: await aggregateServices(businessId, start, end) };
    case 'packages':
      return { ...base, data: await aggregatePackages(businessId, start, end) };
    case 'expenses':
      return { ...base, data: await aggregateExpenses(businessId, start, end) };
    case 'invoices':
      return { ...base, data: await aggregateInvoices(businessId, start, end) };
    case 'whatsapp':
      return { ...base, data: await aggregateWhatsApp(businessId, start, end) };
    case 'reports':
      return { ...base, data: await aggregateReports(businessId, start, end) };
    default:
      return { ...base, data: {} };
  }
}
