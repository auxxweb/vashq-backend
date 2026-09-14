/**
 * Import Care Point's Jul–Sep 2026 daily sheet as paid, delivered wash jobs.
 *
 * GPay / empty / "NO PAYMENT MODE" / PENDING → ONLINE + UPI
 * Cash → CASH
 * Cash + GPay on one line → SPLIT with parsed amounts
 * Customer column digits are used as the customer name (and phone when valid)
 * Missing vehicle number → unique NIL-YYYYMMDD-ROW plate
 * Missing model / other vehicle fields → NIL
 *
 * Sales are real (paid invoices). Cash & Bank is left untouched when disabled.
 * Idempotent via notes tag. Re-running skips rows already imported.
 * Never deletes customers, vehicles, services, or package templates.
 *
 *   node scripts/import-carepoint-historical-jobs.mjs
 *   node scripts/import-carepoint-historical-jobs.mjs --apply
 *   node scripts/import-carepoint-historical-jobs.mjs --rollback --confirm
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

import Job from '../models/Job.model.js';
import Invoice, { generateInvoiceNumberForBusiness, generateShareToken } from '../models/Invoice.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import User from '../models/User.model.js';
import Branch from '../models/Branch.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import { canonicalPhoneDigits, phoneMatchVariants } from '../utils/customer.utils.js';
import { getInvoiceCompanySnapshot } from '../utils/invoiceCompany.js';
import { roundMoney } from '../utils/invoicePayment.js';
import { invalidateDashboardForBusiness } from '../utils/dashboardFinancialSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const EMAIL = 'carepointtkr@gmail.com';
const IMPORT_REF = 'CP-HIST-2026H2';
const IMPORT_TAG = `[${IMPORT_REF}]`;
const TZ = 'Asia/Kolkata';
const DATA_FILE = path.resolve(__dirname, 'data', 'carepoint-historical-jobs-2026.tsv');

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
};

const MISSING_PLATE_LABELS = new Set([
  '',
  'NEW',
  'NO VEHICLE NUMBER',
  'NO VEHICLE',
  'NO VEHICLE NO',
  "I DON'T UNDERSTAND",
  'I DON’T UNDERSTAND',
  'I DONT UNDERSTAND',
  'I DON’T UNDRSTAND',
  'I DONT UNDRSTAND',
  'NIL'
]);

const BIKE_LIKE = new Set([
  'BIKE', 'SCOOTY', 'SCOOTER', 'BULLET', 'WASH', 'ACTIVA',
  'BIKEE', 'BILLET', 'BIULLET', 'DOMOR', 'DUKE'
]);

function parseArgs(argv) {
  const args = new Set(argv);
  const getValue = (name) => {
    const idx = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (idx === -1) return undefined;
    if (argv[idx].includes('=')) return argv[idx].split('=').slice(1).join('=');
    return argv[idx + 1];
  };
  const apply = args.has('--apply') || (args.has('--confirm') && args.has('--execute'));
  const rollback = args.has('--rollback');
  return {
    apply,
    rollback,
    confirm: args.has('--confirm') || args.has('--yes'),
    email: getValue('--email') || EMAIL,
    file: getValue('--file') || DATA_FILE,
    limit: Number(getValue('--limit') || 0) || 0
  };
}

function generateRandomString(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSheetDate(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) throw new Error(`Bad date: ${raw}`);
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) throw new Error(`Bad month: ${raw}`);
  const iso = `${m[3]}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  const dt = DateTime.fromISO(iso, { zone: TZ });
  if (!dt.isValid) throw new Error(`Invalid date: ${raw}`);
  return iso;
}

function parseTsv(content) {
  const lines = String(content || '').split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    if (i === 0 && /^date\b/i.test(line)) continue;
    const cols = line.split('\t');
    while (cols.length < 8) cols.push('');
    const [dateRaw, snoRaw, customerRaw, plateRaw, vehicleRaw, serviceRaw, amountRaw, paymentRaw] = cols;
    rows.push({
      row: rows.length + 1,
      dateRaw: String(dateRaw || '').trim(),
      snoRaw: String(snoRaw || '').trim(),
      customerRaw: String(customerRaw || '').trim(),
      plateRaw: String(plateRaw || '').trim(),
      vehicleRaw: String(vehicleRaw || '').trim(),
      serviceRaw: String(serviceRaw || '').trim(),
      amountRaw: String(amountRaw || '').trim(),
      paymentRaw: String(paymentRaw || '').trim()
    });
  }
  return rows;
}

export function parsePayment(raw, amount) {
  const total = roundMoney(amount);
  const compact = String(raw || '').toUpperCase().replace(/\s+/g, '');
  if (!compact || compact === 'NOPAYMENTMODE' || compact === 'PENDING') {
    return {
      paymentMethod: 'ONLINE',
      onlinePaymentMode: 'UPI',
      paymentCashAmount: 0,
      paymentOnlineAmount: total,
      paymentStatus: 'RECEIVED',
      source: compact || 'EMPTY→UPI'
    };
  }

  const cashHits = [];
  const onlineHits = [];
  for (const m of compact.matchAll(/(\d+(?:\.\d+)?)(GPAY|UPI|CASH|CAS)/g)) {
    const n = Number(m[1]);
    if (m[2].startsWith('CAS')) cashHits.push(n);
    else onlineHits.push(n);
  }
  for (const m of compact.matchAll(/(GPAY|UPI|CASH|CAS)[-:]?\(?(\d+(?:\.\d+)?)\)?/g)) {
    const n = Number(m[2]);
    if (m[1].startsWith('CAS')) cashHits.push(n);
    else onlineHits.push(n);
  }

  const hasCash = /CASH|CAS-/.test(compact) || cashHits.length > 0;
  const hasOnline = /GPAY|UPI/.test(compact) || onlineHits.length > 0;
  const cash = roundMoney(cashHits[0] || 0);
  const online = roundMoney(onlineHits[0] || 0);

  if (hasCash && hasOnline) {
    let paymentCashAmount = cash;
    let paymentOnlineAmount = online;
    if (paymentCashAmount + paymentOnlineAmount <= 0.02) {
      return {
        paymentMethod: 'SPLIT',
        onlinePaymentMode: 'UPI',
        paymentCashAmount: roundMoney(total / 2),
        paymentOnlineAmount: roundMoney(total - roundMoney(total / 2)),
        paymentStatus: 'RECEIVED',
        source: compact,
        splitWarn: 'split labels without amounts; halved'
      };
    }
    if (Math.abs(paymentCashAmount + paymentOnlineAmount - total) > 0.02) {
      if (paymentCashAmount > 0 && paymentOnlineAmount <= 0.02) {
        paymentOnlineAmount = roundMoney(total - paymentCashAmount);
      } else if (paymentOnlineAmount > 0 && paymentCashAmount <= 0.02) {
        paymentCashAmount = roundMoney(total - paymentOnlineAmount);
      }
    }
    return {
      paymentMethod: 'SPLIT',
      onlinePaymentMode: 'UPI',
      paymentCashAmount,
      paymentOnlineAmount,
      paymentStatus: 'RECEIVED',
      source: compact
    };
  }

  if (hasCash) {
    return {
      paymentMethod: 'CASH',
      onlinePaymentMode: 'UPI',
      paymentCashAmount: total,
      paymentOnlineAmount: 0,
      paymentStatus: 'RECEIVED',
      source: compact
    };
  }

  return {
    paymentMethod: 'ONLINE',
    onlinePaymentMode: 'UPI',
    paymentCashAmount: 0,
    paymentOnlineAmount: total,
    paymentStatus: 'RECEIVED',
    source: compact || 'EMPTY→UPI'
  };
}

function classifyService(raw) {
  const label = String(raw || '').trim();
  const s = label.toUpperCase().replace(/\s+/g, ' ');
  if (!s) return { family: 'EXTRA', catalogName: 'Extra service', customName: 'NIL', label: 'NIL' };
  if (s === 'BODY' || s === 'ONLY BODY' || s === 'B') {
    return { family: 'BODY', catalogName: 'BASIC FOAM WASH', customName: '', label: s };
  }
  if (s === 'FULL') {
    return { family: 'FULL', catalogName: 'FULL BODY FOAM WASH', customName: '', label: s };
  }
  if (s.includes('QUCIK') || s.includes('QUICK')) {
    return { family: 'QUICK', catalogName: 'QUICK WASH', customName: '', label: s };
  }
  if (s === 'POLISH' || s === 'POLISHING') {
    return { family: 'POLISH', catalogName: 'POLISHING (Body Only)', customName: '', label: s };
  }
  if (s === 'DIESEL') {
    return { family: 'DIESEL', catalogName: 'DIESEL WASH', customName: '', label: s };
  }
  if (BIKE_LIKE.has(s)) {
    return { family: 'FOAM', catalogName: 'FOAM WASH', customName: '', label: s };
  }
  if ((s.includes('FULL') && s.includes('INTERIOR')) || s === 'WASHING+SEAT') {
    return { family: 'PREMIUM', catalogName: 'PREMIUM WASH', customName: label, label: s };
  }
  return { family: 'EXTRA', catalogName: 'Extra service', customName: label || 'NIL', label: s || 'NIL' };
}

function isValidIndianMobile(digits) {
  return /^\d{10}$/.test(digits) && /^[6-9]/.test(digits);
}

function resolvePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return { phone: null, issue: 'missing' };
  if (isValidIndianMobile(digits)) return { phone: `+91${digits}`, issue: null };
  if (digits.length === 12 && digits.startsWith('91') && isValidIndianMobile(digits.slice(2))) {
    return { phone: `+${digits}`, issue: null };
  }
  const last10 = digits.slice(-10);
  if (digits.length > 10 && isValidIndianMobile(last10)) {
    return { phone: `+91${last10}`, issue: `${digits.length} digits — used last 10` };
  }
  const first10 = digits.slice(0, 10);
  if (digits.length > 10 && isValidIndianMobile(first10)) {
    return { phone: `+91${first10}`, issue: `${digits.length} digits — used first 10` };
  }
  return { phone: null, issue: `unusable length (${digits.length} digits)` };
}

function looksLikePhoneName(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  const digits = t.replace(/\D/g, '');
  if (digits.length < 8) return false;
  return /^[+\d][\d\s-]*$/.test(t);
}

function parseCustomerFields(raw) {
  const t = String(raw || '').trim();
  if (!t || /^NO PHONE NUMBER$/i.test(t)) {
    return { name: 'Walk-in', phoneRaw: '', needsPlaceholder: true };
  }
  if (looksLikePhoneName(t)) {
    const digits = t.replace(/\D/g, '');
    return { name: digits || t, phoneRaw: t, needsPlaceholder: false };
  }
  return { name: t, phoneRaw: '', needsPlaceholder: true };
}

function normalizePlate(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

function isMissingPlate(raw) {
  const plate = normalizePlate(raw);
  if (MISSING_PLATE_LABELS.has(plate)) return true;
  const folded = plate.replace(/[’']/g, "'");
  return MISSING_PLATE_LABELS.has(folded);
}

function pickCatalogService(services, catalogName, amount) {
  const matches = services.filter((s) => String(s.name).toUpperCase() === String(catalogName).toUpperCase());
  if (!matches.length) return null;
  const exact = matches.find((s) => roundMoney(s.price) === roundMoney(amount));
  return exact || matches[0];
}

async function connect() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 60000 });
}

function jobTimes(isoDate, row) {
  const minutes = Math.min(8 * 60, Number(row.row) % 180);
  const created = DateTime.fromISO(isoDate, { zone: TZ }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).plus({ minutes });
  const delivered = created.plus({ hours: 2, minutes: 15 });
  return { createdAt: created.toJSDate(), actualDelivery: delivered.toJSDate() };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = parseTsv(fs.readFileSync(opts.file, 'utf8'));
  const selected = opts.limit ? rows.slice(0, opts.limit) : rows;
  if (!selected.length) throw new Error(`No rows in ${opts.file}`);

  await connect();
  const report = {
    importRef: IMPORT_REF,
    email: opts.email,
    dryRun: !opts.apply,
    rollback: opts.rollback,
    sheetRows: selected.length,
    skipped: [],
    followUps: [],
    created: { customers: 0, cars: 0, jobs: 0, invoices: 0 },
    totals: { sheetAmount: 0, cash: 0, online: 0, split: 0, extraService: 0 },
    byDay: {},
    errors: []
  };

  try {
    const owner = await User.findOne({ email: new RegExp(`^${escapeRegex(opts.email)}$`, 'i') }).lean();
    if (!owner?.businessId) throw new Error(`No user found for ${opts.email}`);
    const businessId = owner.businessId;
    const branch = await Branch.findOne({ businessId, isDefault: true, status: 'ACTIVE' }).lean();
    if (!branch) throw new Error('Default branch not found');
    const branchId = branch._id;
    const settings = await BusinessSettings.findOne({ businessId }).select('cashAndBankEnabled').lean();
    const services = await Service.find({ businessId, isActive: { $ne: false } }).select('name price isVariable skipWorkProcess').lean();
    const extra = services.find((s) => String(s.name).toLowerCase() === 'extra service');
    if (!extra) throw new Error('Extra service catalog item is missing');
    const company = await getInvoiceCompanySnapshot(businessId, { branchId });

    if (opts.rollback) {
      if (!opts.confirm) {
        const tagged = await Job.countDocuments({ businessId, notes: new RegExp(escapeRegex(IMPORT_TAG)) });
        console.log(JSON.stringify({ dryRun: true, wouldDeleteJobs: tagged }, null, 2));
        console.log('\nPass --rollback --confirm to delete imported jobs/invoices only.');
        return;
      }
      const jobs = await Job.find({ businessId, notes: new RegExp(escapeRegex(IMPORT_TAG)) }).select('_id').lean();
      const ids = jobs.map((j) => j._id);
      const inv = await Invoice.deleteMany({ businessId, jobId: { $in: ids } });
      const delJobs = await Job.deleteMany({ _id: { $in: ids } });
      invalidateDashboardForBusiness(businessId);
      console.log(JSON.stringify({ deletedJobs: delJobs.deletedCount, deletedInvoices: inv.deletedCount }, null, 2));
      return;
    }

    const [existingCustomers, existingCars, taggedJobs, existingJobTokens] = await Promise.all([
      Customer.find({ businessId }).select('name phone whatsappNumber branchId').lean(),
      Car.find({ businessId }).select('carNumber customerId customerIds placeholderPlate brand model').lean(),
      Job.find({ businessId, notes: new RegExp(escapeRegex(IMPORT_TAG)) }).select('notes tokenNumber').lean(),
      Job.find({ businessId, branchId }).select('tokenNumber').lean()
    ]);

    const importedRows = new Map();
    for (const job of taggedJobs) {
      const m = String(job.notes || '').match(/\[CP-HIST-2026H2\] row (\d+)\b/);
      if (m) importedRows.set(Number(m[1]), job.tokenNumber);
    }
    const existingTokens = new Set(existingJobTokens.map((j) => j.tokenNumber).filter(Boolean));

    const customerByPhone = new Map();
    const usedPhones = new Set();
    const indexCustomerPhones = (customer) => {
      for (const p of [customer.phone, customer.whatsappNumber].filter(Boolean)) {
        for (const variant of phoneMatchVariants(p)) {
          customerByPhone.set(variant, customer);
          usedPhones.add(variant);
        }
        const canon = canonicalPhoneDigits(p);
        if (canon) {
          customerByPhone.set(canon, customer);
          usedPhones.add(canon);
        }
      }
    };
    for (const customer of existingCustomers) indexCustomerPhones(customer);

    const carByPlate = new Map();
    for (const car of existingCars) {
      const key = normalizePlate(car.carNumber);
      if (key) carByPlate.set(key, car);
    }

    function findCustomerByPhoneLocal(phone) {
      for (const variant of phoneMatchVariants(phone)) {
        if (customerByPhone.has(variant)) return customerByPhone.get(variant);
      }
      const canon = canonicalPhoneDigits(phone);
      if (canon && customerByPhone.has(canon)) return customerByPhone.get(canon);
      return null;
    }

    function allocatePlaceholderPhone(rowNumber) {
      for (let n = 0; n < 80; n += 1) {
        const phone = `+91${8800000000 + rowNumber * 10 + n}`;
        if (findCustomerByPhoneLocal(phone)) continue;
        if (usedPhones.has(phone) || usedPhones.has(canonicalPhoneDigits(phone))) continue;
        usedPhones.add(phone);
        usedPhones.add(canonicalPhoneDigits(phone));
        return phone;
      }
      throw new Error(`Could not allocate placeholder phone for row ${rowNumber}`);
    }

    async function getCustomer(name, phone) {
      const existing = findCustomerByPhoneLocal(phone);
      if (existing) return existing;
      report.created.customers += 1;
      if (!opts.apply) {
        const stub = { _id: `NEW:${phone}`, name, phone };
        indexCustomerPhones(stub);
        return stub;
      }
      const customer = await Customer.create({
        businessId,
        branchId,
        name,
        phone,
        whatsappNumber: phone,
        notes: IMPORT_TAG
      });
      indexCustomerPhones(customer);
      return customer;
    }

    async function getCar({ plate, placeholderPlate, model, customerId, originalPlate }) {
      const key = normalizePlate(plate);
      if (!placeholderPlate && carByPlate.has(key)) {
        const existing = carByPlate.get(key);
        const cid = String(customerId);
        const ids = (existing.customerIds || []).map(String);
        if (opts.apply && !ids.includes(cid) && !String(existing._id).startsWith('NEW:')) {
          await Car.updateOne(
            { _id: existing._id },
            { $addToSet: { customerIds: customerId } }
          );
          existing.customerIds = [...(existing.customerIds || []), customerId];
        }
        return existing;
      }
      report.created.cars += 1;
      if (!opts.apply) {
        const stub = { _id: `NEW:${plate}`, carNumber: plate, placeholderPlate };
        carByPlate.set(key, stub);
        return stub;
      }
      const car = await Car.create({
        businessId,
        branchId,
        customerId,
        carNumber: plate,
        placeholderPlate,
        brand: 'NIL',
        model: model || 'NIL',
        notes: originalPlate && originalPlate !== plate
          ? `${IMPORT_TAG} sheet vehicle: ${originalPlate}`
          : IMPORT_TAG
      });
      carByPlate.set(key, car);
      return car;
    }

    async function nextToken(dateStr) {
      const prefix = dateStr.replace(/-/g, '');
      for (let i = 0; i < 40; i += 1) {
        const tokenNumber = `${prefix}-${generateRandomString(6)}`;
        if (existingTokens.has(tokenNumber)) continue;
        existingTokens.add(tokenNumber);
        return tokenNumber;
      }
      throw new Error(`Could not generate unique token for ${dateStr}`);
    }

    for (const row of selected) {
      try {
        const isoDate = parseSheetDate(row.dateRaw);
        const amount = roundMoney(row.amountRaw);
        if (!(amount >= 0)) throw new Error(`Bad amount: ${row.amountRaw}`);
        report.totals.sheetAmount = roundMoney(report.totals.sheetAmount + amount);

        const rowTag = `${IMPORT_TAG} row ${row.row}`;
        if (importedRows.has(row.row)) {
          report.skipped.push({ row: row.row, reason: `already imported as ${importedRows.get(row.row)}` });
          continue;
        }

        const classified = classifyService(row.serviceRaw);
        const catalog = classified.family === 'EXTRA'
          ? extra
          : pickCatalogService(services, classified.catalogName, amount) || extra;
        const customName = classified.family === 'EXTRA' || catalog === extra
          ? (classified.customName || row.serviceRaw || 'NIL')
          : classified.customName;
        if (catalog === extra || classified.family === 'EXTRA') report.totals.extraService += 1;

        const payment = parsePayment(row.paymentRaw, amount);
        if (payment.paymentMethod === 'CASH') report.totals.cash += 1;
        else if (payment.paymentMethod === 'SPLIT') report.totals.split += 1;
        else report.totals.online += 1;
        if (payment.splitWarn) {
          report.followUps.push(`row ${row.row}: ${payment.splitWarn} (${row.paymentRaw})`);
        }
        if (Math.abs((payment.paymentCashAmount + payment.paymentOnlineAmount) - amount) > 0.02) {
          report.followUps.push(
            `row ${row.row}: split ${payment.paymentCashAmount}+${payment.paymentOnlineAmount} != ${amount} (${row.paymentRaw})`
          );
        }

        const custFields = parseCustomerFields(row.customerRaw);
        let { phone, issue } = resolvePhone(custFields.phoneRaw);
        let usedPlaceholder = false;
        if (!phone || custFields.needsPlaceholder) {
          phone = allocatePlaceholderPhone(row.row);
          usedPlaceholder = true;
        } else {
          usedPhones.add(phone);
        }
        if (issue && !usedPlaceholder) {
          report.followUps.push(`row ${row.row}: phone "${row.customerRaw}" ${issue} → ${phone}`);
        }
        if (usedPlaceholder && row.customerRaw && looksLikePhoneName(row.customerRaw)) {
          report.followUps.push(`row ${row.row}: unusable phone "${row.customerRaw}" → placeholder ${phone}`);
        }

        const customerName = custFields.name === 'Walk-in'
          ? `Walk-in ${isoDate} #${row.snoRaw || row.row}`
          : custFields.name;
        const customer = await getCustomer(customerName, phone);
        const missingPlate = isMissingPlate(row.plateRaw);
        const plate = missingPlate
          ? `NIL-${isoDate.replace(/-/g, '')}-${String(row.row).padStart(4, '0')}`
          : normalizePlate(row.plateRaw);
        const model = row.vehicleRaw.trim() || 'NIL';
        const car = await getCar({
          plate,
          placeholderPlate: missingPlate,
          model,
          customerId: customer._id,
          originalPlate: row.plateRaw
        });

        if (opts.apply && row.row % 50 === 0) {
          console.error(`imported ${row.row}/${selected.length}`);
        }

        const { createdAt, actualDelivery } = jobTimes(isoDate, row);
        const tokenNumber = opts.apply
          ? await nextToken(isoDate)
          : `${isoDate.replace(/-/g, '')}-DRYRUN`;
        const lineName = customName || catalog.name;
        const notes = [
          rowTag,
          `sheet ${row.dateRaw} #${row.snoRaw || row.row}`,
          `service "${row.serviceRaw || 'NIL'}"`,
          `pay "${row.paymentRaw || 'UPI'}"`
        ].join(' | ');

        const day = report.byDay[isoDate] || { count: 0, amount: 0 };
        day.count += 1;
        day.amount = roundMoney(day.amount + amount);
        report.byDay[isoDate] = day;

        if (!opts.apply) {
          report.created.jobs += 1;
          report.created.invoices += 1;
          continue;
        }

        const job = await Job.create({
          businessId,
          branchId,
          customerId: customer._id,
          carId: car._id,
          tokenNumber,
          status: 'DELIVERED',
          totalPrice: amount,
          estimatedDelivery: actualDelivery,
          actualDelivery,
          createdBy: owner._id,
          notes,
          beforeImages: [],
          afterImages: [],
          services: [{
            serviceId: catalog._id,
            price: amount,
            customName: customName || '',
            quantity: 1
          }],
          statusHistory: [
            { status: 'RECEIVED', changedAt: createdAt },
            { status: 'WORK_STARTED', changedAt: new Date(createdAt.getTime() + 20 * 60 * 1000) },
            { status: 'COMPLETED', changedAt: new Date(createdAt.getTime() + 90 * 60 * 1000) },
            { status: 'DELIVERED', changedAt: actualDelivery, notes: 'Historical sheet import' }
          ]
        });
        await Job.collection.updateOne(
          { _id: job._id },
          { $set: { createdAt, updatedAt: actualDelivery } }
        );

        let invoiceNumber = await generateInvoiceNumberForBusiness(businessId);
        while (await Invoice.findOne({ businessId, invoiceNumber }).select('_id').lean()) {
          invoiceNumber = await generateInvoiceNumberForBusiness(businessId);
        }

        const invoice = await Invoice.create({
          saleType: 'JOB',
          jobId: job._id,
          businessId,
          branchId,
          invoiceNumber,
          companyName: company?.businessName || 'Care Point',
          companyOwnerName: company?.ownerName || null,
          companyAddress: company?.address || null,
          companyPhone: company?.phone || null,
          companyGst: null,
          customerId: customer._id,
          customerName: customer.name,
          customerPhone: customer.phone,
          vehicleNumber: car.carNumber,
          items: [{
            serviceId: catalog._id,
            serviceName: lineName,
            servicePrice: amount,
            quantity: 1
          }],
          discount: 0,
          discountType: 'PERCENT',
          discountAmount: 0,
          subtotal: amount,
          taxPercentage: 0,
          gstAmount: 0,
          finalAmount: amount,
          advancePayment: 0,
          paymentMethod: payment.paymentMethod,
          onlinePaymentMode: payment.onlinePaymentMode,
          paymentCashAmount: payment.paymentCashAmount,
          paymentOnlineAmount: payment.paymentOnlineAmount,
          paymentStatus: 'RECEIVED',
          paymentReceivedAt: actualDelivery,
          settlementMode: 'FULL',
          saleConfirmedAt: actualDelivery,
          outstandingAmount: 0,
          shareToken: generateShareToken(),
          createdBy: owner._id
        });
        await Invoice.collection.updateOne(
          { _id: invoice._id },
          { $set: { createdAt: actualDelivery, updatedAt: actualDelivery } }
        );

        report.created.jobs += 1;
        report.created.invoices += 1;
      } catch (err) {
        report.errors.push({ row: row.row, message: err.message || String(err) });
      }
    }

    if (opts.apply) invalidateDashboardForBusiness(businessId);
    report.cashAndBankEnabled = !!settings?.cashAndBankEnabled;
    report.businessId = String(businessId);
    report.branchId = String(branchId);

    const outPath = path.resolve(
      __dirname,
      'data',
      `carepoint-historical-jobs-import-${opts.apply ? 'apply' : 'dry-run'}.json`
    );
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      dryRun: !opts.apply,
      sheetRows: report.sheetRows,
      skipped: report.skipped.length,
      errors: report.errors.length,
      created: report.created,
      totals: report.totals,
      followUps: report.followUps.length,
      report: outPath
    }, null, 2));
    if (report.errors.length) {
      console.log('\nErrors:');
      for (const e of report.errors.slice(0, 20)) console.log(`  row ${e.row}: ${e.message}`);
    }
    if (!opts.apply) console.log('\nDry run. Pass --apply to create paid delivered jobs.');
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
