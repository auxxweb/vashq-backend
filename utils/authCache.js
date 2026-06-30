import { cacheDelete } from './cache.js';

export function invalidateUserAuthCache(userId) {
  if (userId) cacheDelete(`auth:user:${String(userId)}`);
}

export function invalidateBusinessAuthCache(businessId) {
  if (businessId) cacheDelete(`auth:business:${String(businessId)}`);
}
