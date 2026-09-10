/**
 * One-time / ops repair: clear stale outstandingAmount on fully paid (RECEIVED) invoices.
 *
 * Background: job invoices store outstandingAmount = balance due at create. Full-pay close
 * historically set paymentStatus=RECEIVED without zeroing outstandingAmount. Status filters
 * and the invoice list "Due" chip then misbehaved.
 *
 * Usage:
 *   node scripts/repair-stale-invoice-outstanding.mjs
 *   node scripts/repair-stale-invoice-outstanding.mjs --dry-run
 *   node scripts/repair-stale-invoice-outstanding.mjs --businessId=6a6dd6c7112577918bd2d15f
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bizArg = args.find((a) => a.startsWith('--businessId='));
const businessId = bizArg ? bizArg.split('=')[1] : null;

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI missing');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 60000 });
  const col = mongoose.connection.db.collection('invoices');

  const filter = {
    paymentStatus: 'RECEIVED',
    outstandingAmount: { $gt: 0.02 },
    ...(businessId ? { businessId: new mongoose.Types.ObjectId(businessId) } : {})
  };

  const count = await col.countDocuments(filter);
  console.log({ dryRun, businessId: businessId || 'ALL', matching: count });

  if (!dryRun && count > 0) {
    const res = await col.updateMany(filter, { $set: { outstandingAmount: 0 } });
    console.log({ matched: res.matchedCount, modified: res.modifiedCount });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
