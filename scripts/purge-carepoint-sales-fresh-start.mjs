/**
 * Sales-only fresh start for Care Point (carepointtkr@gmail.com).
 *
 * Deletes through yesterday (createdAt / entryDate < start of today Asia/Kolkata):
 *   jobs, invoices, sold customer packages + visits, collections, credit events,
 *   settlement-change requests, sales money-ledger rows, sale/sale-reversal stock rows,
 *   cash day sessions.
 *
 * KEEP (never deleted): customers, cars, services/products, categories,
 *   package templates, expense types, expenses, purchases, suppliers,
 *   other revenue, money accounts, branches, users, settings, WhatsApp templates.
 *
 * After delete: restore product stockQuantity from remaining stock ledger,
 *   rebuild cash/bank running balances, reset job/invoice number sequences
 *   only if no jobs/invoices remain.
 *
 * Usage:
 *   node scripts/purge-carepoint-sales-fresh-start.mjs --dry-run
 *   node scripts/purge-carepoint-sales-fresh-start.mjs --confirm --execute
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';

import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';
import PaymentCollection from '../models/PaymentCollection.model.js';
import CreditLedgerEvent from '../models/CreditLedgerEvent.model.js';
import MoneyLedger from '../models/MoneyLedger.model.js';
import CashDaySession from '../models/CashDaySession.model.js';
import StockLedger from '../models/StockLedger.model.js';
import SettlementChangeRequest from '../models/SettlementChangeRequest.model.js';
import CustomerPackage from '../models/CustomerPackage.model.js';
import PackageVisit from '../models/PackageVisit.model.js';
import NumberSequence from '../models/NumberSequence.model.js';
import Service from '../models/Service.model.js';
import MoneyAccount from '../models/MoneyAccount.model.js';
import Business from '../models/Business.model.js';
import User from '../models/User.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DEFAULT_EMAIL = 'carepointtkr@gmail.com';
const DEFAULT_TZ = 'Asia/Kolkata';
const SALES_MONEY_TYPES = ['INVOICE', 'JOB_ADVANCE', 'COLLECTION'];
const SALES_STOCK_TYPES = ['SALE', 'SALE_REVERSAL'];

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

function parseArgs(argv) {
  const args = new Set(argv);
  const getValue = (name) => {
    const idx = argv.findIndex((a) => a === name);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  const dryRun =
    args.has('--dry-run') ||
    args.has('--dryrun') ||
    args.has('--preview') ||
    (!args.has('--execute') && !args.has('--confirm') && !args.has('--no-dry-run'));

  const confirmDelete =
    args.has('--confirm') || args.has('--yes') || args.has('--i-understand');

  return {
    email: getValue('--email') || DEFAULT_EMAIL,
    businessId: getValue('--businessId') || getValue('--business-id'),
    cutoffIso: getValue('--cutoff'),
    timezone: getValue('--tz') || DEFAULT_TZ,
    dryRun,
    confirmDelete
  };
}

function startOfTodayUtc(timezone) {
  return DateTime.now().setZone(timezone).startOf('day').toUTC().toJSDate();
}

async function resolveBusiness({ email, businessId }) {
  if (businessId) {
    if (!mongoose.isValidObjectId(businessId)) throw new Error(`Invalid businessId: ${businessId}`);
    const business = await Business.findById(businessId).lean();
    if (!business) throw new Error(`Business not found: ${businessId}`);
    return business;
  }

  const emailNorm = String(email).trim().toLowerCase();
  const owner = await User.findOne({ email: emailNorm }).select('email name role businessId').lean();
  if (owner?.businessId) {
    const business = await Business.findById(owner.businessId).lean();
    if (business) return business;
  }

  const byBizEmail = await Business.findOne({ email: emailNorm }).lean();
  if (byBizEmail) return byBizEmail;

  throw new Error(`No user/business found for email: ${email}`);
}

async function idsBefore(Model, businessId, cutoff, extra = {}) {
  const rows = await Model.find({ businessId, createdAt: { $lt: cutoff }, ...extra })
    .select('_id')
    .lean();
  return rows.map((r) => r._id);
}

async function rebuildMoneyAccounts(businessId) {
  const accounts = await MoneyAccount.find({ businessId }).lean();
  let accountsUpdated = 0;
  let rowsChanged = 0;

  for (const account of accounts) {
    const rows = await MoneyLedger.find({
      businessId: account.businessId,
      branchId: account.branchId,
      accountType: account.accountType
    })
      .sort({ entryDate: 1, createdAt: 1 })
      .select('_id signedAmount balanceAfter')
      .lean();

    let bal = 0;
    const ops = [];
    for (const row of rows) {
      bal = round(bal + (Number(row.signedAmount) || 0));
      if (round(row.balanceAfter) !== bal) {
        rowsChanged += 1;
        ops.push({
          updateOne: {
            filter: { _id: row._id },
            update: { $set: { balanceAfter: bal } }
          }
        });
      }
    }

    if (ops.length) {
      for (let i = 0; i < ops.length; i += 500) {
        await MoneyLedger.bulkWrite(ops.slice(i, i + 500));
      }
    }

    await MoneyAccount.updateOne({ _id: account._id }, { $set: { currentBalance: bal } });
    accountsUpdated += 1;
  }

  return { accountsUpdated, rowsChanged };
}

async function rebuildStock(businessId) {
  const ledgers = await StockLedger.find({ businessId })
    .sort({ createdAt: 1, _id: 1 })
    .select('_id serviceId qtyDelta valueDelta balanceQty balanceValue')
    .lean();

  const byService = new Map();
  for (const row of ledgers) {
    const key = String(row.serviceId);
    if (!byService.has(key)) byService.set(key, []);
    byService.get(key).push(row);
  }

  let rowsChanged = 0;
  let servicesUpdated = 0;
  const finalQty = new Map();

  for (const [serviceId, rows] of byService) {
    let qty = 0;
    let value = 0;
    const ops = [];
    for (const row of rows) {
      qty = round(qty + (Number(row.qtyDelta) || 0));
      value = round(value + (Number(row.valueDelta) || 0));
      if (qty < 0) qty = 0;
      if (value < 0) value = 0;
      if (round(row.balanceQty) !== qty || round(row.balanceValue) !== value) {
        rowsChanged += 1;
        ops.push({
          updateOne: {
            filter: { _id: row._id },
            update: { $set: { balanceQty: qty, balanceValue: value } }
          }
        });
      }
    }
    if (ops.length) {
      for (let i = 0; i < ops.length; i += 500) {
        await StockLedger.bulkWrite(ops.slice(i, i + 500));
      }
    }
    finalQty.set(serviceId, qty);
  }

  for (const [serviceId, qty] of finalQty) {
    const svc = await Service.findById(serviceId).select('trackInventory stockQuantity').lean();
    if (!svc) continue;
    if (svc.trackInventory && round(svc.stockQuantity ?? 0) !== qty) {
      await Service.updateOne({ _id: svc._id }, { $set: { stockQuantity: qty } });
      servicesUpdated += 1;
    }
  }

  return { rowsChanged, servicesUpdated, productsWithLedger: byService.size };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI required');

  await mongoose.connect(uri);

  try {
    const business = await resolveBusiness(opts);
    const businessId = business._id;
    const cutoff = opts.cutoffIso ? new Date(opts.cutoffIso) : startOfTodayUtc(opts.timezone);
    if (Number.isNaN(cutoff.valueOf())) throw new Error(`Invalid cutoff: ${opts.cutoffIso}`);

    const shouldDelete = opts.confirmDelete && !opts.dryRun;
    const todayKey = DateTime.fromJSDate(cutoff, { zone: 'utc' })
      .setZone(opts.timezone)
      .toFormat('yyyy-MM-dd');

    const jobIds = await idsBefore(Job, businessId, cutoff);
    const invoiceIds = await idsBefore(Invoice, businessId, cutoff);
    const packageIds = await idsBefore(CustomerPackage, businessId, cutoff);

    const extraInvoiceQuery = {
      businessId,
      _id: { $nin: invoiceIds }
    };
    const extraOr = [
      ...(jobIds.length ? [{ jobId: { $in: jobIds } }] : []),
      ...(packageIds.length ? [{ packageId: { $in: packageIds } }] : [])
    ];
    const extraInvoiceIds = extraOr.length
      ? await Invoice.find({ ...extraInvoiceQuery, $or: extraOr }).select('_id').lean()
      : [];
    const allInvoiceIds = [...invoiceIds, ...extraInvoiceIds.map((r) => r._id)];
    const allJobIds = jobIds;

    const collectionIds = (
      await PaymentCollection.find({
        businessId,
        $or: [
          { createdAt: { $lt: cutoff } },
          { collectionDate: { $lt: cutoff } },
          ...(allInvoiceIds.length ? [{ 'allocations.invoiceId': { $in: allInvoiceIds } }] : [])
        ]
      })
        .select('_id')
        .lean()
    ).map((r) => r._id);

    const visitFilter = {
      businessId,
      $or: [
        { createdAt: { $lt: cutoff } },
        ...(packageIds.length ? [{ customerPackageId: { $in: packageIds } }] : [])
      ]
    };

    const settlementFilter = {
      businessId,
      $or: [
        { createdAt: { $lt: cutoff } },
        ...(allJobIds.length ? [{ jobId: { $in: allJobIds } }] : []),
        ...(allInvoiceIds.length ? [{ invoiceId: { $in: allInvoiceIds } }] : [])
      ]
    };

    const creditFilter = {
      businessId,
      $or: [
        { createdAt: { $lt: cutoff } },
        ...(allInvoiceIds.length ? [{ invoiceId: { $in: allInvoiceIds } }] : []),
        ...(collectionIds.length ? [{ collectionId: { $in: collectionIds } }] : [])
      ]
    };

    const moneySourceIds = [...allInvoiceIds, ...allJobIds, ...collectionIds];
    const moneyFilter = {
      businessId,
      sourceType: { $in: SALES_MONEY_TYPES },
      $or: [
        { entryDate: { $lt: cutoff } },
        { createdAt: { $lt: cutoff } },
        ...(moneySourceIds.length ? [{ sourceId: { $in: moneySourceIds } }] : [])
      ]
    };

    const stockRefIds = [...allJobIds, ...allInvoiceIds];
    const stockFilter = {
      businessId,
      type: { $in: SALES_STOCK_TYPES },
      $or: [
        { createdAt: { $lt: cutoff } },
        ...(stockRefIds.length ? [{ refId: { $in: stockRefIds } }] : [])
      ]
    };

    const cashFilter = {
      businessId,
      $or: [
        { sessionDate: { $lt: cutoff } },
        { sessionDateKey: { $lt: todayKey } }
      ]
    };

    const counts = {
      jobs: allJobIds.length,
      invoices: allInvoiceIds.length,
      customerPackages: packageIds.length,
      packageVisits: await PackageVisit.countDocuments(visitFilter),
      paymentCollections: collectionIds.length,
      creditLedgerEvents: await CreditLedgerEvent.countDocuments(creditFilter),
      settlementChangeRequests: await SettlementChangeRequest.countDocuments(settlementFilter),
      moneyLedgersSales: await MoneyLedger.countDocuments(moneyFilter),
      stockLedgersSales: await StockLedger.countDocuments(stockFilter),
      cashDaySessions: await CashDaySession.countDocuments(cashFilter)
    };

    const kept = {
      customers: await mongoose.connection.db.collection('customers').countDocuments({ businessId }),
      cars: await mongoose.connection.db.collection('cars').countDocuments({ businessId }),
      services: await mongoose.connection.db.collection('services').countDocuments({ businessId }),
      serviceCategories: await mongoose.connection.db.collection('servicecategories').countDocuments({ businessId }),
      packageTemplates: await mongoose.connection.db.collection('packagetemplates').countDocuments({ businessId }),
      expenseTypes: await mongoose.connection.db.collection('expensetypes').countDocuments({ businessId }),
      expenses: await mongoose.connection.db.collection('expenses').countDocuments({ businessId }),
      purchases: await mongoose.connection.db.collection('purchases').countDocuments({ businessId }),
      users: await mongoose.connection.db.collection('users').countDocuments({ businessId }),
      branches: await mongoose.connection.db.collection('branches').countDocuments({ businessId }),
      jobsOnOrAfterCutoff: await Job.countDocuments({ businessId, createdAt: { $gte: cutoff } }),
      invoicesOnOrAfterCutoff: await Invoice.countDocuments({ businessId, createdAt: { $gte: cutoff } }),
      packagesOnOrAfterCutoff: await CustomerPackage.countDocuments({ businessId, createdAt: { $gte: cutoff } })
    };

    const owner = await User.findOne({ businessId, email: opts.email.toLowerCase() })
      .select('email name role')
      .lean();

    console.log('=== Care Point sales fresh-start (jobs / invoices / package sales) ===');
    console.log('Business:', business.businessName, String(businessId));
    console.log('Business email:', business.email || '—');
    console.log('Matched user:', owner ? `${owner.email} (${owner.role})` : 'email not on a user; used business record');
    console.log('Cutoff exclusive (keep from this instant):', cutoff.toISOString());
    console.log('Timezone:', opts.timezone, 'todayKey:', todayKey);
    console.log('Mode:', shouldDelete ? 'DELETE' : 'DRY_RUN');
    console.log('');
    console.log('Will delete:');
    let total = 0;
    for (const [key, n] of Object.entries(counts)) {
      console.log(`  ${key}: ${n}`);
      total += n;
    }
    console.log(`  TOTAL: ${total}`);
    console.log('\nKept (not deleted):');
    for (const [k, n] of Object.entries(kept)) console.log(`  ${k}: ${n}`);

    if (!shouldDelete) {
      console.log('\nNo deletions. Re-run with: --confirm --execute');
      return;
    }

    console.log('\nDeleting sales records…');

    const deleted = {};
    deleted.stockLedgersSales = (await StockLedger.deleteMany(stockFilter)).deletedCount ?? 0;
    deleted.moneyLedgersSales = (await MoneyLedger.deleteMany(moneyFilter)).deletedCount ?? 0;
    deleted.cashDaySessions = (await CashDaySession.deleteMany(cashFilter)).deletedCount ?? 0;
    deleted.settlementChangeRequests = (await SettlementChangeRequest.deleteMany(settlementFilter)).deletedCount ?? 0;
    deleted.creditLedgerEvents = (await CreditLedgerEvent.deleteMany(creditFilter)).deletedCount ?? 0;
    deleted.paymentCollections = (await PaymentCollection.deleteMany({
      businessId,
      _id: { $in: collectionIds }
    })).deletedCount ?? 0;
    deleted.packageVisits = (await PackageVisit.deleteMany(visitFilter)).deletedCount ?? 0;
    deleted.invoices = (await Invoice.deleteMany({
      businessId,
      _id: { $in: allInvoiceIds }
    })).deletedCount ?? 0;
    deleted.jobs = (await Job.deleteMany({
      businessId,
      _id: { $in: allJobIds }
    })).deletedCount ?? 0;
    deleted.customerPackages = (await CustomerPackage.deleteMany({
      businessId,
      _id: { $in: packageIds }
    })).deletedCount ?? 0;

    for (const [key, n] of Object.entries(deleted)) {
      if (n > 0) console.log(`  deleted ${key}: ${n}`);
    }

    const stockRebuild = await rebuildStock(businessId);
    console.log('  stock rebuild:', stockRebuild);

    const moneyRebuild = await rebuildMoneyAccounts(businessId);
    console.log('  money rebuild:', moneyRebuild);

    const remainingJobs = await Job.countDocuments({ businessId });
    const remainingInvoices = await Invoice.countDocuments({ businessId });
    if (remainingJobs === 0 && remainingInvoices === 0) {
      const seqRes = await NumberSequence.deleteMany({
        businessId,
        kind: { $in: ['JOB_TOKEN', 'INVOICE'] }
      });
      console.log(`  reset job/invoice sequences: ${seqRes.deletedCount ?? 0}`);
    } else {
      console.log(`  left sequences (remaining jobs=${remainingJobs}, invoices=${remainingInvoices})`);
    }

    console.log('\nDone. Catalog, customers, vehicles, expense types, and expenses were not touched.');
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Purge failed:', err);
  process.exit(1);
});
