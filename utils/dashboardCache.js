import { cacheGetOrSet, cacheDeletePrefix } from './cache.js';

const DASHBOARD_CACHE_PREFIX = 'dash:';
const CHARTS_CACHE_PREFIX = 'dashCharts:';

function ttlForRange(range) {
  const r = String(range || 'today').toLowerCase();
  if (r === 'today' || r === 'yesterday') return 30_000;
  if (r === 'week') return 60_000;
  return 120_000;
}

export function dashboardStatsCacheKey({
  businessId,
  branchScope,
  branchId,
  range,
  from,
  to,
  isEmployee,
  userId
}) {
  return `${DASHBOARD_CACHE_PREFIX}${businessId}:${branchScope || 'branch'}:${branchId || 'all'}:${range}:${from || ''}:${to || ''}:${isEmployee ? `e:${userId}` : 'a'}`;
}

export function dashboardChartsCacheKey({
  businessId,
  branchScope,
  branchId,
  range,
  from,
  to,
  isEmployee,
  userId
}) {
  return `${CHARTS_CACHE_PREFIX}${businessId}:${branchScope || 'branch'}:${branchId || 'all'}:${range}:${from || ''}:${to || ''}:${isEmployee ? `e:${userId}` : 'a'}`;
}

export async function getCachedDashboardStats(keyParts, loader) {
  const key = dashboardStatsCacheKey(keyParts);
  const ttl = ttlForRange(keyParts.range);
  return cacheGetOrSet(key, ttl, loader);
}

export async function getCachedDashboardCharts(keyParts, loader) {
  const key = dashboardChartsCacheKey(keyParts);
  const ttl = ttlForRange(keyParts.range);
  return cacheGetOrSet(key, ttl, loader);
}

export function invalidateDashboardCacheForBusiness(businessId) {
  if (!businessId) return;
  cacheDeletePrefix(`${DASHBOARD_CACHE_PREFIX}${businessId}:`);
  cacheDeletePrefix(`${CHARTS_CACHE_PREFIX}${businessId}:`);
}
