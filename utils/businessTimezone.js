import BusinessSettings from '../models/BusinessSettings.model.js';
import { cacheGetOrSet, cacheDelete } from './cache.js';

const TZ_CACHE_TTL_MS = 5 * 60 * 1000;

/** Cached business timezone for dashboard/report date ranges. */
export async function getBusinessTimezone(businessId) {
  if (!businessId) return process.env.CRON_TZ || 'UTC';
  return cacheGetOrSet(`bizTz:${String(businessId)}`, TZ_CACHE_TTL_MS, async () => {
    const settings = await BusinessSettings.findOne({ businessId })
      .select('timezone')
      .lean();
    return settings?.timezone || process.env.CRON_TZ || 'UTC';
  });
}

export function invalidateBusinessTimezoneCache(businessId) {
  if (businessId) cacheDelete(`bizTz:${String(businessId)}`);
}
