/**
 * Create a job backdated to a specific day (for seeding / corrections).
 *
 * Usage:
 *   node scripts/add-backdated-job.js --dry-run
 *   node scripts/add-backdated-job.js --confirm --execute
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Job from '../models/Job.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import User from '../models/User.model.js';
function generateRandomString(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const BUSINESS_ID = '69d368f6edec92ab2e54ad64';
const JOB_DATE = '2026-05-22'; // YYYY-MM-DD (local business day → stored as UTC midday)

const PAYLOAD = {
  customerName: 'vashq-cust-2',
  phone: '9633066759',
  carNumber: 'KL07CA3054',
  carBrand: 'Vashq',
  carModel: 'Vashq',
  carNotes: 'Assigned employee: Sunil S',
  serviceName: 'Hatch Back Exterior Wash',
  employeeName: 'Sunil S',
  status: 'DELIVERED'
};

function parseArgs(argv) {
  const execute = argv.includes('--confirm') && argv.includes('--execute');
  return { dryRun: !execute };
}

function jobTimestampsForDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const createdAt = new Date(Date.UTC(y, m - 1, d, 5, 0, 0));
  const actualDelivery = new Date(Date.UTC(y, m - 1, d, 11, 30, 0));
  return { createdAt, actualDelivery, updatedAt: actualDelivery };
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

export async function addBackdatedJob({ dryRun = true } = {}) {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI or MONGODB_URI is required');

  const businessId = new mongoose.Types.ObjectId(BUSINESS_ID);
  await mongoose.connect(uri);

  try {
    let customer = await Customer.findOne({
      businessId,
      $or: [{ name: new RegExp(`^${PAYLOAD.customerName}$`, 'i') }, { phone: PAYLOAD.phone }]
    });
    let car = customer
      ? await Car.findOne({
          businessId,
          customerId: customer._id,
          carNumber: new RegExp(`^${PAYLOAD.carNumber}$`, 'i')
        })
      : null;

    const service = await Service.findOne({
      businessId,
      name: new RegExp(PAYLOAD.serviceName.replace(/\s+/g, '\\s+'), 'i'),
      isActive: { $ne: false }
    });
    const employee = await User.findOne({
      businessId,
      role: 'EMPLOYEE',
      name: new RegExp(PAYLOAD.employeeName, 'i')
    });

    if (!service) throw new Error(`Service not found: ${PAYLOAD.serviceName}`);
    if (!employee) throw new Error(`Employee not found: ${PAYLOAD.employeeName}`);

    const { createdAt, actualDelivery, updatedAt } = jobTimestampsForDate(JOB_DATE);
    const tokenNumber = await uniqueTokenForDate(businessId, JOB_DATE);
    const totalPrice = Number(service.price) || 0;

    const plan = {
      businessId: BUSINESS_ID,
      jobDate: JOB_DATE,
      tokenNumber,
      customer: customer
        ? { id: String(customer._id), name: customer.name, action: 'use existing' }
        : { action: 'create', name: PAYLOAD.customerName, phone: PAYLOAD.phone },
      car: car
        ? { id: String(car._id), carNumber: car.carNumber, action: 'use existing' }
        : {
            action: 'create',
            carNumber: PAYLOAD.carNumber,
            brand: PAYLOAD.carBrand,
            model: PAYLOAD.carModel,
            notes: PAYLOAD.carNotes
          },
      service: { id: String(service._id), name: service.name, price: service.price },
      employee: { id: String(employee._id), name: employee.name },
      status: PAYLOAD.status,
      createdAt: createdAt.toISOString(),
      actualDelivery: actualDelivery.toISOString(),
      totalPrice
    };

    console.log(JSON.stringify(plan, null, 2));

    if (dryRun) {
      console.log('\nDry run. Use --confirm --execute to create.');
      return { dryRun: true, plan };
    }

    if (!customer) {
      customer = await Customer.create({
        businessId,
        name: PAYLOAD.customerName,
        phone: PAYLOAD.phone,
        whatsappNumber: PAYLOAD.phone
      });
    }

    if (!car) {
      car = await Car.create({
        businessId,
        customerId: customer._id,
        carNumber: PAYLOAD.carNumber.toUpperCase(),
        brand: PAYLOAD.carBrand,
        model: PAYLOAD.carModel,
        notes: PAYLOAD.carNotes
      });
    }

    const job = await Job.create({
      businessId,
      customerId: customer._id,
      carId: car._id,
      tokenNumber,
      status: PAYLOAD.status,
      totalPrice,
      advancePayment: 0,
      advancePaymentMethod: 'CASH',
      assignedTo: employee._id,
      services: [{ serviceId: service._id, price: totalPrice }],
      statusHistory: [
        { status: 'RECEIVED', changedAt: createdAt },
        { status: 'WORK_STARTED', changedAt: new Date(createdAt.getTime() + 30 * 60 * 1000) },
        { status: 'COMPLETED', changedAt: new Date(createdAt.getTime() + 3 * 60 * 60 * 1000) },
        { status: 'DELIVERED', changedAt: actualDelivery, notes: 'Backdated entry' }
      ],
      actualDelivery,
      notes: PAYLOAD.carNotes,
      beforeImages: [],
      afterImages: []
    });

    await Job.collection.updateOne(
      { _id: job._id },
      { $set: { createdAt, updatedAt } }
    );

    console.log(`\nCreated job ${tokenNumber} (_id ${job._id})`);
    return { dryRun: false, plan, jobId: String(job._id) };
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  try {
    await addBackdatedJob({ dryRun });
    process.exit(0);
  } catch (e) {
    console.error('Failed:', e.message || e);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('add-backdated-job.js')) {
  main();
}
