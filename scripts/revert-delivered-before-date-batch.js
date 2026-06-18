/**
 * Revert jobs that were created before a calendar day but incorrectly marked DELIVERED on that day.
 * Keeps a whitelist of tokens that should remain on sales reports for that date.
 *
 * Usage:
 *   node scripts/revert-delivered-before-date-batch.js --dry-run
 *   node scripts/revert-delivered-before-date-batch.js --confirm --execute
 *
 * Options:
 *   --businessId <id>     default: 69d368f6edec92ab2e54ad64
 *   --date YYYY-MM-DD     default: 2026-06-02
 *   --timezone <iana>     default: Asia/Kolkata
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';

import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';
import Customer from '../models/Customer.model.js';
import Service from '../models/Service.model.js';
import PackageVisit from '../models/PackageVisit.model.js';
import CustomerPackage from '../models/CustomerPackage.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DEFAULT_BUSINESS_ID = '69d368f6edec92ab2e54ad64';

/** Jobs that must stay DELIVERED on 02/06/2026 for sales reports */
const KEEP_TOKENS = new Set([
  '20260602-APVNTE',
  '20260602-CBURN6',
  '20260602-JAZHAZ',
  '20260602-XP5HEU',
  '20260602-Z89DTM',
  '20260602-HU9RUA',
  '20260602-GU4YHY',
  '20260602-Y7Y9NE',
  '20260602-M7EWHS',
  '20260602-SKFH4J',
  '20260602-9LXGEB',
  '20260602-466AWU',
  '20260602-6Q9P8J',
  '20260602-DD5GBR',
  '20260602-7SQ3KK',
  '20260602-TUXTYN',
  '20260602-4VJES3',
  '20260602-8QTQ7U',
  '20260602-2JD9QH',
  '20260602-99NKCJ',
  '20260602-24EMKR',
  '20260602-XNE37A',
  '20260602-698HRH',
  '20260602-7LTR67',
  '20260602-WD59R3',
  '20260602-FRRTEP',
  '20260602-MJJ3FF',
  '20260602-5RJVAE',
  '20260602-E9R3BA',
  '20260602-ZPSYV2',
  '20260602-H6327C',
  '20260602-3R7836'
]);

function parseArgs(argv) {
  const args = new Set(argv);
  const getValue = (name) => {
    const idx = argv.findIndex((a) => a === name);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };
  const execute = args.has('--execute') && args.has('--confirm');
  const dryRun = !execute;
  return {
    businessId: getValue('--businessId') ?? DEFAULT_BUSINESS_ID,
    date: getValue('--date') ?? '2026-06-02',
    timezone: getValue('--timezone') ?? 'Asia/Kolkata',
    dryRun,
    execute
  };
}

function dayBounds(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = DateTime.fromObject({ year: y, month: m, day: d }, { zone: timeZone }).startOf('day');
  if (!start.isValid) throw new Error(`Invalid date or timezone: ${dateStr} / ${timeZone}`);
  const endInclusive = start.endOf('day');
  return {
    dayStart: start.toJSDate(),
    dayEndInclusive: endInclusive.toJSDate(),
    dayEndExclusive: start.plus({ days: 1 }).toJSDate(),
    label: start.toFormat('dd/MM/yyyy')
  };
}

async function loyaltyEarnedForJob(businessId, job) {
  const serviceIds = Array.isArray(job.services)
    ? job.services.map((s) => s?.serviceId).filter(Boolean)
    : [];
  if (!serviceIds.length) return 0;
  const svc = await Service.find({ businessId, _id: { $in: serviceIds } })
    .select('loyaltyPointsEarned')
    .lean();
  return svc.reduce((sum, s) => sum + Math.max(0, Number(s.loyaltyPointsEarned || 0)), 0);
}

async function revertOneJob({ businessObjectId, job, session }) {
  const invoice = await Invoice.findOne({ businessId: businessObjectId, jobId: job._id }).session(session);
  const packageVisit = await PackageVisit.findOne({
    businessId: businessObjectId,
    bookingId: job._id,
    status: 'completed'
  }).session(session);

  const earnedIfClosed =
    invoice?.paymentStatus === 'RECEIVED' ? await loyaltyEarnedForJob(businessObjectId, job) : 0;
  const redeemedPoints = Number(invoice?.loyaltyRedeemedPoints || 0);

  if (invoice && job.customerId) {
    const customer = await Customer.findOne({
      _id: job.customerId,
      businessId: businessObjectId
    }).session(session);
    if (customer) {
      let balance = Number(customer.loyaltyPointsBalance || 0);
      if (redeemedPoints > 0) balance += redeemedPoints;
      if (earnedIfClosed > 0) balance = Math.max(0, balance - earnedIfClosed);
      customer.loyaltyPointsBalance = balance;
      await customer.save({ session });
    }
  }

  if (packageVisit && job.customerPackageId) {
    await PackageVisit.deleteOne({ _id: packageVisit._id }).session(session);
    const pkg = await CustomerPackage.findOne({
      _id: job.customerPackageId,
      businessId: businessObjectId
    }).session(session);
    if (pkg) {
      pkg.visitsUsed = Math.max(0, Number(pkg.visitsUsed || 0) - 1);
      pkg.visitsRemaining = Number(pkg.visitsRemaining || 0) + 1;
      if (pkg.status === 'completed' && pkg.visitsRemaining > 0) pkg.status = 'active';
      await pkg.save({ session });
    }
  }

  if (invoice) {
    await Invoice.deleteOne({ _id: invoice._id }).session(session);
  }

  const trimmedHistory = (job.statusHistory || []).filter(
    (h) => !['COMPLETED', 'DELIVERED'].includes(h.status)
  );
  const last = trimmedHistory[trimmedHistory.length - 1];
  if (!last || last.status !== 'WORK_STARTED') {
    trimmedHistory.push({
      status: 'WORK_STARTED',
      notes: 'Reverted: backdated delivery on wrong date removed',
      changedAt: new Date()
    });
  }

  job.status = 'WORK_STARTED';
  job.actualDelivery = undefined;
  job.afterImages = [];
  job.statusHistory = trimmedHistory;
  await job.save({ session });

  return {
    token: job.tokenNumber,
    invoiceNumber: invoice?.invoiceNumber ?? null,
    invoiceDeleted: Boolean(invoice)
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI or MONGODB_URI is required');
  if (!mongoose.isValidObjectId(opts.businessId)) throw new Error(`Invalid businessId: ${opts.businessId}`);

  const businessObjectId = new mongoose.Types.ObjectId(opts.businessId);
  const { dayStart, dayEndInclusive, dayEndExclusive, label } = dayBounds(opts.date, opts.timezone);

  await mongoose.connect(uri);

  try {
    const candidates = await Job.find({
      businessId: businessObjectId,
      status: 'DELIVERED',
      tokenNumber: { $nin: [...KEEP_TOKENS] },
      createdAt: { $lt: dayStart },
      $or: [
        { actualDelivery: { $gte: dayStart, $lte: dayEndInclusive } },
        { updatedAt: { $gte: dayStart, $lte: dayEndInclusive }, actualDelivery: { $exists: false } }
      ]
    })
      .select('tokenNumber createdAt actualDelivery status')
      .sort({ tokenNumber: 1 })
      .lean();

    const keepOnDay = await Job.find({
      businessId: businessObjectId,
      status: 'DELIVERED',
      tokenNumber: { $in: [...KEEP_TOKENS] },
      $or: [
        { actualDelivery: { $gte: dayStart, $lte: dayEndInclusive } },
        { actualDelivery: { $exists: false } }
      ]
    })
      .select('tokenNumber createdAt actualDelivery')
      .lean();

    console.log(`Business: ${opts.businessId}`);
    console.log(`Delivery date (${opts.timezone}): ${label}`);
    console.log(`Whitelist tokens: ${KEEP_TOKENS.size}`);
    console.log(`Jobs to revert (created before ${label}, delivered on ${label}): ${candidates.length}`);
    console.log(JSON.stringify(candidates.map((j) => ({
      token: j.tokenNumber,
      createdAt: j.createdAt,
      actualDelivery: j.actualDelivery
    })), null, 2));

    const missingKeep = [...KEEP_TOKENS].filter(
      (t) => !keepOnDay.some((j) => j.tokenNumber === t)
    );
    if (missingKeep.length) {
      console.warn(`\nWarning: ${missingKeep.length} whitelist token(s) not found as DELIVERED on this day:`);
      console.warn(missingKeep.join(', '));
    } else {
      console.log(`\nAll ${KEEP_TOKENS.size} whitelist jobs are DELIVERED (OK for sales report).`);
    }

    if (opts.dryRun) {
      console.log('\nDry run only. Re-run with --confirm --execute to apply.');
      return;
    }

    const results = [];
    for (const row of candidates) {
      const job = await Job.findById(row._id);
      if (!job) continue;
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const r = await revertOneJob({ businessObjectId, job, session });
        await session.commitTransaction();
        results.push(r);
        console.log(`Reverted ${r.token}${r.invoiceDeleted ? ` (invoice ${r.invoiceNumber} deleted)` : ''}`);
      } catch (err) {
        await session.abortTransaction();
        console.error(`Failed ${row.tokenNumber}:`, err.message || err);
      } finally {
        session.endSession();
      }
    }

    console.log(`\nDone. Reverted ${results.length} job(s).`);
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Batch revert failed:', err.message || err);
  process.exit(1);
});
