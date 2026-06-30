import SubscriptionPlan from '../models/SubscriptionPlan.model.js';
import ShopSubscription from '../models/ShopSubscription.model.js';
import Business from '../models/Business.model.js';
import { cacheDelete } from '../utils/cache.js';

export const SUBSCRIPTION_CACHE_TTL_MS = 60_000;

export function invalidateSubscriptionCache(businessId) {
  if (businessId) cacheDelete(`sub:${String(businessId)}`);
}

export async function ensureDefaultSubscriptionPlan() {
  const count = await SubscriptionPlan.countDocuments();
  if (count > 0) return;
  await SubscriptionPlan.create({
    name: 'Free Tier',
    description: 'Default free plan for new shops',
    validityDays: 14,
    features: ['Basic access'],
    isActive: true,
    isFreeTrial: true
  });
}

export function isFreeTrialPlan(plan) {
  return plan?.isFreeTrial === true || (plan?.name && /free tier/i.test(plan.name));
}

/** Create default shop subscription if none exists (e.g. new business onboarding). */
export async function createDefaultShopSubscription(businessId) {
  await ensureDefaultSubscriptionPlan();
  const existing = await ShopSubscription.findOne({ shopId: businessId });
  if (existing) return existing;

  const business = await Business.findById(businessId).select('freeTrialUsed').lean();
  const skipFreeTrial = business?.freeTrialUsed === true;
  const defaultPlanQuery = { isActive: true };
  if (skipFreeTrial) defaultPlanQuery.isFreeTrial = { $ne: true };
  const defaultPlan = await SubscriptionPlan.findOne(defaultPlanQuery).sort({ validityDays: 1 });
  if (!defaultPlan) return null;

  const startDate = new Date();
  const expiryDate = new Date(startDate);
  expiryDate.setDate(expiryDate.getDate() + defaultPlan.validityDays);
  const sub = await ShopSubscription.create({
    shopId: businessId,
    planId: defaultPlan._id,
    startDate,
    expiryDate,
    status: 'ACTIVE'
  });
  invalidateSubscriptionCache(businessId);
  return sub;
}

/** Resolve effective subscription status; auto-creates default subscription when missing. */
export async function resolveSubscriptionStatus(businessId) {
  let sub = await ShopSubscription.findOne({ shopId: businessId }).select('status expiryDate').lean();
  if (!sub) {
    const created = await createDefaultShopSubscription(businessId);
    if (!created) return { status: 'MISSING', expiryDate: null };
    sub = created.toObject ? created.toObject() : created;
  }

  let status = sub.status;
  const now = new Date();
  if (sub.expiryDate && new Date(sub.expiryDate) < now && status === 'ACTIVE') {
    await ShopSubscription.updateOne({ shopId: businessId }, { status: 'EXPIRED' });
    invalidateSubscriptionCache(businessId);
    status = 'EXPIRED';
  }
  return { status, expiryDate: sub.expiryDate };
}
