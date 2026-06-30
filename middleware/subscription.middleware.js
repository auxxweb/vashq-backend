import ShopSubscription from '../models/ShopSubscription.model.js';
import { cacheGetOrSet } from '../utils/cache.js';
import {
  SUBSCRIPTION_CACHE_TTL_MS,
  resolveSubscriptionStatus,
  invalidateSubscriptionCache
} from '../services/subscriptionService.js';

const ADMIN_ALLOW_WHEN_LOCKED = new Set([
  '/my-subscription',
  '/available-plans',
  '/branch-licenses',
  '/branch-renewal-request',
  '/branch-renewal-requests',
  '/upgrade-request',
  '/upgrade-requests'
]);

const BRANCHES_ALLOW_WHEN_LOCKED = new Set([
  '/config',
  '/requests/list'
]);

function defaultAllowWhenLocked(path) {
  if (ADMIN_ALLOW_WHEN_LOCKED.has(path)) return true;
  if (BRANCHES_ALLOW_WHEN_LOCKED.has(path)) return true;
  if (path.startsWith('/settlement-change-requests')) return true;
  if (/\/jobs\/[^/]+\/settlement-dates$/.test(path)) return true;
  if (/^\/[^/]+\/renewal-request$/.test(path)) return true;
  return false;
}

/**
 * Block business APIs when shop subscription is not ACTIVE.
 * Pass extraAllowPaths for router-specific exemptions.
 */
export function enforceActiveSubscription(options = {}) {
  const allowWhenLocked = options.allowWhenLocked || defaultAllowWhenLocked;

  return async (req, res, next) => {
    try {
      const p = req.path;
      if (allowWhenLocked(p)) return next();
      if (!req.businessId) return next();

      const businessId = req.businessId;
      const sub = await cacheGetOrSet(
        `sub:${businessId}`,
        SUBSCRIPTION_CACHE_TTL_MS,
        () => ShopSubscription.findOne({ shopId: businessId }).select('status expiryDate').lean()
      );

      let status = sub?.status;
      if (!sub) {
        const resolved = await resolveSubscriptionStatus(businessId);
        invalidateSubscriptionCache(businessId);
        status = resolved.status;
      } else {
        const now = new Date();
        if (sub.expiryDate && new Date(sub.expiryDate) < now && status === 'ACTIVE') {
          await ShopSubscription.updateOne({ shopId: businessId }, { status: 'EXPIRED' });
          invalidateSubscriptionCache(businessId);
          status = 'EXPIRED';
        }
      }

      if (status !== 'ACTIVE') {
        return res.status(402).json({
          success: false,
          code: 'SUBSCRIPTION_EXPIRED',
          message: 'Your subscription is not active. Open My Plan to request an upgrade.',
          subscriptionStatus: status || 'MISSING'
        });
      }
      next();
    } catch (e) {
      console.error('Subscription gate error:', e);
      return res.status(503).json({
        success: false,
        message: 'Subscription check temporarily unavailable. Please try again.'
      });
    }
  };
}
