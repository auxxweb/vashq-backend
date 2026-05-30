/**
 * Create a paid invoice for a job, backdated after estimated delivery.
 *
 * Usage:
 *   node scripts/create-invoice-for-job.js --token 20260522-TR43N8 --dry-run
 *   node scripts/create-invoice-for-job.js --token 20260522-TR43N8 --confirm --execute
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import User from '../models/User.model.js';
import { generateInvoiceNumber, generateShareToken } from '../models/Invoice.model.js';
import { balanceDue } from '../utils/invoicePayment.js';
import { calculateETA } from '../utils/job.utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DEFAULT_BUSINESS_ID = '69d368f6edec92ab2e54ad64';
const DEFAULT_TOKEN = '20260522-TR43N8';
const PAYMENT_METHOD = 'ONLINE';
/** Minutes after estimated delivery to record invoice / payment */
const MINUTES_AFTER_ETA = 15;

function parseArgs(argv) {
  const getValue = (name) => {
    const idx = argv.findIndex((a) => a === name);
    return idx === -1 ? undefined : argv[idx + 1];
  };
  const execute = argv.includes('--confirm') && argv.includes('--execute');
  return {
    businessId: getValue('--businessId') ?? DEFAULT_BUSINESS_ID,
    token: getValue('--token') ?? DEFAULT_TOKEN,
    dryRun: !execute
  };
}

function serviceMinutes(service) {
  return Number(service?.maxTime ?? service?.minTime ?? 60) || 60;
}

export async function createInvoiceForJob({ businessId, token, dryRun = true } = {}) {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI or MONGODB_URI is required');

  const businessObjectId = new mongoose.Types.ObjectId(businessId);
  await mongoose.connect(uri);

  try {
    const job = await Job.findOne({ businessId: businessObjectId, tokenNumber: token });
    if (!job) throw new Error(`Job not found: ${token}`);

    const existing = await Invoice.findOne({ businessId: businessObjectId, jobId: job._id });
    if (existing) {
      console.log('Invoice already exists:', existing.invoiceNumber);
      return { skipped: true, invoiceId: String(existing._id) };
    }

    const [customer, car, admin] = await Promise.all([
      Customer.findById(job.customerId).lean(),
      Car.findById(job.carId).lean(),
      User.findOne({ businessId: businessObjectId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' }).select('_id')
    ]);
    if (!admin) throw new Error('No active business admin found for createdBy');

    const serviceIds = (job.services || []).map((s) => s.serviceId).filter(Boolean);
    const servicesFound = await Service.find({ _id: { $in: serviceIds }, businessId: businessObjectId }).lean();
    const serviceMap = new Map(servicesFound.map((s) => [s._id.toString(), s]));

    const items = (job.services || []).map((s) => {
      const svc = serviceMap.get(String(s.serviceId));
      return {
        serviceName: svc?.name || 'Service',
        servicePrice: s.price ?? svc?.price ?? 0
      };
    });
    const subtotal = job.totalPrice ?? items.reduce((sum, i) => sum + i.servicePrice, 0);
    const advancePayment = Math.max(0, Number(job.advancePayment) || 0);
    const due = balanceDue(subtotal, advancePayment);

    const jobCreatedAt = job.createdAt ? new Date(job.createdAt) : new Date();
    let estimatedDelivery = job.estimatedDelivery ? new Date(job.estimatedDelivery) : null;
    if (!estimatedDelivery || Number.isNaN(estimatedDelivery.getTime())) {
      const etaServices = servicesFound.length ? servicesFound : [{ maxTime: 60 }];
      const totalMinutes = etaServices.reduce((sum, s) => sum + serviceMinutes(s), 0);
      estimatedDelivery = new Date(jobCreatedAt.getTime() + totalMinutes * 60 * 1000);
    }

    const invoiceAt = new Date(estimatedDelivery.getTime() + MINUTES_AFTER_ETA * 60 * 1000);

    let invoiceNumber = generateInvoiceNumber();
    while (await Invoice.findOne({ businessId: businessObjectId, invoiceNumber })) {
      invoiceNumber = generateInvoiceNumber();
    }

    const plan = {
      token,
      jobId: String(job._id),
      jobStatus: job.status,
      estimatedDelivery: estimatedDelivery.toISOString(),
      invoiceCreatedAt: invoiceAt.toISOString(),
      paymentReceivedAt: invoiceAt.toISOString(),
      invoiceNumber,
      paymentMethod: PAYMENT_METHOD,
      paymentStatus: 'RECEIVED',
      subtotal,
      advancePayment,
      balanceDue: due,
      paymentOnlineAmount: due,
      paymentCashAmount: 0
    };
    console.log(JSON.stringify(plan, null, 2));

    if (dryRun) {
      console.log('\nDry run. Use --confirm --execute to create.');
      return { dryRun: true, plan };
    }

    const invoice = await Invoice.create({
      jobId: job._id,
      businessId: businessObjectId,
      invoiceNumber,
      customerName: customer?.name ?? '',
      customerPhone: customer?.phone || customer?.whatsappNumber || '',
      vehicleNumber: car?.carNumber ?? '',
      items,
      discount: 0,
      subtotal,
      finalAmount: subtotal,
      advancePayment,
      paymentMethod: PAYMENT_METHOD,
      paymentCashAmount: 0,
      paymentOnlineAmount: due,
      paymentStatus: 'RECEIVED',
      paymentReceivedAt: invoiceAt,
      shareToken: generateShareToken(),
      createdBy: admin._id
    });

    await Invoice.collection.updateOne(
      { _id: invoice._id },
      { $set: { createdAt: invoiceAt, updatedAt: invoiceAt } }
    );

    if (!job.estimatedDelivery) {
      job.estimatedDelivery = estimatedDelivery;
    }
    if (job.status !== 'DELIVERED') {
      job.status = 'DELIVERED';
      if (!job.actualDelivery || job.actualDelivery < invoiceAt) {
        job.actualDelivery = new Date(invoiceAt.getTime() + 30 * 60 * 1000);
      }
    } else if (!job.actualDelivery || job.actualDelivery < invoiceAt) {
      job.actualDelivery = new Date(invoiceAt.getTime() + 30 * 60 * 1000);
    }
    await job.save();

    console.log(`\nInvoice ${invoiceNumber} created (id ${invoice._id})`);
    return { dryRun: false, plan, invoiceId: String(invoice._id) };
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    await createInvoiceForJob(opts);
    process.exit(0);
  } catch (e) {
    console.error('Failed:', e.message || e);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('create-invoice-for-job.js')) {
  main();
}
