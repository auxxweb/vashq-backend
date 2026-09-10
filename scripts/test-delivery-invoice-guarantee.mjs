/**
 * Checks the "delivered job always has an invoice" guarantee.
 *
 * 1. The ensure-invoice call the delivery path now makes is idempotent
 *    (running it twice must not create a second invoice).
 * 2. No DELIVERED job in the database is missing an invoice.
 *
 *   node scripts/test-delivery-invoice-guarantee.mjs
 *   node scripts/test-delivery-invoice-guarantee.mjs --token 20260906-NNBA3W
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const TOKEN = arg('--token', '20260906-NNBA3W');
let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 60000 });
  await Promise.all(
    ['Business', 'BusinessSettings', 'Branch', 'Customer', 'Car', 'Service', 'CustomerPackage', 'Invoice', 'Job', 'User']
      .map((m) => import(`../models/${m}.model.js`))
  );
  const Job = (await import('../models/Job.model.js')).default;
  const Invoice = (await import('../models/Invoice.model.js')).default;
  const { createInvoiceForJobRecord } = await import('../utils/directBillJob.js');

  // --- 1. idempotency of the ensure-invoice call ---
  const job = await Job.findOne({ tokenNumber: TOKEN })
    .populate('customerId', 'name phone whatsappNumber email')
    .populate('carId', 'carNumber model make color brand');
  if (!job) throw new Error(`Job not found: ${TOKEN}`);

  const before = await Invoice.countDocuments({ jobId: job._id });
  const args = {
    job,
    businessId: job.businessId,
    userId: job.assignedTo,
    customer: job.customerId,
    car: job.carId,
    catalogServices: []
  };
  const first = await createInvoiceForJobRecord(args);
  const second = await createInvoiceForJobRecord(args);
  const after = await Invoice.countDocuments({ jobId: job._id });

  check('ensure-invoice creates no duplicate', after === before, `${before} → ${after}`);
  check('ensure-invoice returns the same invoice', String(first._id) === String(second._id), first.invoiceNumber);
  check('existing payment state untouched', first.paymentStatus === 'RECEIVED', `${first.paymentStatus} ₹${first.finalAmount}`);

  // --- 2. no delivered job anywhere is missing an invoice ---
  const orphans = await Job.aggregate([
    { $match: { status: 'DELIVERED' } },
    { $lookup: { from: 'invoices', localField: '_id', foreignField: 'jobId', as: 'inv' } },
    { $match: { inv: { $size: 0 } } },
    { $group: { _id: '$businessId', count: { $sum: 1 }, tokens: { $push: '$tokenNumber' } } }
  ]);
  const total = orphans.reduce((sum, g) => sum + g.count, 0);
  check('no delivered job without an invoice', total === 0, total ? `${total} found` : 'all clean');
  for (const g of orphans) {
    const biz = await mongoose.connection.db.collection('businesses').findOne({ _id: g._id });
    console.log(`        ${biz?.businessName || g._id}: ${g.count} — ${g.tokens.slice(0, 8).join(', ')}${g.tokens.length > 8 ? ' …' : ''}`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((err) => {
    console.error('Error:', err.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
