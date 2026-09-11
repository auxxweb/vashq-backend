/**
 * Delete one job by token, plus invoice and related sales records created from it.
 * Does not delete customers, vehicles, services, or package templates.
 *
 * Usage:
 *   node scripts/delete-job-by-token.mjs --token 20260911-7VGKH5 --dry-run
 *   node scripts/delete-job-by-token.mjs --token 20260911-7VGKH5 --confirm --execute
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';
import Customer from '../models/Customer.model.js';
import Service from '../models/Service.model.js';
import PaymentCollection from '../models/PaymentCollection.model.js';
import CreditLedgerEvent from '../models/CreditLedgerEvent.model.js';
import StockLedger from '../models/StockLedger.model.js';
import SettlementChangeRequest from '../models/SettlementChangeRequest.model.js';
import PackageVisit from '../models/PackageVisit.model.js';
import CustomerPackage from '../models/CustomerPackage.model.js';
import WhatsAppMessage from '../models/WhatsAppMessage.model.js';
import Notification from '../models/Notification.model.js';
import Booking from '../models/Booking.model.js';
import Estimate from '../models/Estimate.model.js';
import Lead from '../models/Lead.model.js';
import { reverseLedgerBySource } from '../services/moneyBookService.js';
import { computeLoyaltyEarnedForJobServices } from '../utils/directBillJob.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function parseArgs(argv) {
  const args = new Set(argv);
  const getValue = (name) => {
    const idx = argv.findIndex((a) => a === name);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };
  const execute = args.has('--execute') && (args.has('--confirm') || args.has('--yes'));
  return {
    token: getValue('--token'),
    email: getValue('--email'),
    businessId: getValue('--businessId') || getValue('--business-id'),
    dryRun: !execute
  };
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.token) throw new Error('--token is required');

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI required');
  await mongoose.connect(uri);

  try {
    const filter = { tokenNumber: opts.token };
    if (opts.businessId) filter.businessId = new mongoose.Types.ObjectId(opts.businessId);
    const jobs = await Job.find(filter).lean();
    if (!jobs.length) throw new Error(`Job not found: ${opts.token}`);
    if (jobs.length > 1 && !opts.businessId && !opts.email) {
      throw new Error(`Multiple jobs with token ${opts.token}. Pass --businessId.`);
    }

    let job = jobs[0];
    if (opts.email) {
      const User = (await import('../models/User.model.js')).default;
      const user = await User.findOne({ email: opts.email.trim().toLowerCase() }).select('businessId').lean();
      job = jobs.find((j) => String(j.businessId) === String(user?.businessId)) || job;
    }

    const businessId = job.businessId;
    const jobId = job._id;
    const invoice = await Invoice.findOne({ businessId, jobId }).lean();
    const invoiceId = invoice?._id || null;

    const collections = invoiceId
      ? await PaymentCollection.find({
          businessId,
          'allocations.invoiceId': invoiceId
        }).lean()
      : [];
    const collectionIds = collections.map((c) => c._id);

    const creditEvents = await CreditLedgerEvent.find({
      businessId,
      $or: [
        ...(invoiceId ? [{ invoiceId }] : []),
        ...(collectionIds.length ? [{ collectionId: { $in: collectionIds } }] : [])
      ]
    }).lean();

    const settlements = await SettlementChangeRequest.find({
      businessId,
      $or: [{ jobId }, ...(invoiceId ? [{ invoiceId }] : [])]
    }).lean();

    const visits = await PackageVisit.find({
      businessId,
      $or: [
        { bookingId: jobId },
        ...(job.customerPackageId ? [{ customerPackageId: job.customerPackageId, date: job.createdAt }] : [])
      ]
    }).lean();

    const stockRows = await StockLedger.find({
      businessId,
      type: { $in: ['SALE', 'SALE_REVERSAL'] },
      $or: [
        { refId: jobId },
        ...(invoiceId ? [{ refId: invoiceId }] : [])
      ]
    }).lean();

    const whatsapp = await WhatsAppMessage.countDocuments({ businessId, jobId });
    const notifications = await Notification.find({
      businessId,
      $or: [
        { refKey: { $regex: String(jobId) } },
        { message: { $regex: opts.token } },
        { title: { $regex: opts.token } },
        { link: { $regex: String(jobId) } }
      ]
    })
      .select('_id type title refKey')
      .lean();

    const bookings = await Booking.find({ businessId, jobId }).select('_id status').lean();
    const estimates = await Estimate.find({ convertedJobId: jobId }).select('_id').lean();
    const leads = await Lead.find({ convertedJobId: jobId }).select('_id').lean();

    const MoneyLedger = (await import('../models/MoneyLedger.model.js')).default;
    const moneyAdvance = await MoneyLedger.countDocuments({
      businessId,
      sourceType: 'JOB_ADVANCE',
      sourceId: jobId
    });
    const moneyInvoice = invoiceId
      ? await MoneyLedger.countDocuments({ businessId, sourceType: 'INVOICE', sourceId: invoiceId })
      : 0;
    const moneyCollections = collectionIds.length
      ? await MoneyLedger.countDocuments({
          businessId,
          sourceType: 'COLLECTION',
          sourceId: { $in: collectionIds }
        })
      : 0;

    console.log('=== Delete job by token ===');
    console.log('Token:', job.tokenNumber);
    console.log('Job id:', String(jobId));
    console.log('BusinessId:', String(businessId));
    console.log('Status:', job.status);
    console.log('CustomerId:', String(job.customerId || ''));
    console.log('Created:', job.createdAt);
    console.log('Mode:', opts.dryRun ? 'DRY_RUN' : 'DELETE');
    console.log({
      invoice: invoice
        ? { id: String(invoiceId), number: invoice.invoiceNumber, paymentStatus: invoice.paymentStatus }
        : null,
      collections: collections.map((c) => ({
        id: String(c._id),
        number: c.collectionNumber,
        amount: c.amount
      })),
      creditEvents: creditEvents.length,
      settlements: settlements.length,
      packageVisits: visits.length,
      stockRows: stockRows.length,
      whatsapp,
      notifications: notifications.length,
      bookingsToUnlink: bookings.length,
      estimatesToUnlink: estimates.length,
      leadsToUnlink: leads.length,
      moneyAdvance,
      moneyInvoice,
      moneyCollections
    });

    if (opts.dryRun) {
      console.log('\nNo deletions. Re-run with --confirm --execute');
      return;
    }

    if (invoice && job.customerId) {
      const customer = await Customer.findOne({ _id: job.customerId, businessId });
      if (customer) {
        let balance = Number(customer.loyaltyPointsBalance || 0);
        const redeemed = Math.max(0, Math.floor(Number(invoice.loyaltyRedeemedPoints) || 0));
        if (invoice.loyaltyRedeemAppliedAt && redeemed > 0) balance += redeemed;
        if (invoice.loyaltyEarnAppliedAt) {
          const earned = await computeLoyaltyEarnedForJobServices(businessId, job.services || []);
          if (earned > 0) balance = Math.max(0, balance - earned);
        }
        if (round(customer.loyaltyPointsBalance || 0) !== round(balance)) {
          customer.loyaltyPointsBalance = balance;
          await customer.save();
          console.log('Loyalty balance restored to', balance);
        }
      }
    }

    for (const visit of visits) {
      await PackageVisit.deleteOne({ _id: visit._id });
      if (visit.customerPackageId && visit.status === 'completed') {
        const pkg = await CustomerPackage.findOne({ _id: visit.customerPackageId, businessId });
        if (pkg) {
          pkg.visitsUsed = Math.max(0, Number(pkg.visitsUsed || 0) - 1);
          pkg.visitsRemaining = Number(pkg.visitsRemaining || 0) + 1;
          if (pkg.status === 'completed' && pkg.visitsRemaining > 0) pkg.status = 'active';
          await pkg.save();
          console.log('Package visit removed; counters restored');
        }
      }
    }

    const stockByService = new Map();
    for (const row of stockRows) {
      const key = String(row.serviceId);
      stockByService.set(key, round((stockByService.get(key) || 0) + (Number(row.qtyDelta) || 0)));
    }
    if (stockRows.length) {
      await StockLedger.deleteMany({ _id: { $in: stockRows.map((r) => r._id) } });
      for (const [serviceId, netDelta] of stockByService) {
        const restore = round(-netDelta);
        if (!restore) continue;
        await Service.updateOne(
          { _id: serviceId, businessId },
          { $inc: { stockQuantity: restore } }
        );
      }
      console.log('Stock sale rows removed; quantity restored');
    }

    await reverseLedgerBySource(businessId, 'JOB_ADVANCE', jobId, { skipEnabledCheck: true });
    if (invoiceId) {
      await reverseLedgerBySource(businessId, 'INVOICE', invoiceId, { skipEnabledCheck: true });
    }
    for (const cid of collectionIds) {
      await reverseLedgerBySource(businessId, 'COLLECTION', cid, { skipEnabledCheck: true });
    }

    if (creditEvents.length) {
      await CreditLedgerEvent.deleteMany({ _id: { $in: creditEvents.map((e) => e._id) } });
    }
    if (settlements.length) {
      await SettlementChangeRequest.deleteMany({ _id: { $in: settlements.map((s) => s._id) } });
    }
    if (collectionIds.length) {
      await PaymentCollection.deleteMany({ _id: { $in: collectionIds } });
    }
    if (invoiceId) {
      await Invoice.deleteOne({ _id: invoiceId });
      console.log('Invoice deleted');
    }

    await WhatsAppMessage.deleteMany({ businessId, jobId });
    if (notifications.length) {
      await Notification.deleteMany({ _id: { $in: notifications.map((n) => n._id) } });
    }

    if (bookings.length) {
      await Booking.updateMany({ _id: { $in: bookings.map((b) => b._id) } }, { $unset: { jobId: 1 } });
    }
    if (estimates.length) {
      await Estimate.updateMany(
        { _id: { $in: estimates.map((e) => e._id) } },
        { $unset: { convertedJobId: 1 } }
      );
    }
    if (leads.length) {
      await Lead.updateMany({ _id: { $in: leads.map((l) => l._id) } }, { $unset: { convertedJobId: 1 } });
    }

    await Job.deleteOne({ _id: jobId });
    console.log(`Job ${opts.token} deleted`);
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Delete failed:', err);
  process.exit(1);
});
