/**
 * Repair a DELIVERED job that has no invoice.
 *
 * The admin UI marks a job DELIVERED and then creates the invoice in a *second*
 * request (Jobs.jsx / JobsDetail.jsx: PATCH /jobs/:id/status → POST /invoices).
 * If that second request never lands (network drop, tab closed, app backgrounded)
 * the job stays DELIVERED with no invoice and the sale goes unrecorded.
 *
 * This rebuilds the invoice with the same helper the API uses, settles it, and
 * backdates it to N minutes after the recorded delivery time so reports land on
 * the day the work actually happened.
 *
 *   node scripts/repair-missing-job-invoice.mjs --token 20260906-NNBA3W
 *   node scripts/repair-missing-job-invoice.mjs --token 20260906-NNBA3W --method ONLINE --online-mode UPI --apply
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const TOKEN = arg('--token');
const METHOD = String(arg('--method', 'ONLINE')).toUpperCase();
const ONLINE_MODE = String(arg('--online-mode', 'UPI')).toUpperCase();
const MINUTES_AFTER_DELIVERY = Number(arg('--minutes', 5));
const APPLY = process.argv.includes('--apply');

if (!TOKEN) throw new Error('--token is required');
if (!['CASH', 'ONLINE', 'SPLIT'].includes(METHOD)) throw new Error(`Bad --method ${METHOD}`);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 60000 });

  // Register every model the populate chain and invoice helper touch.
  await Promise.all([
    import('../models/Business.model.js'),
    import('../models/BusinessSettings.model.js'),
    import('../models/Branch.model.js'),
    import('../models/Customer.model.js'),
    import('../models/Car.model.js'),
    import('../models/Service.model.js'),
    import('../models/CustomerPackage.model.js')
  ]);
  const Job = (await import('../models/Job.model.js')).default;
  const Invoice = (await import('../models/Invoice.model.js')).default;
  const User = (await import('../models/User.model.js')).default;
  const { createInvoiceForJobRecord } = await import('../utils/directBillJob.js');
  const { roundMoney, balanceDue } = await import('../utils/invoicePayment.js');

  const job = await Job.findOne({ tokenNumber: TOKEN })
    .populate('customerId', 'name phone whatsappNumber email')
    .populate('carId', 'carNumber model make color brand')
    .populate({ path: 'services.serviceId', model: 'Service', select: 'name price isVariable' });
  if (!job) throw new Error(`Job not found: ${TOKEN}`);

  if (job.status !== 'DELIVERED') {
    throw new Error(`Job ${TOKEN} is ${job.status}, not DELIVERED — refusing to invoice`);
  }
  const existing = await Invoice.findOne({ jobId: job._id });
  if (existing) {
    console.log(`Invoice already exists: ${existing.invoiceNumber} (${existing.paymentStatus}) — nothing to do`);
    return;
  }

  const businessId = job.businessId;
  const owner = await User.findOne({ businessId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' })
    .select('_id email')
    .lean();
  if (!owner) throw new Error('No active business owner found for createdBy');

  const deliveredAt = job.actualDelivery ? new Date(job.actualDelivery) : null;
  if (!deliveredAt) throw new Error('Job has no actualDelivery timestamp');
  const invoiceAt = new Date(deliveredAt.getTime() + MINUTES_AFTER_DELIVERY * 60 * 1000);

  console.log('=== plan ===');
  console.log({
    token: TOKEN,
    jobId: String(job._id),
    businessId: String(businessId),
    branchId: String(job.branchId),
    owner: owner.email,
    customer: job.customerId?.name,
    vehicle: job.carId?.carNumber,
    services: (job.services || []).map((s) => `${s.serviceId?.name || '?'} x${s.quantity || 1} @${s.price}`),
    jobTotal: job.totalPrice,
    advancePayment: job.advancePayment || 0,
    deliveredAt: deliveredAt.toISOString(),
    invoiceAt: invoiceAt.toISOString(),
    paymentMethod: METHOD,
    onlinePaymentMode: METHOD === 'CASH' ? null : ONLINE_MODE
  });

  if (!APPLY) {
    console.log('\nDry run — pass --apply to write.');
    return;
  }

  // Same helper POST /admin/invoices uses: company snapshot, GST fields, numbering, line items.
  const invoice = await createInvoiceForJobRecord({
    job,
    businessId,
    userId: owner._id,
    customer: job.customerId,
    car: job.carId,
    catalogServices: (job.services || [])
      .map((s) => s.serviceId)
      .filter((s) => s && typeof s === 'object' && s.name)
  });

  const due = roundMoney(balanceDue(invoice.finalAmount, invoice.advancePayment));
  invoice.paymentMethod = METHOD;
  if (METHOD !== 'CASH') invoice.onlinePaymentMode = ONLINE_MODE;
  invoice.paymentCashAmount = METHOD === 'CASH' ? due : 0;
  invoice.paymentOnlineAmount = METHOD === 'CASH' ? 0 : due;
  invoice.paymentStatus = 'RECEIVED';
  invoice.paymentReceivedAt = invoiceAt;
  invoice.saleConfirmedAt = invoiceAt;
  invoice.settlementMode = 'FULL';
  invoice.outstandingAmount = 0;
  await invoice.save();

  // Timestamps drive the sales reports and dashboard, so pin them to the delivery day.
  await Invoice.collection.updateOne(
    { _id: invoice._id },
    { $set: { createdAt: invoiceAt, updatedAt: invoiceAt } }
  );

  // No-op unless the business uses Cash & Bank; posts the UPI leg when it does.
  try {
    const { syncMoneyBookFromInvoice } = await import('../utils/cashBankSync.js');
    const fresh = await Invoice.findById(invoice._id);
    await syncMoneyBookFromInvoice(fresh, { createdBy: owner._id, rebuildBalances: true });
  } catch (err) {
    console.warn('Cash & Bank sync skipped:', err?.message || err);
  }

  const saved = await Invoice.findById(invoice._id).lean();
  console.log('\n=== created ===');
  console.log({
    invoiceNumber: saved.invoiceNumber,
    invoiceId: String(saved._id),
    subtotal: saved.subtotal,
    gstAmount: saved.gstAmount,
    finalAmount: saved.finalAmount,
    paymentMethod: saved.paymentMethod,
    onlinePaymentMode: saved.onlinePaymentMode,
    paymentCashAmount: saved.paymentCashAmount,
    paymentOnlineAmount: saved.paymentOnlineAmount,
    paymentStatus: saved.paymentStatus,
    paymentReceivedAt: saved.paymentReceivedAt,
    createdAt: saved.createdAt,
    outstandingAmount: saved.outstandingAmount
  });
  console.log('\nJob left untouched — status and delivery time unchanged.');
}

main()
  .catch((err) => {
    console.error('Failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
