import mongoose from 'mongoose';
import Business from '../models/Business.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Branch from '../models/Branch.model.js';
import BranchCreationRequest from '../models/BranchCreationRequest.model.js';
import BranchSubscription from '../models/BranchSubscription.model.js';
import BranchSettings from '../models/BranchSettings.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import PackageTemplate from '../models/PackageTemplate.model.js';
import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';
import Expense from '../models/Expense.model.js';
import Booking from '../models/Booking.model.js';
import PackageVisit from '../models/PackageVisit.model.js';
import CustomerPackage from '../models/CustomerPackage.model.js';
import User from '../models/User.model.js';
import WhatsAppMessage from '../models/WhatsAppMessage.model.js';
import { getBranchPlatformConfig, normalizeBranchCode, suggestBranchCode } from '../utils/branchConfig.js';
import { getBusinessModules, isModuleEnabled } from './businessModulesService.js';
import { cacheGetOrSet, cacheDelete } from '../utils/cache.js';

const DEFAULT_BRANCH_CACHE_TTL = 120_000;

export async function seedBranchSettingsFromBusiness(businessId, branchId) {
  const [businessSettings, business] = await Promise.all([
    BusinessSettings.findOne({ businessId }).lean(),
    Business.findById(businessId).select('googleReviewLink').lean()
  ]);

  const payload = {
    branchId,
    businessId,
    timezone: businessSettings?.timezone || 'UTC',
    capacity: businessSettings?.capacity ?? 5,
    autoSendWhatsApp: businessSettings?.autoSendWhatsApp !== false,
    shopWhatsappNumber: businessSettings?.shopWhatsappNumber || '',
    googleReviewLink: businessSettings?.googleReviewLink || business?.googleReviewLink || '',
    whatsappTemplates: businessSettings?.whatsappTemplates || {},
    upiId: businessSettings?.upiId || '',
    qrCodeImage: businessSettings?.qrCodeImage || '',
    paymentMobileNumber: businessSettings?.paymentMobileNumber || '',
    gstNumber: businessSettings?.gstNumber || '',
    taxPercentage: businessSettings?.taxPercentage,
    onlineBookingEnabled: businessSettings?.onlineBookingEnabled !== false,
    bookingAllowedDays: businessSettings?.bookingAllowedDays || [],
    bookingAdvanceDays: businessSettings?.bookingAdvanceDays ?? 30
  };

  const existing = await BranchSettings.findOne({ branchId });
  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    return existing;
  }
  return BranchSettings.create(payload);
}

export async function ensureDefaultBranchForBusiness(businessId) {
  const businessObjectId = typeof businessId === 'string'
    ? new mongoose.Types.ObjectId(businessId)
    : businessId;
  const cacheKey = `defaultBranch:${String(businessObjectId)}`;

  const cached = await cacheGetOrSet(cacheKey, DEFAULT_BRANCH_CACHE_TTL, async () => {
    const branch = await resolveDefaultBranchForBusiness(businessObjectId);
    return branch?.toObject ? branch.toObject() : branch;
  });

  if (!cached) return null;
  return Branch.hydrate(cached);
}

async function resolveDefaultBranchForBusiness(businessObjectId) {
  let defaultBranch = await Branch.findOne({ businessId: businessObjectId, isDefault: true });
  if (defaultBranch) {
    await backfillBranchIdOnLegacyRecords(businessObjectId, defaultBranch._id);
    return defaultBranch;
  }

  const anyBranch = await Branch.findOne({ businessId: businessObjectId, status: 'ACTIVE' });
  if (anyBranch) {
    await backfillBranchIdOnLegacyRecords(businessObjectId, anyBranch._id);
    return anyBranch;
  }

  const business = await Business.findById(businessObjectId);
  if (!business) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }

  let code = 'MAIN';
  let suffix = 0;
  while (await Branch.exists({ businessId: businessObjectId, code })) {
    suffix += 1;
    code = `MAIN${suffix}`;
  }

  defaultBranch = await Branch.create({
    businessId: businessObjectId,
    name: business.businessName || 'Main Branch',
    code,
    address: business.address || '',
    phone: business.phone || '',
    email: business.email || '',
    location: business.location || '',
    workingHoursStart: business.workingHoursStart || '09:00',
    workingHoursEnd: business.workingHoursEnd || '18:00',
    maxConcurrentJobs: business.maxConcurrentJobs || 1,
    status: 'ACTIVE',
    isDefault: true,
    activatedAt: new Date()
  });

  await seedBranchSettingsFromBusiness(businessObjectId, defaultBranch._id);
  await backfillBranchIdOnLegacyRecords(businessObjectId, defaultBranch._id);
  return defaultBranch;
}

async function backfillBranchIdOnLegacyRecords(businessId, branchId) {
  const missingBranch = { $or: [{ branchId: null }, { branchId: { $exists: false } }] };
  const staffMissingBranch = {
    businessId,
    role: { $in: ['EMPLOYEE', 'BRANCH_ADMIN'] },
    ...missingBranch
  };

  const [
    jobs,
    invoices,
    expenses,
    bookings,
    packageVisits,
    customers,
    cars,
    services,
    customerPackages,
    staff,
    whatsappMessages
  ] = await Promise.all([
    Job.updateMany({ businessId, ...missingBranch }, { $set: { branchId } }),
    Invoice.updateMany({ businessId, ...missingBranch }, { $set: { branchId } }),
    Expense.updateMany({ businessId, ...missingBranch }, { $set: { branchId } }),
    Booking.updateMany({ businessId, ...missingBranch }, { $set: { branchId } }),
    PackageVisit.updateMany({ businessId, ...missingBranch }, { $set: { branchId } }),
    Customer.updateMany({ businessId, ...missingBranch }, { $set: { branchId } }),
    Car.updateMany({ businessId, ...missingBranch }, { $set: { branchId } }),
    Service.updateMany({ businessId, ...missingBranch }, { $set: { branchId } }),
    CustomerPackage.updateMany({ businessId, ...missingBranch }, { $set: { branchId } }),
    User.updateMany(staffMissingBranch, { $set: { branchId } }),
    WhatsAppMessage.updateMany({ businessId, ...missingBranch }, { $set: { branchId } })
  ]);

  return {
    jobs: jobs.modifiedCount,
    invoices: invoices.modifiedCount,
    expenses: expenses.modifiedCount,
    bookings: bookings.modifiedCount,
    packageVisits: packageVisits.modifiedCount,
    customers: customers.modifiedCount,
    cars: cars.modifiedCount,
    services: services.modifiedCount,
    customerPackages: customerPackages.modifiedCount,
    staff: staff.modifiedCount,
    whatsappMessages: whatsappMessages.modifiedCount
  };
}

/** Count legacy records missing branchId for a business (for migration reporting). */
export async function countLegacyBranchIdGaps(businessId) {
  const missingBranch = { $or: [{ branchId: null }, { branchId: { $exists: false } }] };
  const staffFilter = {
    businessId,
    role: { $in: ['EMPLOYEE', 'BRANCH_ADMIN'] },
    ...missingBranch
  };

  const [
    jobs,
    invoices,
    expenses,
    bookings,
    packageVisits,
    customers,
    cars,
    services,
    customerPackages,
    staff,
    whatsappMessages
  ] = await Promise.all([
    Job.countDocuments({ businessId, ...missingBranch }),
    Invoice.countDocuments({ businessId, ...missingBranch }),
    Expense.countDocuments({ businessId, ...missingBranch }),
    Booking.countDocuments({ businessId, ...missingBranch }),
    PackageVisit.countDocuments({ businessId, ...missingBranch }),
    Customer.countDocuments({ businessId, ...missingBranch }),
    Car.countDocuments({ businessId, ...missingBranch }),
    Service.countDocuments({ businessId, ...missingBranch }),
    CustomerPackage.countDocuments({ businessId, ...missingBranch }),
    User.countDocuments(staffFilter),
    WhatsAppMessage.countDocuments({ businessId, ...missingBranch })
  ]);

  return {
    jobs,
    invoices,
    expenses,
    bookings,
    packageVisits,
    customers,
    cars,
    services,
    customerPackages,
    staff,
    whatsappMessages,
    total: jobs + invoices + expenses + bookings + packageVisits + customers + cars
      + services + customerPackages + staff + whatsappMessages
  };
}

/** Copy services and package templates from default branch to a new branch. */
export async function seedBranchCatalogFromDefault(businessId, newBranchId) {
  const defaultBranch = await Branch.findOne({ businessId, isDefault: true }).lean();
  if (!defaultBranch || String(defaultBranch._id) === String(newBranchId)) return;

  const [services, templates] = await Promise.all([
    Service.find({ businessId, branchId: defaultBranch._id }).lean(),
    PackageTemplate.find({ businessId }).lean()
  ]);

  if (services.length) {
    const serviceIdMap = new Map();
    for (const svc of services) {
      const created = await Service.create({
        businessId,
        branchId: newBranchId,
        name: svc.name,
        price: svc.price,
        minTime: svc.minTime,
        maxTime: svc.maxTime,
        description: svc.description,
        loyaltyPointsEarned: svc.loyaltyPointsEarned,
        isVariable: svc.isVariable,
        skipWorkProcess: svc.skipWorkProcess,
        isActive: svc.isActive
      });
      serviceIdMap.set(String(svc._id), created._id);
    }
    for (const tpl of templates) {
      const mappedServices = (tpl.servicesIncluded || []).map((row) => ({
        serviceId: serviceIdMap.get(String(row.serviceId)) || row.serviceId,
        quantity: row.quantity
      })).filter((row) => row.serviceId);
      await PackageTemplate.create({
        businessId,
        name: tpl.name,
        price: tpl.price,
        totalVisits: tpl.totalVisits,
        validityDays: tpl.validityDays,
        servicesIncluded: mappedServices,
        description: tpl.description,
        isActive: tpl.isActive
      });
    }
  }
}

export async function getBranchUsageStats(businessId) {
  const config = await getBranchPlatformConfig();
  const [activeCount, pendingCount] = await Promise.all([
    Branch.countDocuments({ businessId, status: 'ACTIVE' }),
    BranchCreationRequest.countDocuments({ businessId, status: 'PENDING' })
  ]);
  const addonBranches = Math.max(0, activeCount - config.includedBranchesPerShop);
  return {
    ...config,
    activeCount,
    pendingCount,
    addonBranches,
    canRequestMore: activeCount + pendingCount < config.maxBranchesPerBusiness
  };
}

export async function assertCanSubmitBranchRequest(businessId) {
  const stats = await getBranchUsageStats(businessId);
  if (stats.pendingCount > 0) {
    const err = new Error('You already have a pending branch request. Wait for platform approval.');
    err.status = 400;
    throw err;
  }
  if (!stats.canRequestMore) {
    const err = new Error(`Maximum of ${stats.maxBranchesPerBusiness} branches reached. Contact support.`);
    err.status = 400;
    throw err;
  }
  return stats;
}

export function branchLicenseNeedsRenewal(branch, sub) {
  if (!branch || branch.isDefault || !sub) return false;
  const now = new Date();
  const expiry = sub.expiryDate ? new Date(sub.expiryDate) : null;
  if (branch.status === 'EXPIRED' || sub.status === 'EXPIRED') return true;
  if (sub.status === 'PENDING_RENEWAL') return true;
  if (expiry && expiry < now) return true;
  if (expiry) {
    const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return daysLeft <= 60;
  }
  return false;
}

export async function assertCanSubmitBranchRenewal(businessId, branchId) {
  const pending = await BranchCreationRequest.findOne({
    businessId,
    status: 'PENDING',
    requestType: 'RENEW',
    renewBranchId: branchId
  });
  if (pending) {
    const err = new Error('A renewal request for this branch is already pending.');
    err.status = 400;
    throw err;
  }
  const anyPending = await BranchCreationRequest.findOne({ businessId, status: 'PENDING', requestType: 'CREATE' });
  if (anyPending) {
    const err = new Error('You already have a pending branch request. Wait for platform approval.');
    err.status = 400;
    throw err;
  }
}

export async function submitBranchRenewalRequest(businessId, userId, branchId, message) {
  await assertCanSubmitBranchRenewal(businessId, branchId);
  const branch = await Branch.findOne({ _id: branchId, businessId });
  if (!branch) {
    const err = new Error('Branch not found');
    err.status = 404;
    throw err;
  }
  if (branch.isDefault) {
    const err = new Error('Main branch is covered by your shop subscription. Renew your shop plan instead.');
    err.status = 400;
    throw err;
  }
  const sub = await BranchSubscription.findOne({ branchId: branch._id });
  if (!sub) {
    const err = new Error('This branch has no paid license to renew.');
    err.status = 400;
    throw err;
  }
  if (!branchLicenseNeedsRenewal(branch, sub)) {
    const err = new Error('Branch license is still active. Renewal is available within 60 days of expiry or after expiry.');
    err.status = 400;
    throw err;
  }

  const request = await BranchCreationRequest.create({
    businessId,
    requestedBy: userId,
    requestType: 'RENEW',
    renewBranchId: branch._id,
    name: branch.name,
    code: branch.code,
    address: branch.address || '',
    phone: branch.phone || '',
    email: branch.email || '',
    message: message || undefined,
    status: 'PENDING'
  });

  sub.lastRequestId = request._id;
  await sub.save();

  return request;
}

async function approveBranchRenewalRequest(request, superAdminUserId, paymentBody = {}) {
  const config = await getBranchPlatformConfig();
  const { transactionId, amount } = paymentBody;
  if (!transactionId || !String(transactionId).trim()) {
    const err = new Error('Transaction ID is required');
    err.status = 400;
    throw err;
  }
  if (amount == null || Number.isNaN(Number(amount))) {
    const err = new Error('Amount is required');
    err.status = 400;
    throw err;
  }
  if (Number(amount) < config.branchAnnualFee) {
    const err = new Error(`Renewal fee must be at least ₹${config.branchAnnualFee}`);
    err.status = 400;
    throw err;
  }

  const branch = await Branch.findOne({ _id: request.renewBranchId, businessId: request.businessId });
  if (!branch) {
    const err = new Error('Branch not found');
    err.status = 404;
    throw err;
  }

  let sub = await BranchSubscription.findOne({ branchId: branch._id });
  const now = new Date();
  const base = sub?.expiryDate && new Date(sub.expiryDate) > now ? new Date(sub.expiryDate) : now;
  const expiryDate = new Date(base);
  expiryDate.setDate(expiryDate.getDate() + config.branchValidityDays);

  if (sub) {
    sub.startDate = sub.startDate || now;
    sub.expiryDate = expiryDate;
    sub.status = 'ACTIVE';
    sub.annualFee = config.branchAnnualFee;
    sub.lastRequestId = request._id;
    await sub.save();
  } else {
    sub = await BranchSubscription.create({
      branchId: branch._id,
      businessId: request.businessId,
      startDate: now,
      expiryDate,
      annualFee: config.branchAnnualFee,
      status: 'ACTIVE',
      lastRequestId: request._id
    });
  }

  branch.status = 'ACTIVE';
  await branch.save();

  request.transaction = {
    transactionId: String(paymentBody.transactionId).trim(),
    method: paymentBody.method ? String(paymentBody.method).trim() : undefined,
    amount: Number(paymentBody.amount),
    paidAt: paymentBody.paidAt ? new Date(paymentBody.paidAt) : new Date(),
    notes: paymentBody.notes ? String(paymentBody.notes).trim() : undefined
  };
  request.status = 'APPROVED';
  request.approvedBranchId = branch._id;
  request.actionedBy = superAdminUserId;
  request.actionedAt = new Date();
  await request.save();

  return { branch, request, subscription: sub, isAddon: true, isRenewal: true };
}

export async function rejectBranchCreationRequest(request, superAdminUserId, reason) {
  if (request.status !== 'PENDING') {
    const err = new Error('Request already processed');
    err.status = 400;
    throw err;
  }
  request.status = 'REJECTED';
  request.rejectionReason = reason ? String(reason).trim() : undefined;
  request.actionedBy = superAdminUserId;
  request.actionedAt = new Date();
  await request.save();

  if (request.requestType === 'RENEW' && request.renewBranchId) {
    const sub = await BranchSubscription.findOne({ branchId: request.renewBranchId });
    if (sub?.status === 'PENDING_RENEWAL') {
      const now = new Date();
      const isPastExpiry = sub.expiryDate && new Date(sub.expiryDate) < now;
      sub.status = isPastExpiry ? 'EXPIRED' : 'ACTIVE';
      await sub.save();
      if (isPastExpiry) {
        await Branch.updateOne({ _id: request.renewBranchId }, { status: 'EXPIRED' });
      } else {
        await Branch.updateOne({ _id: request.renewBranchId }, { status: 'ACTIVE' });
      }
    }
  }

  return request;
}

export async function approveBranchCreationRequest(request, superAdminUserId, paymentBody = {}) {
  if (request.status !== 'PENDING') {
    const err = new Error('Request already processed');
    err.status = 400;
    throw err;
  }

  if (request.requestType === 'RENEW') {
    return approveBranchRenewalRequest(request, superAdminUserId, paymentBody);
  }

  const config = await getBranchPlatformConfig();
  const stats = await getBranchUsageStats(request.businessId);

  if (!stats.canRequestMore) {
    const err = new Error('Business has reached the maximum branch limit');
    err.status = 400;
    throw err;
  }

  const isAddon = stats.activeCount >= config.includedBranchesPerShop;
  if (isAddon) {
    const { transactionId, amount } = paymentBody;
    if (!transactionId || !String(transactionId).trim()) {
      const err = new Error('Transaction ID is required');
      err.status = 400;
      throw err;
    }
    if (amount == null || Number.isNaN(Number(amount))) {
      const err = new Error('Amount is required');
      err.status = 400;
      throw err;
    }
    if (Number(amount) < config.branchAnnualFee) {
      const err = new Error(`Branch fee must be at least ₹${config.branchAnnualFee}`);
      err.status = 400;
      throw err;
    }
  }

  const code = normalizeBranchCode(request.code);
  const duplicate = await Branch.findOne({ businessId: request.businessId, code });
  if (duplicate) {
    const err = new Error(`Branch code "${code}" is already in use`);
    err.status = 400;
    throw err;
  }

  const branch = await Branch.create({
    businessId: request.businessId,
    name: request.name.trim(),
    code,
    address: request.address || '',
    phone: request.phone || '',
    email: request.email || '',
    location: request.location || '',
    workingHoursStart: request.workingHoursStart || '09:00',
    workingHoursEnd: request.workingHoursEnd || '18:00',
    maxConcurrentJobs: request.maxConcurrentJobs || 1,
    status: 'ACTIVE',
    isDefault: false,
    requestId: request._id,
    activatedAt: new Date()
  });

  await seedBranchSettingsFromBusiness(request.businessId, branch._id);
  cacheDelete(`defaultBranch:${String(request.businessId)}`);

  if (isAddon) {
    const startDate = new Date();
    const expiryDate = new Date(startDate);
    expiryDate.setDate(expiryDate.getDate() + config.branchValidityDays);
    await BranchSubscription.create({
      branchId: branch._id,
      businessId: request.businessId,
      startDate,
      expiryDate,
      annualFee: config.branchAnnualFee,
      status: 'ACTIVE',
      lastRequestId: request._id
    });
    request.transaction = {
      transactionId: String(paymentBody.transactionId).trim(),
      method: paymentBody.method ? String(paymentBody.method).trim() : undefined,
      amount: Number(paymentBody.amount),
      paidAt: paymentBody.paidAt ? new Date(paymentBody.paidAt) : new Date(),
      notes: paymentBody.notes ? String(paymentBody.notes).trim() : undefined
    };
  }

  request.status = 'APPROVED';
  request.approvedBranchId = branch._id;
  request.actionedBy = superAdminUserId;
  request.actionedAt = new Date();
  await request.save();

  return { branch, request, isAddon };
}

const BRANCH_SETTINGS_FIELDS = [
  'timezone', 'capacity', 'autoSendWhatsApp', 'shopWhatsappNumber', 'googleReviewLink',
  'whatsappTemplates', 'upiId', 'qrCodeImage', 'paymentMobileNumber', 'gstNumber',
  'taxPercentage', 'onlineBookingEnabled', 'bookingAllowedDays', 'bookingAdvanceDays'
];

export async function getBranchSettingsForOwner(businessId, branchId) {
  const branch = await Branch.findOne({ _id: branchId, businessId }).lean();
  if (!branch) {
    const err = new Error('Branch not found');
    err.status = 404;
    throw err;
  }
  let settings = await BranchSettings.findOne({ branchId }).lean();
  if (!settings) {
    const seeded = await seedBranchSettingsFromBusiness(businessId, branchId);
    settings = seeded.toObject ? seeded.toObject() : seeded;
  }
  return { branch, settings };
}

export async function updateBranchSettings(businessId, branchId, payload) {
  await getBranchSettingsForOwner(businessId, branchId);
  const update = {};
  for (const key of BRANCH_SETTINGS_FIELDS) {
    if (payload[key] !== undefined) update[key] = payload[key];
  }
  if (payload.whatsappTemplates) {
    update.whatsappTemplates = {
      ...(payload.whatsappTemplates || {})
    };
  }
  const settings = await BranchSettings.findOneAndUpdate(
    { branchId },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return settings;
}

export async function getBranchOverviewStats(businessId, startUtc, endUtc) {
  const bizOid = typeof businessId === 'string'
    ? new mongoose.Types.ObjectId(businessId)
    : businessId;
  const branches = await Branch.find({ businessId: bizOid, status: { $in: ['ACTIVE', 'EXPIRED'] } })
    .sort({ isDefault: -1, name: 1 })
    .lean();

  const rows = await Promise.all(branches.map(async (branch) => {
    const branchOid = branch._id;
    const [todayJobs, inProgress, revenueAgg, expenseAgg, operational] = await Promise.all([
      Job.countDocuments({
        businessId: bizOid,
        branchId: branchOid,
        directBill: { $ne: true },
        createdAt: { $gte: startUtc, $lt: endUtc }
      }),
      Job.countDocuments({
        businessId: bizOid,
        branchId: branchOid,
        status: { $nin: ['COMPLETED', 'DELIVERED', 'CANCELLED'] }
      }),
      Invoice.aggregate([
        { $match: { businessId: bizOid, branchId: branchOid } },
        {
          $lookup: {
            from: 'jobs',
            let: { jid: '$jobId' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$_id', '$$jid'] },
                  directBill: { $ne: true },
                  status: 'DELIVERED',
                  $or: [
                    { actualDelivery: { $gte: startUtc, $lt: endUtc } },
                    { actualDelivery: { $exists: false }, updatedAt: { $gte: startUtc, $lt: endUtc } }
                  ]
                }
              },
              { $limit: 1 }
            ],
            as: 'job'
          }
        },
        { $match: { job: { $ne: [] } } },
        { $group: { _id: null, total: { $sum: '$finalAmount' } } }
      ]),
      Expense.aggregate([
        {
          $match: {
            businessId: bizOid,
            branchId: branchOid,
            expenseDate: { $gte: startUtc, $lt: endUtc }
          }
        },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      isBranchOperational(branch)
    ]);

    const sub = branch.isDefault
      ? null
      : await BranchSubscription.findOne({ branchId: branchOid }).lean();

    return {
      branchId: branch._id,
      name: branch.name,
      code: branch.code,
      isDefault: branch.isDefault,
      operational,
      subscriptionExpiry: sub?.expiryDate || null,
      todayJobs,
      inProgress,
      revenue: Math.round((revenueAgg[0]?.total ?? 0) * 100) / 100,
      expenses: Math.round((expenseAgg[0]?.total ?? 0) * 100) / 100
    };
  }));

  return rows;
}

export function getEffectiveMaxConcurrentJobs(business) {
  if (!business) return 1;
  if (business.carHandlingCapacity === 'SINGLE') return 1;
  return Math.max(1, Number(business.maxConcurrentJobs) || 1);
}

/** Keep business and all branches aligned on concurrent job limit. */
export async function syncMaxConcurrentJobsForBusiness(businessId, options = {}) {
  const business = options.business || await Business.findById(businessId);
  if (!business) return 1;
  const effective = getEffectiveMaxConcurrentJobs(business);
  if (business.maxConcurrentJobs !== effective) {
    business.maxConcurrentJobs = effective;
    await business.save();
  }
  await Branch.updateMany(
    { businessId: business._id },
    { $set: { maxConcurrentJobs: effective } }
  );
  return effective;
}

/** Update business-wide concurrent job limit and mirror to every branch. */
export async function applyMaxConcurrentJobsForBusiness(businessId, maxConcurrentJobs) {
  const business = await Business.findById(businessId);
  if (!business) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  const maxJobs = Math.max(1, Number(maxConcurrentJobs) || 1);
  if (maxJobs > 1) business.carHandlingCapacity = 'MULTIPLE';
  business.maxConcurrentJobs = business.carHandlingCapacity === 'SINGLE' ? 1 : maxJobs;
  await business.save();
  return syncMaxConcurrentJobsForBusiness(businessId, { business });
}

export async function isBranchOperational(branch) {
  if (!branch) return false;

  const modules = await getBusinessModules(branch.businessId);
  if (!isModuleEnabled(modules, 'branches')) return false;

  if (branch.status !== 'ACTIVE') return false;
  if (branch.isDefault) return true;

  const sub = await BranchSubscription.findOne({ branchId: branch._id }).lean();
  if (!sub) return false;

  const now = new Date();
  const expiry = sub.expiryDate ? new Date(sub.expiryDate) : null;
  const pastExpiry = expiry && expiry < now;

  if (pastExpiry) return false;
  if (sub.status === 'EXPIRED') return false;
  if (sub.status === 'ACTIVE') return true;
  if (sub.status === 'PENDING_RENEWAL' && !pastExpiry) return true;

  return false;
}

export { suggestBranchCode, normalizeBranchCode };
