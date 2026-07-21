import mongoose from 'mongoose';
import Invoice, { generateShareToken, generateInvoiceNumber } from '../models/Invoice.model.js';
import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import Customer from '../models/Customer.model.js';
import { jobLinesToInvoiceItems } from './jobServiceLines.js';
import { getInvoiceCompanySnapshot } from './invoiceCompany.js';
import {
  balanceDue,
  assertSettlementMatchesDue,
  normalizeInvoicePaymentFields
} from './invoicePayment.js';
import { deductServiceStockForSale, restoreServiceStock } from './serviceInventory.js';
import { lineQuantity } from './serviceCatalog.js';
import { isFullyPaid } from '../services/credit/outstandingService.js';
import { invalidateDashboardForBusiness } from './dashboardFinancialSync.js';

/** Counter / direct sales — not counted as wash jobs. */
export const WASH_JOB_FILTER = { directBill: { $ne: true } };
export const PRODUCT_SALE_FILTER = { directBill: true };

export function assertDirectBillEligible(catalogServices = []) {
  if (!catalogServices.length) {
    const err = new Error('Select at least one service');
    err.status = 400;
    throw err;
  }
  const ineligible = catalogServices.filter((s) => !s.isVariable || !s.skipWorkProcess);
  if (ineligible.length) {
    const err = new Error(
      'Product sales must use variable services with "Skip work process" enabled in Services settings'
    );
    err.status = 400;
    throw err;
  }
}

export function directBillStatusHistory(now = new Date()) {
  return [
    { status: 'RECEIVED', changedAt: now },
    { status: 'WORK_STARTED', changedAt: now },
    { status: 'COMPLETED', changedAt: now },
    { status: 'DELIVERED', changedAt: now }
  ];
}

async function serviceNameMapForJobLines(businessId, jobServices = [], catalogServices = []) {
  if (catalogServices?.length) {
    return new Map(catalogServices.map((s) => [String(s._id), s.name]));
  }
  const serviceIds = (jobServices || [])
    .map((s) => s.serviceId?._id || s.serviceId)
    .filter(Boolean);
  if (!serviceIds.length) return new Map();
  const svc = await Service.find({ businessId, _id: { $in: serviceIds } }).select('name').lean();
  return new Map(svc.map((s) => [String(s._id), s.name]));
}

export async function createInvoiceForJobRecord({
  job,
  businessId,
  userId,
  customer,
  car,
  catalogServices
}) {
  const existing = await Invoice.findOne({ jobId: job._id });
  if (existing) return existing;

  let invoiceNumber = generateInvoiceNumber();
  while (await Invoice.findOne({ businessId, invoiceNumber })) {
    invoiceNumber = generateInvoiceNumber();
  }

  const nameByServiceId = await serviceNameMapForJobLines(businessId, job.services, catalogServices);
  const items = jobLinesToInvoiceItems(job.services || [], nameByServiceId);
  const subtotal = job.totalPrice ?? items.reduce(
    (sum, i) => sum + (Number(i.servicePrice) || 0) * lineQuantity(i.quantity),
    0
  );
  const advanceFromJob = Math.max(0, Number(job.advancePayment) || 0);
  const company = await getInvoiceCompanySnapshot(businessId);

  return Invoice.create({
    jobId: job._id,
    businessId,
    branchId: job.branchId || null,
    invoiceNumber,
    companyName: company?.businessName || null,
    companyOwnerName: company?.ownerName || null,
    companyAddress: company?.address || null,
    companyPhone: company?.phone || null,
    companyGst: company?.gstNumber || null,
    customerName: customer?.name ?? '',
    customerPhone: customer?.phone || customer?.whatsappNumber || '',
    customerId: customer?._id || job.customerId || null,
    customerGst: null,
    vehicleNumber: car?.carNumber ?? '',
    items,
    discount: 0,
    subtotal,
    finalAmount: subtotal,
    advancePayment: advanceFromJob,
    paymentMethod: 'ONLINE',
    paymentCashAmount: 0,
    paymentOnlineAmount: 0,
    paymentStatus: 'PENDING',
    shareToken: generateShareToken(),
    createdBy: userId
  });
}

async function computeLoyaltyEarnedForJobServices(businessId, jobServices = []) {
  const serviceIds = (jobServices || []).map((s) => s?.serviceId).filter(Boolean);
  if (!serviceIds.length) return 0;

  const svc = await Service.find({ businessId, _id: { $in: serviceIds } })
    .select('loyaltyPointsEarned')
    .lean();
  const pointsById = new Map(svc.map((s) => [String(s._id), Math.max(0, Number(s.loyaltyPointsEarned || 0))]));
  return (jobServices || []).reduce((sum, line) => {
    const sid = String(line.serviceId?._id || line.serviceId || '');
    const perUnit = pointsById.get(sid) || 0;
    return sum + perUnit * lineQuantity(line.quantity);
  }, 0);
}

/**
 * Apply loyalty redemption (deduct) and optional earn when a job invoice is settled.
 * Each action runs at most once per invoice (tracked via loyaltyRedeemAppliedAt / loyaltyEarnAppliedAt).
 * Example: balance 10, redeem 5, earn 3 → new balance 8.
 */
export async function applyLoyaltySettlementForJob(
  businessId,
  customerId,
  jobServices = [],
  invoice = null,
  { earnPoints = true } = {}
) {
  if (!customerId || !invoice) return { redeemed: 0, earned: 0 };

  const redeemPoints = Math.max(0, Math.floor(Number(invoice.loyaltyRedeemedPoints) || 0));
  const earned = earnPoints ? await computeLoyaltyEarnedForJobServices(businessId, jobServices) : 0;
  const redeemDue = redeemPoints > 0 && !invoice.loyaltyRedeemAppliedAt;
  const earnDue = earned > 0 && earnPoints && !invoice.loyaltyEarnAppliedAt;
  if (!redeemDue && !earnDue) return { redeemed: 0, earned: 0 };

  const customer = await Customer.findOne({ _id: customerId, businessId }).select('loyaltyPointsBalance');
  if (!customer) return { redeemed: 0, earned: 0 };

  let balance = Number(customer.loyaltyPointsBalance || 0);
  let redeemed = 0;
  let earnedApplied = 0;

  if (redeemDue) {
    balance = Math.max(0, balance - redeemPoints);
    redeemed = redeemPoints;
    invoice.loyaltyRedeemAppliedAt = new Date();
  }
  if (earnDue) {
    balance += earned;
    earnedApplied = earned;
    invoice.loyaltyEarnAppliedAt = new Date();
  }

  customer.loyaltyPointsBalance = balance;
  await customer.save();
  await invoice.save();

  return { redeemed, earned: earnedApplied };
}

/** Credit recovery path: earn service points when a pay-later invoice becomes fully paid. */
export async function maybeEarnLoyaltyForPaidInvoice(businessId, invoiceId) {
  const invoice = await Invoice.findOne({ _id: invoiceId, businessId });
  if (!invoice?.jobId || invoice.loyaltyEarnAppliedAt) return { earned: 0 };
  if (!isFullyPaid(invoice)) return { earned: 0 };

  const job = await Job.findOne({ _id: invoice.jobId, businessId }).select('customerId services').lean();
  if (!job?.customerId) return { earned: 0 };

  const { earned } = await applyLoyaltySettlementForJob(
    businessId,
    job.customerId,
    job.services,
    invoice,
    { earnPoints: true }
  );
  return { earned };
}

export async function applyLoyaltyEarnForJob(businessId, customerId, jobServices = [], invoice = null) {
  const { earned } = await applyLoyaltySettlementForJob(
    businessId,
    customerId,
    jobServices,
    invoice,
    { earnPoints: true }
  );
  return earned;
}

export async function settleDirectBillInvoice(invoice, job, businessId, paymentBody = {}) {
  if (!paymentBody.paymentMethod) {
    const err = new Error('Payment method is required');
    err.status = 400;
    throw err;
  }

  invoice.paymentMethod = paymentBody.paymentMethod;
  normalizeInvoicePaymentFields(invoice, paymentBody);

  const due = balanceDue(invoice.finalAmount, invoice.advancePayment);
  try {
    assertSettlementMatchesDue(
      invoice.paymentMethod,
      due,
      invoice.paymentCashAmount,
      invoice.paymentOnlineAmount
    );
  } catch (e) {
    const err = new Error(e.message || 'Invalid payment amount');
    err.status = 400;
    throw err;
  }

  invoice.paymentStatus = 'RECEIVED';
  invoice.paymentReceivedAt = new Date();
  await invoice.save();
  invalidateDashboardForBusiness(businessId);

  await applyLoyaltySettlementForJob(businessId, job.customerId, job.services, invoice, { earnPoints: true });
  return invoice;
}

/**
 * Create invoice for a direct-bill job; roll back the job if invoice creation fails.
 * Settlement failure keeps the pending invoice and returns a warning (no duplicate retry needed).
 */
export async function finalizeDirectBillSale({
  job,
  businessId,
  userId,
  customer,
  car,
  catalogServices,
  collectPaymentNow,
  paymentBody = {}
}) {
  let invoice;
  let stockDeductions = [];
  try {
    invoice = await createInvoiceForJobRecord({
      job,
      businessId,
      userId,
      customer,
      car,
      catalogServices
    });
    stockDeductions = await deductServiceStockForSale(businessId, job.services, catalogServices);
  } catch (billErr) {
    if (stockDeductions.length) {
      await restoreServiceStock(businessId, stockDeductions).catch(() => {});
    }
    await Invoice.deleteOne({ jobId: job._id, businessId }).catch(() => {});
    await Job.deleteOne({ _id: job._id, businessId });
    throw billErr;
  }

  if (!collectPaymentNow) {
    return { invoice, paid: false, settlementWarning: null };
  }

  try {
    invoice = await settleDirectBillInvoice(invoice, job, businessId, paymentBody);
    return { invoice, paid: true, settlementWarning: null };
  } catch (settleErr) {
    return {
      invoice,
      paid: false,
      settlementWarning: settleErr.message || 'Payment could not be recorded. Complete payment on the invoice.'
    };
  }
}

function productSaleJobLookup(createdRange) {
  return {
    from: 'jobs',
    let: { jid: '$jobId' },
    pipeline: [
      {
        $match: {
          $expr: { $eq: ['$_id', '$$jid'] },
          directBill: true,
          createdAt: createdRange
        }
      },
      { $limit: 1 }
    ],
    as: 'job'
  };
}

/** Dashboard KPIs for variable services sold with skip work process (direct bill). */
export async function getProductSalesDashboardStats(businessId, startUtc, endUtc, branchId = null) {
  const businessObjectId = new mongoose.Types.ObjectId(String(businessId));
  const createdRange = { $gte: startUtc, $lt: endUtc };
  const jobMatch = branchId
    ? { businessId: businessObjectId, branchId: new mongoose.Types.ObjectId(String(branchId)), ...PRODUCT_SALE_FILTER, createdAt: createdRange }
    : { businessId: businessObjectId, ...PRODUCT_SALE_FILTER, createdAt: createdRange };
  const paidInRange = {
    businessId: businessObjectId,
    paymentStatus: 'RECEIVED',
    paymentReceivedAt: createdRange,
    ...(branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {})
  };

  const [productSalesCount, revenueAgg, collectedAgg, pendingAgg] = await Promise.all([
    Job.countDocuments(jobMatch),
    Invoice.aggregate([
      { $match: { businessId: businessObjectId, ...(branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {}) } },
      { $lookup: productSaleJobLookup(createdRange) },
      { $match: { job: { $ne: [] } } },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } }
    ]),
    Invoice.aggregate([
      { $match: paidInRange },
      { $lookup: productSaleJobLookup(createdRange) },
      { $match: { job: { $ne: [] } } },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } }
    ]),
    Invoice.aggregate([
      { $match: { businessId: businessObjectId, paymentStatus: 'PENDING', ...(branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {}) } },
      { $lookup: productSaleJobLookup(createdRange) },
      { $match: { job: { $ne: [] } } },
      { $count: 'count' }
    ])
  ]);

  return {
    productSalesCount,
    productSalesRevenue: Math.round((revenueAgg[0]?.total ?? 0) * 100) / 100,
    productSalesCollected: Math.round((collectedAgg[0]?.total ?? 0) * 100) / 100,
    productSalesPending: pendingAgg[0]?.count ?? 0
  };
}
