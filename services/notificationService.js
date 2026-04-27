import User from '../models/User.model.js';
import PushNotificationLog from '../models/PushNotificationLog.model.js';
import Notification from '../models/Notification.model.js';
import { getFirebaseMessaging } from './firebaseAdmin.js';

function safeString(x) {
  if (x == null) return '';
  return String(x);
}

function inferRefId(data) {
  const bookingId = data?.bookingId ? safeString(data.bookingId) : '';
  const packageId = data?.packageId ? safeString(data.packageId) : '';
  if (bookingId) return `booking:${bookingId}`;
  if (packageId) return `package:${packageId}`;
  // For summaries, callers should pass data.refId (e.g. yyyy-mm-dd). Keep fallback.
  if (data?.refId) return safeString(data.refId);
  return '';
}

/**
 * sendPushNotification({
 *  businessOwnerId,
 *  title,
 *  body,
 *  data // must include { type, bookingId?, packageId? }
 * })
 *
 * Rules:
 * - Only BUSINESS USERS (CAR_WASH_ADMIN, EMPLOYEE) should receive push (no customers).
 * - Idempotent: logs (businessOwnerId+type+refId) and does not send duplicates.
 */
export async function sendPushNotification({ businessOwnerId, title, body, data = {} }) {
  const type = safeString(data?.type).trim();
  if (!businessOwnerId) throw new Error('businessOwnerId is required');
  if (!type) throw new Error('data.type is required');

  const owner = await User.findOne({ _id: businessOwnerId, role: { $in: ['CAR_WASH_ADMIN', 'EMPLOYEE'] } })
    .select('businessId fcmTokens status')
    .lean();
  if (!owner) return { ok: false, skipped: true, reason: 'OWNER_NOT_FOUND' };
  if (owner.status !== 'ACTIVE') return { ok: false, skipped: true, reason: 'OWNER_INACTIVE' };

  const tokens = Array.isArray(owner.fcmTokens)
    ? Array.from(new Set(owner.fcmTokens.filter(Boolean).map((t) => String(t).trim()).filter(Boolean)))
    : [];

  const refId = inferRefId(data);

  // Dedupe: if already logged, skip
  try {
    await PushNotificationLog.create({
      businessOwnerId,
      businessId: owner.businessId,
      type,
      refId,
      sentAt: new Date(),
    });
  } catch (e) {
    if (e?.code === 11000) {
      return { ok: false, skipped: true, reason: 'DUPLICATE' };
    }
    throw e;
  }

  // Also store as in-app notification (so Notifications page + count works even if push token missing)
  const inAppTypeMap = {
    job_received: 'JOB_RECEIVED',
    job_closed: 'JOB_CLOSED',
    package_purchased: 'PACKAGE_PURCHASED',
    visit_today: 'VISIT_TODAY',
    visit_scheduled: 'VISIT_TODAY',
    visit_completed: 'JOB_UPDATE',
    package_expiry: 'PACKAGE_EXPIRY',
    overdue_visit: 'OVERDUE_VISIT',
    subscription_expiry: 'SUBSCRIPTION_EXPIRY',
  };
  const inAppType = inAppTypeMap[type] || 'SYSTEM_ALERT';
  const link = safeString(data?.url || data?.link || '');
  const refKey = `${type}:${refId || ''}`;
  try {
    await Notification.updateOne(
      { businessId: owner.businessId, refKey },
      {
        $setOnInsert: {
          businessId: owner.businessId,
          userId: businessOwnerId,
          type: inAppType,
          title: `VASHQ · ${safeString(title)}`,
          message: safeString(body),
          link: link || undefined,
          isRead: false,
          refKey,
        }
      },
      { upsert: true }
    );
  } catch (e) {
    console.warn('In-app notification create failed:', e?.message || e);
  }

  if (!tokens.length) return { ok: false, skipped: true, reason: 'NO_TOKENS' };

  const messaging = getFirebaseMessaging();
  const payload = {
    notification: {
      title: `VASHQ · ${safeString(title)}`,
      body: safeString(body),
    },
    data: Object.entries({
      ...data,
      type,
      bookingId: data?.bookingId ? safeString(data.bookingId) : '',
      packageId: data?.packageId ? safeString(data.packageId) : '',
      url: link,
    }).reduce((acc, [k, v]) => {
      // FCM data values must be strings
      acc[k] = safeString(v);
      return acc;
    }, {}),
  };

  const res = await messaging.sendEachForMulticast({
    tokens,
    ...payload,
  });

  // Remove invalid tokens to keep list clean
  const invalidTokens = [];
  res.responses.forEach((r, idx) => {
    if (!r.success) {
      const code = r.error?.code || '';
      if (
        code.includes('registration-token-not-registered') ||
        code.includes('invalid-argument')
      ) {
        invalidTokens.push(tokens[idx]);
      }
    }
  });
  if (invalidTokens.length) {
    await User.updateOne(
      { _id: businessOwnerId },
      { $pull: { fcmTokens: { $in: invalidTokens } } }
    );
  }

  return {
    ok: true,
    successCount: res.successCount,
    failureCount: res.failureCount,
    invalidTokensRemoved: invalidTokens.length,
  };
}

