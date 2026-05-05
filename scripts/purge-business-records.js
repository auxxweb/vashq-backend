import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';
import Expense from '../models/Expense.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure we load backend/.env even when invoked from repo root.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DEFAULT_BUSINESS_ID = '69d368f6edec92ab2e54ad64';
const DEFAULT_CUTOFF_ISO = '2026-04-28T00:00:00.000Z';

function parseArgs(argv) {
  const args = new Set(argv);
  const getValue = (name) => {
    const idx = argv.findIndex((a) => a === name);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  const businessId = getValue('--businessId') ?? getValue('--business-id') ?? DEFAULT_BUSINESS_ID;
  const cutoffIso = getValue('--cutoff') ?? DEFAULT_CUTOFF_ISO;

  const dryRun =
    args.has('--dry-run') ||
    args.has('--dryrun') ||
    args.has('--preview') ||
    (!args.has('--no-dry-run') && !args.has('--execute') && !args.has('--confirm'));

  const confirmDelete = args.has('--confirm') || args.has('--yes') || args.has('--i-understand');

  return { businessId, cutoffIso, dryRun, confirmDelete };
}

export async function purgeBusinessRecords({
  businessId,
  cutoffDate = new Date(DEFAULT_CUTOFF_ISO),
  dryRun = true,
  confirmDelete = false
} = {}) {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI (or MONGODB_URI) is required');

  if (!mongoose.isValidObjectId(businessId)) {
    throw new Error(`Invalid businessId: ${businessId}`);
  }

  const businessObjectId = new mongoose.Types.ObjectId(businessId);

  if (!(cutoffDate instanceof Date) || Number.isNaN(cutoffDate.valueOf())) {
    throw new Error(`Invalid cutoffDate: ${String(cutoffDate)}`);
  }

  const filter = {
    businessId: businessObjectId,
    createdAt: { $lt: cutoffDate }
  };

  const shouldDelete = confirmDelete && !dryRun;

  await mongoose.connect(uri);

  try {
    console.log('MongoDB connected');
    console.log('BusinessId:', businessId);
    console.log('Cutoff (exclusive):', cutoffDate.toISOString());
    console.log('Mode:', shouldDelete ? 'DELETE' : 'DRY_RUN');
    console.log('Filter:', JSON.stringify({ ...filter, businessId: businessId }));

    const [jobsToDelete, invoicesToDelete, expensesToDelete] = await Promise.all([
      Job.countDocuments(filter),
      Invoice.countDocuments(filter),
      Expense.countDocuments(filter)
    ]);

    console.log(`Jobs to delete: ${jobsToDelete}`);
    console.log(`Invoices to delete: ${invoicesToDelete}`);
    console.log(`Expenses to delete: ${expensesToDelete}`);

    if (!shouldDelete) {
      console.log('No deletions performed. Pass --confirm --execute (or --no-dry-run) to delete.');
      return {
        dryRun: true,
        deleted: { jobs: 0, invoices: 0, expenses: 0 },
        counts: { jobs: jobsToDelete, invoices: invoicesToDelete, expenses: expensesToDelete }
      };
    }

    const [jobsResult, invoicesResult, expensesResult] = await Promise.all([
      Job.deleteMany(filter),
      Invoice.deleteMany(filter),
      Expense.deleteMany(filter)
    ]);

    console.log(`Jobs deleted: ${jobsResult.deletedCount ?? 0}`);
    console.log(`Invoices deleted: ${invoicesResult.deletedCount ?? 0}`);
    console.log(`Expenses deleted: ${expensesResult.deletedCount ?? 0}`);

    return {
      dryRun: false,
      deleted: {
        jobs: jobsResult.deletedCount ?? 0,
        invoices: invoicesResult.deletedCount ?? 0,
        expenses: expensesResult.deletedCount ?? 0
      },
      counts: { jobs: jobsToDelete, invoices: invoicesToDelete, expenses: expensesToDelete }
    };
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

async function main() {
  const { businessId, cutoffIso, dryRun, confirmDelete } = parseArgs(process.argv.slice(2));
  const cutoffDate = new Date(cutoffIso);

  try {
    await purgeBusinessRecords({ businessId, cutoffDate, dryRun, confirmDelete });
    process.exit(0);
  } catch (err) {
    console.error('Purge failed:', err);
    process.exit(1);
  }
}

// Run when invoked directly: node scripts/purge-business-records.js ...
// (Path handling differs across Windows shells; keep this permissive.)
if (process.argv[1] && process.argv[1].toLowerCase().includes('purge-business-records.js')) {
  main();
}

