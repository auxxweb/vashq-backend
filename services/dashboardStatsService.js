import Job from '../models/Job.model.js';
import Expense from '../models/Expense.model.js';
import { WASH_JOB_FILTER, getProductSalesDashboardStats } from '../utils/directBillJob.js';
import { getPackageSalesDashboardStats } from '../utils/packageSalesDashboard.js';
import { parseBusinessDateRange } from '../utils/businessDateRange.js';
import { getTodayCashReceived, getCreditDashboardStats } from './credit/creditReportsService.js';
import {
  getPeriodSalesBreakdown,
  getPeriodSalesReceivedBreakdown
} from '../utils/dashboardTotalSales.js';
import { getBusinessModules, isModuleEnabled } from './businessModulesService.js';

const EMPTY_CASH = {
  todayCashReceived: 0,
  todayCashReceivedCash: 0,
  todayCashReceivedOnline: 0,
  todayFullPayCheckout: 0,
  todayCreditCheckout: 0,
  todayCreditRecovery: 0,
  todayAdvances: 0
};

const EMPTY_CREDIT = {
  totalOutstandingReceivables: 0,
  periodOutstandingAmount: 0,
  periodOutstandingCount: 0,
  overdueOutstandingAmount: 0,
  overdueOutstandingCount: 0,
  topOutstandingCustomers: []
};

const EMPTY_PRODUCT = {
  productSalesCount: 0,
  productSalesRevenue: 0,
  productSalesCollected: 0,
  productSalesPending: 0
};

const EMPTY_PACKAGE = {
  packageSalesCount: 0,
  packageSalesRevenue: 0,
  packageSalesCollected: 0,
  packageSalesPending: 0
};

const EMPTY_SALES = {
  jobSalesRevenue: 0,
  productSalesRevenue: 0,
  packageSalesRevenue: 0,
  creditSalesRevenue: 0,
  totalSalesRevenue: 0
};

const EMPTY_MONTHLY_RECEIVED = {
  jobSalesReceived: 0,
  productSalesReceived: 0,
  packageSalesReceived: 0,
  totalSalesReceived: 0
};

function warn(label, err) {
  console.warn(`${label}:`, err?.message || err);
}

async function safe(promise, fallback, label) {
  try {
    return await promise;
  } catch (err) {
    if (label) warn(label, err);
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

/**
 * Load dashboard KPI stats with minimal round-trips and parallel enrichment.
 */
export async function loadDashboardStats({
  businessId,
  businessTz,
  startUtc,
  endUtc,
  rangeLabel,
  range,
  isEmployee,
  baseMatch,
  expenseMatch,
  scopedBranchId,
  businessModules
}) {
  const washJobMatch = { ...baseMatch, ...WASH_JOB_FILTER };

  const [jobStats, avgResult, todayAdvanceCollectedResult, todayExpResult] = await Promise.all([
    Job.aggregate([
      { $match: washJobMatch },
      {
        $facet: {
          todayJobs: [
            { $match: { createdAt: { $gte: startUtc, $lt: endUtc } } },
            { $count: 'count' }
          ],
          inProgress: [
            {
              $match: {
                status: { $nin: ['COMPLETED', 'DELIVERED', 'CANCELLED'] },
                createdAt: { $gte: startUtc, $lt: endUtc }
              }
            },
            { $count: 'count' }
          ],
          pendingDeliveries: [
            { $match: { status: 'COMPLETED', createdAt: { $gte: startUtc, $lt: endUtc } } },
            { $count: 'count' }
          ]
        }
      }
    ]).then((r) => r[0] || {}),
    Job.aggregate([
      { $match: { ...washJobMatch, status: 'DELIVERED', actualDelivery: { $gte: startUtc, $lt: endUtc } } },
      {
        $group: {
          _id: null,
          avgMinutes: { $avg: { $divide: [{ $subtract: ['$actualDelivery', '$createdAt'] }, 60000] } }
        }
      }
    ]),
    isEmployee
      ? Promise.resolve([])
      : Job.aggregate([
        { $match: { ...washJobMatch, createdAt: { $gte: startUtc, $lt: endUtc } } },
        {
          $addFields: {
            advCash: {
              $cond: [
                { $lte: [{ $ifNull: ['$advancePayment', 0] }, 0] },
                0,
                {
                  $ifNull: [
                    '$advanceCashAmount',
                    {
                      $cond: [
                        { $eq: ['$advancePaymentMethod', 'ONLINE'] },
                        0,
                        { $ifNull: ['$advancePayment', 0] }
                      ]
                    }
                  ]
                }
              ]
            },
            advOnline: {
              $cond: [
                { $lte: [{ $ifNull: ['$advancePayment', 0] }, 0] },
                0,
                {
                  $ifNull: [
                    '$advanceOnlineAmount',
                    {
                      $cond: [
                        { $eq: ['$advancePaymentMethod', 'ONLINE'] },
                        { $ifNull: ['$advancePayment', 0] },
                        0
                      ]
                    }
                  ]
                }
              ]
            }
          }
        },
        {
          $addFields: {
            advCashFinal: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$advancePaymentMethod', 'SPLIT'] },
                    { $gt: [{ $ifNull: ['$advancePayment', 0] }, 0] },
                    { $lte: [{ $add: ['$advCash', '$advOnline'] }, 0.01] }
                  ]
                },
                { $ifNull: ['$advancePayment', 0] },
                '$advCash'
              ]
            },
            advOnlineFinal: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$advancePaymentMethod', 'SPLIT'] },
                    { $gt: [{ $ifNull: ['$advancePayment', 0] }, 0] },
                    { $lte: [{ $add: ['$advCash', '$advOnline'] }, 0.01] }
                  ]
                },
                0,
                '$advOnline'
              ]
            }
          }
        },
        { $group: { _id: null, cash: { $sum: '$advCashFinal' }, online: { $sum: '$advOnlineFinal' } } }
      ]),
    isEmployee
      ? Promise.resolve([])
      : Expense.aggregate([
        { $match: { ...expenseMatch, expenseDate: { $gte: startUtc, $lt: endUtc } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
  ]);

  const statsPayload = {
    todayJobs: jobStats.todayJobs?.[0]?.count ?? 0,
    inProgress: jobStats.inProgress?.[0]?.count ?? 0,
    pendingDeliveries: jobStats.pendingDeliveries?.[0]?.count ?? 0,
    avgCompletionTime: Math.round(avgResult[0]?.avgMinutes ?? 0),
    isEmployee: !!isEmployee,
    range,
    rangeLabel,
    rangeStartUtc: startUtc,
    rangeEndUtc: endUtc,
    businessTz
  };

  if (isEmployee) {
    Object.assign(statsPayload, {
      todaySales: 0,
      todayRevenue: 0,
      todayCashReceived: 0,
      todayCashReceivedCash: 0,
      todayCashReceivedOnline: 0,
      monthlyRevenue: 0,
      todayExpenses: 0,
      closingBalance: 0,
      monthlyTotalSales: 0
    });
    return statsPayload;
  }

  const advCashToday = todayAdvanceCollectedResult[0]?.cash ?? 0;
  const advOnlineToday = todayAdvanceCollectedResult[0]?.online ?? 0;
  const todayExpenses = todayExpResult[0]?.total ?? 0;
  const monthBounds = parseBusinessDateRange(businessTz, 'month');

  const modules = businessModules || await getBusinessModules(businessId);
  const creditOn = isModuleEnabled(modules, 'credit');

  const [
    cashReceived,
    creditStats,
    productStats,
    packageStats,
    periodSales,
    monthlyReceived
  ] = await Promise.all([
    safe(
      getTodayCashReceived(businessId, startUtc, endUtc, advCashToday, advOnlineToday, scopedBranchId),
      EMPTY_CASH,
      'Today cash received stats error'
    ),
    creditOn
      ? safe(
        getCreditDashboardStats(businessId, startUtc, endUtc, scopedBranchId),
        EMPTY_CREDIT,
        'Credit dashboard stats error'
      )
      : Promise.resolve(EMPTY_CREDIT),
    safe(
      getProductSalesDashboardStats(businessId, startUtc, endUtc, scopedBranchId),
      EMPTY_PRODUCT,
      'Product sales dashboard stats error'
    ),
    safe(
      getPackageSalesDashboardStats(businessId, startUtc, endUtc, scopedBranchId),
      EMPTY_PACKAGE,
      'Package sales dashboard stats error'
    ),
    safe(
      getPeriodSalesBreakdown(businessId, startUtc, endUtc, scopedBranchId),
      EMPTY_SALES,
      'Period sales breakdown error'
    ),
    safe(
      getPeriodSalesReceivedBreakdown(
        businessId,
        monthBounds.startUtc,
        monthBounds.endUtc,
        scopedBranchId
      ),
      EMPTY_MONTHLY_RECEIVED,
      'Monthly received breakdown error'
    )
  ]);

  Object.assign(statsPayload, cashReceived, creditStats, productStats, packageStats, periodSales);
  statsPayload.todaySales = periodSales.jobSalesRevenue;
  statsPayload.todayRevenue = periodSales.jobSalesRevenue;
  statsPayload.todayExpenses = todayExpenses;
  statsPayload.closingBalance = (cashReceived.todayCashReceived || 0) - todayExpenses;
  statsPayload.monthlyRevenue = monthlyReceived.jobSalesReceived;
  statsPayload.monthlyTotalSales = monthlyReceived.totalSalesReceived;
  statsPayload.monthlyJobSalesReceived = monthlyReceived.jobSalesReceived;
  statsPayload.monthlyProductSalesReceived = monthlyReceived.productSalesReceived;
  statsPayload.monthlyPackageSalesReceived = monthlyReceived.packageSalesReceived;

  return statsPayload;
}
