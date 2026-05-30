/**
 * Revert a job to WORK_STARTED: delete its invoice and undo completion side-effects.
 *
 * Usage:
 *   node scripts/revert-job-to-work-started.js --dry-run
 *   node scripts/revert-job-to-work-started.js --confirm --execute
 *
 * Options:
 *   --businessId <id>   (default: 69d368f6edec92ab2e54ad64)
 *   --token <token>     (default: 20260522-7FR2F5)
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const DEFAULT_TOKEN = '20260522-7FR2F5';

function parseArgs(argv) {
  const args = new Set(argv);
  const getValue = (name) => {
    const idx = argv.findIndex((a) => a === name);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };
  const dryRun =
    args.has('--dry-run') ||
    args.has('--preview') ||
    (!args.has('--execute') && !args.has('--confirm'));
  const execute = args.has('--execute') && args.has('--confirm');
  return {
    businessId: getValue('--businessId') ?? DEFAULT_BUSINESS_ID,
    token: getValue('--token') ?? DEFAULT_TOKEN,
    dryRun: dryRun && !execute,
    execute
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

export async function revertJobToWorkStarted({ businessId, token, dryRun = true } = {}) {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI or MONGODB_URI is required');
  if (!mongoose.isValidObjectId(businessId)) throw new Error(`Invalid businessId: ${businessId}`);

  const businessObjectId = new mongoose.Types.ObjectId(businessId);
  await mongoose.connect(uri);

  try {
    const job = await Job.findOne({ businessId: businessObjectId, tokenNumber: token });
    if (!job) {
      throw new Error(`Job not found for token ${token} under business ${businessId}`);
    }

    const invoice = await Invoice.findOne({ businessId: businessObjectId, jobId: job._id }).lean();
    const packageVisit = await PackageVisit.findOne({
      businessId: businessObjectId,
      bookingId: job._id,
      status: 'completed'
    }).lean();

    const earnedIfClosed =
      invoice?.paymentStatus === 'RECEIVED' ? await loyaltyEarnedForJob(businessObjectId, job) : 0;
    const redeemedPoints = Number(invoice?.loyaltyRedeemedPoints || 0);

    const plan = {
      jobId: String(job._id),
      token: job.tokenNumber,
      currentStatus: job.status,
      newStatus: 'WORK_STARTED',
      hasInvoice: Boolean(invoice),
      invoiceId: invoice?._id ? String(invoice._id) : null,
      invoiceNumber: invoice?.invoiceNumber ?? null,
      invoicePaymentStatus: invoice?.paymentStatus ?? null,
      loyaltyRedeemedPoints: redeemedPoints,
      loyaltyEarnedToReverse: earnedIfClosed,
      hasPackageVisit: Boolean(packageVisit),
      customerPackageId: job.customerPackageId ? String(job.customerPackageId) : null,
      statusHistoryBefore: (job.statusHistory || []).map((h) => h.status)
    };

    console.log(JSON.stringify(plan, null, 2));

    if (dryRun) {
      console.log('\nDry run only. Re-run with --confirm --execute to apply.');
      return { dryRun: true, plan };
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
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
          console.log(`Customer loyalty balance updated to ${balance}`);
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
          console.log('Package visit removed; package counters restored');
        }
      }

      if (invoice) {
        await Invoice.deleteOne({ _id: invoice._id }).session(session);
        console.log(`Invoice deleted: ${invoice.invoiceNumber}`);
      }

      const trimmedHistory = (job.statusHistory || []).filter(
        (h) => !['COMPLETED', 'DELIVERED'].includes(h.status)
      );
      const last = trimmedHistory[trimmedHistory.length - 1];
      if (!last || last.status !== 'WORK_STARTED') {
        trimmedHistory.push({
          status: 'WORK_STARTED',
          notes: 'Reverted from completed/delivered state',
          changedAt: new Date()
        });
      }

      job.status = 'WORK_STARTED';
      job.actualDelivery = undefined;
      job.afterImages = [];
      job.statusHistory = trimmedHistory;
      await job.save({ session });

      await session.commitTransaction();
      console.log(`Job ${token} set to WORK_STARTED`);
      return { dryRun: false, plan };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    await revertJobToWorkStarted({
      businessId: opts.businessId,
      token: opts.token,
      dryRun: !opts.execute
    });
    process.exit(0);
  } catch (err) {
    console.error('Revert failed:', err.message || err);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('revert-job-to-work-started.js')) {
  main();
}
