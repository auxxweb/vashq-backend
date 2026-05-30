/**
 * Seed multiple backdated jobs + online invoices in one run.
 *
 *   node scripts/seed-batch-jobs-invoices.js --confirm --execute
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const BUSINESS_ID = '69d368f6edec92ab2e54ad64';
const JOB_DATE = '2026-05-22';
const PAYMENT_METHOD = 'ONLINE';
const MINUTES_AFTER_ETA = 15;

const BATCH = [
  {
    customerName: 'vashq-cust-3',
    phone: '9447074334',
    carNumber: 'KL07VQ3001',
    carBrand: 'Vq Care',
    carModel: 'Vq Helmet',
    carNotes: 'Vq customer · Muhammed Sherief',
    serviceName: 'HELMET DEEP CLEANING',
    employeeName: 'Muhammed Sherief'
  },
  {
    customerName: 'vashq-cust-4',
    phone: '9946480747',
    carNumber: 'KL07VQ4001',
    carBrand: 'Vq Care',
    carModel: 'Vq Helmet',
    carNotes: 'Vq customer · Muhammed Sherief',
    serviceName: 'HELMET DEEP CLEANING',
    employeeName: 'Muhammed Sherief'
  }
];

function generateRandomString(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function jobTimestampsForDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    createdAt: new Date(Date.UTC(y, m - 1, d, 5, 0, 0)),
    actualDelivery: new Date(Date.UTC(y, m - 1, d, 11, 30, 0))
  };
}

function serviceMinutes(service) {
  return Number(service?.maxTime ?? service?.minTime ?? 60) || 60;
}

async function uniqueTokenForDate(businessId, dateStr) {
  const prefix = dateStr.replace(/-/g, '');
  for (let i = 0; i < 15; i++) {
    const tokenNumber = `${prefix}-${generateRandomString(6)}`;
    const exists = await Job.findOne({ businessId, tokenNumber }).select('_id').lean();
    if (!exists) return tokenNumber;
  }
  throw new Error('Could not generate unique token');
}

async function seedOne({ businessId, adminId, entry, dryRun }) {
  const employee = await User.findOne({
    businessId,
    role: 'EMPLOYEE',
    name: new RegExp(entry.employeeName.replace(/\s+/g, '.*'), 'i')
  });
  const service = await Service.findOne({
    businessId,
    name: new RegExp(entry.serviceName.replace(/\s+/g, '\\s+'), 'i'),
    isActive: { $ne: false }
  });
  if (!employee) throw new Error(`Employee not found: ${entry.employeeName}`);
  if (!service) throw new Error(`Service not found: ${entry.serviceName}`);

  let customer = await Customer.findOne({
    businessId,
    $or: [
      { name: new RegExp(`^${entry.customerName}$`, 'i') },
      { phone: entry.phone }
    ]
  });
  let car =
    customer &&
    (await Car.findOne({
      businessId,
      customerId: customer._id,
      carNumber: new RegExp(`^${entry.carNumber}$`, 'i')
    }));

  const { createdAt, actualDelivery } = jobTimestampsForDate(JOB_DATE);
  const tokenNumber = await uniqueTokenForDate(businessId, JOB_DATE);
  const totalPrice = Number(service.price) || 0;
  const estimatedDelivery = new Date(
    createdAt.getTime() + serviceMinutes(service) * 60 * 1000
  );
  const invoiceAt = new Date(estimatedDelivery.getTime() + MINUTES_AFTER_ETA * 60 * 1000);
  const due = balanceDue(totalPrice, 0);

  const summary = {
    customer: entry.customerName,
    phone: entry.phone,
    car: entry.carNumber,
    token: tokenNumber,
    service: service.name,
    price: totalPrice,
    employee: employee.name,
    estimatedDelivery: estimatedDelivery.toISOString(),
    invoiceAt: invoiceAt.toISOString()
  };

  if (dryRun) return { dryRun: true, summary };

  if (!customer) {
    customer = await Customer.create({
      businessId,
      name: entry.customerName,
      phone: entry.phone,
      whatsappNumber: entry.phone,
      notes: 'Vq test customer'
    });
  }

  if (!car) {
    car = await Car.create({
      businessId,
      customerId: customer._id,
      carNumber: entry.carNumber.toUpperCase(),
      brand: entry.carBrand,
      model: entry.carModel,
      color: 'Vq White',
      notes: entry.carNotes
    });
  }

  const job = await Job.create({
    businessId,
    customerId: customer._id,
    carId: car._id,
    tokenNumber,
    status: 'DELIVERED',
    totalPrice,
    advancePayment: 0,
    advancePaymentMethod: 'CASH',
    estimatedDelivery,
    assignedTo: employee._id,
    services: [{ serviceId: service._id, price: totalPrice }],
    statusHistory: [
      { status: 'RECEIVED', changedAt: createdAt },
      { status: 'WORK_STARTED', changedAt: new Date(createdAt.getTime() + 30 * 60 * 1000) },
      { status: 'COMPLETED', changedAt: new Date(createdAt.getTime() + 2 * 60 * 60 * 1000) },
      { status: 'DELIVERED', changedAt: actualDelivery, notes: 'Vq backdated entry' }
    ],
    actualDelivery,
    notes: `Vq job · ${entry.carNotes}`,
    beforeImages: [],
    afterImages: []
  });
  await Job.collection.updateOne({ _id: job._id }, { $set: { createdAt, updatedAt: actualDelivery } });

  let invoiceNumber = generateInvoiceNumber();
  while (await Invoice.findOne({ businessId, invoiceNumber })) {
    invoiceNumber = generateInvoiceNumber();
  }

  const invoice = await Invoice.create({
    jobId: job._id,
    businessId,
    invoiceNumber,
    customerName: customer.name,
    customerPhone: customer.phone,
    vehicleNumber: car.carNumber,
    items: [{ serviceName: service.name, servicePrice: totalPrice }],
    discount: 0,
    subtotal: totalPrice,
    finalAmount: totalPrice,
    advancePayment: 0,
    paymentMethod: PAYMENT_METHOD,
    paymentCashAmount: 0,
    paymentOnlineAmount: due,
    paymentStatus: 'RECEIVED',
    paymentReceivedAt: invoiceAt,
    shareToken: generateShareToken(),
    createdBy: adminId
  });
  await Invoice.collection.updateOne(
    { _id: invoice._id },
    { $set: { createdAt: invoiceAt, updatedAt: invoiceAt } }
  );

  return {
    dryRun: false,
    summary: { ...summary, invoiceNumber, jobId: String(job._id), invoiceId: String(invoice._id) }
  };
}

async function main() {
  const dryRun = !(process.argv.includes('--confirm') && process.argv.includes('--execute'));
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI required');

  const businessId = new mongoose.Types.ObjectId(BUSINESS_ID);
  await mongoose.connect(uri);

  try {
    const admin = await User.findOne({
      businessId,
      role: 'CAR_WASH_ADMIN',
      status: 'ACTIVE'
    }).select('_id');
    if (!admin) throw new Error('No business admin found');

    const results = [];
    for (const entry of BATCH) {
      const r = await seedOne({ businessId, adminId: admin._id, entry, dryRun });
      results.push(r.summary);
      console.log(JSON.stringify(r.summary, null, 2));
    }

    if (dryRun) {
      console.log('\nDry run. Use --confirm --execute to create.');
    } else {
      console.log(`\nCreated ${results.length} jobs with online invoices.`);
    }
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
