import cron from 'node-cron';
import mongoose from 'mongoose';
import User from './models/User.model.js';
import Job from './models/Job.model.js';
import CustomerPackage from './models/CustomerPackage.model.js';
import PackageVisit from './models/PackageVisit.model.js';
import ShopSubscription from './models/ShopSubscription.model.js';
import { sendPushNotification } from './services/notificationService.js';

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function yyyyMmDd(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function runDailyOwnerNotifications() {
  if (mongoose.connection.readyState !== 1) return;
  const owners = await User.find({ role: 'CAR_WASH_ADMIN', status: 'ACTIVE' })
    .select('_id businessId')
    .lean();
  if (!owners.length) return;

  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = startOfDay(tomorrow);
  const tomorrowEnd = endOfDay(tomorrow);

  const in2days = new Date(now);
  in2days.setDate(in2days.getDate() + 2);
  const in2daysEnd = endOfDay(in2days);

  for (const o of owners) {
    const businessId = o.businessId;
    if (!businessId) continue;

    // 1) Today's visits summary (jobs received today + package scheduled today)
    const jobsToday = await Job.countDocuments({
      businessId,
      createdAt: { $gte: todayStart, $lte: todayEnd },
    });
    const packageVisitsToday = await PackageVisit.countDocuments({
      businessId,
      status: 'scheduled',
      date: { $gte: todayStart, $lte: todayEnd },
    });

    await sendPushNotification({
      businessOwnerId: o._id,
      title: `Today’s schedule`,
      body: `Jobs received: ${jobsToday}. Package visits scheduled: ${packageVisitsToday}.`,
      data: { type: 'visit_today', refId: yyyyMmDd(now) },
    });

    // 2) Overdue scheduled visits (scheduled date passed)
    const overdueScheduled = await PackageVisit.countDocuments({
      businessId,
      status: 'scheduled',
      date: { $lt: now },
    });
    if (overdueScheduled > 0) {
      await sendPushNotification({
        businessOwnerId: o._id,
        title: `Overdue package visits`,
        body: `${overdueScheduled} scheduled visit(s) are overdue.`,
        data: { type: 'overdue_visit', refId: `overdue:${yyyyMmDd(now)}` },
      });
    }

    // 3) Package expiry within 2 days (active + remaining)
    const expiringSoon = await CustomerPackage.countDocuments({
      businessId,
      status: 'active',
      visitsRemaining: { $gt: 0 },
      expiryDate: { $gte: todayStart, $lte: in2daysEnd },
    });
    if (expiringSoon > 0) {
      await sendPushNotification({
        businessOwnerId: o._id,
        title: `Packages expiring soon`,
        body: `${expiringSoon} package(s) expire within 2 days.`,
        data: { type: 'package_expiry', refId: `pkgexp:${yyyyMmDd(now)}` },
      });
    }

    // 4) Subscription expiry tomorrow
    const subExpiringTomorrow = await ShopSubscription.countDocuments({
      shopId: businessId,
      status: 'ACTIVE',
      expiryDate: { $gte: tomorrowStart, $lte: tomorrowEnd },
    });
    if (subExpiringTomorrow > 0) {
      await sendPushNotification({
        businessOwnerId: o._id,
        title: `Subscription expiring`,
        body: `Your subscription expires tomorrow.`,
        data: { type: 'subscription_expiry', refId: `subexp:${yyyyMmDd(tomorrow)}` },
      });
    }
  }
}

export function startCronJobs() {
  // DAILY 9 AM local business timezone (default Asia/Kolkata; override with CRON_TZ if needed)
  const tz = process.env.CRON_TZ || 'Asia/Kolkata';
  cron.schedule('0 9 * * *', () => {
    runDailyOwnerNotifications().catch((e) => console.error('Daily cron error:', e));
  }, { timezone: tz });
}

