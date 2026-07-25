import Business from '../models/Business.model.js';
import Branch from '../models/Branch.model.js';
import BranchSubscription from '../models/BranchSubscription.model.js';
import Notification from '../models/Notification.model.js';
import ShopSubscription from '../models/ShopSubscription.model.js';
import SubscriptionPlan from '../models/SubscriptionPlan.model.js';
import PlanUpgradeRequest from '../models/PlanUpgradeRequest.model.js';
import PlatformSettings from '../models/PlatformSettings.model.js';
import { getBusinessModules } from './businessModulesService.js';
import { ensureDefaultBranchForBusiness, isBranchOperational } from './branchService.js';
import { ensureDefaultSubscriptionPlan, invalidateSubscriptionCache } from './subscriptionService.js';
import { isAdminPanelRole } from '../utils/adminRoles.js';

async function getPlatformDefaultCurrency() {
  const platform = await PlatformSettings.findOne({}).select('defaultCurrency').lean();
  return platform?.defaultCurrency || 'USD';
}

/** Subscription payload shared by /my-subscription and /bootstrap. */
export async function getMySubscriptionPayload(businessId) {
  await ensureDefaultSubscriptionPlan();
  let subscription = await ShopSubscription.findOne({ shopId: businessId })
    .populate('planId', 'name description validityDays features isActive isFreeTrial price');
  if (!subscription) {
    const business = await Business.findById(businessId).select('freeTrialUsed').lean();
    const skipFreeTrial = business?.freeTrialUsed === true;
    const defaultPlanQuery = { isActive: true };
    if (skipFreeTrial) defaultPlanQuery.isFreeTrial = { $ne: true };
    const defaultPlan = await SubscriptionPlan.findOne(defaultPlanQuery).sort({ validityDays: 1 });
    if (!defaultPlan) {
      return {
        subscription: null,
        canRequestUpgrade: false,
        freeTrialUsed: skipFreeTrial,
        currency: await getPlatformDefaultCurrency(),
        enabledModules: await getBusinessModules(businessId),
        message: skipFreeTrial ? 'No paid plans available. Contact admin.' : 'No plans available. Contact admin.'
      };
    }
    const startDate = new Date();
    const expiryDate = new Date(startDate);
    expiryDate.setDate(expiryDate.getDate() + defaultPlan.validityDays);
    subscription = await ShopSubscription.create({
      shopId: businessId,
      planId: defaultPlan._id,
      startDate,
      expiryDate,
      status: 'ACTIVE'
    });
    invalidateSubscriptionCache(businessId);
    await subscription.populate('planId', 'name description validityDays features isActive isFreeTrial price');
  }
  const subObj = subscription.toObject ? subscription.toObject() : subscription;
  if (subObj.expiryDate && new Date(subObj.expiryDate) < new Date() && subObj.status === 'ACTIVE') {
    await ShopSubscription.updateOne({ _id: subscription._id }, { status: 'EXPIRED' });
    invalidateSubscriptionCache(businessId);
    subObj.status = 'EXPIRED';
  }
  const business = await Business.findById(businessId).select('freeTrialUsed').lean();
  const freeTrialUsed = business?.freeTrialUsed === true;
  const hasPendingUpgrade = await PlanUpgradeRequest.exists({ shopId: businessId, status: 'PENDING' });
  const currency = await getPlatformDefaultCurrency();
  const enabledModules = await getBusinessModules(businessId);
  return {
    subscription: subObj,
    canRequestUpgrade: !hasPendingUpgrade,
    freeTrialUsed,
    currency,
    enabledModules
  };
}

async function listBranchesPayload(businessId) {
  await ensureDefaultBranchForBusiness(businessId);
  const branches = await Branch.find({ businessId })
    .sort({ isDefault: -1, name: 1 })
    .lean();
  const branchIds = branches.map((b) => b._id);
  const subs = await BranchSubscription.find({ branchId: { $in: branchIds } }).lean();
  const subByBranch = new Map(subs.map((s) => [String(s.branchId), s]));
  return Promise.all(branches.map(async (b) => ({
    ...b,
    subscription: b.isDefault ? null : (subByBranch.get(String(b._id)) || null),
    operational: await isBranchOperational(b)
  })));
}

/**
 * Single bootstrap payload for admin shell (modules, subscription, branches, unread count).
 */
export async function loadAdminBootstrap({ businessId, user }) {
  const BusinessSettings = (await import('../models/BusinessSettings.model.js')).default;
  const [subscriptionPayload, unreadCount, settings] = await Promise.all([
    getMySubscriptionPayload(businessId),
    Notification.countDocuments({ businessId, isRead: false }),
    BusinessSettings.findOne({ businessId }).select('crmEnabled mixedCartEnabled').lean()
  ]);

  let branches = null;
  if (isAdminPanelRole(user.role)) {
    branches = await listBranchesPayload(businessId);
  }

  return {
    businessId: String(businessId),
    ...subscriptionPayload,
    unreadCount,
    branches,
    crmEnabled: !!settings?.crmEnabled,
    mixedCartEnabled: !!settings?.mixedCartEnabled
  };
}
