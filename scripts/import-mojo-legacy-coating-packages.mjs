/**
 * Import Mojo Autocafe's pre-software coating sales as customer packages,
 * purely so pending visits can be tracked.
 *
 * Money is deliberately untouched: every package invoice is created at zero and
 * marked paid, so sales totals, payments and the Cash & Bank ledger are unchanged.
 * Package invoices use their own LEGACY-COAT-### numbering so the live invoice
 * sequence is not consumed.
 *
 * Everything created is tagged with IMPORT_TAG, which makes the run both
 * idempotent (re-running skips rows already imported) and fully reversible.
 *
 *   node scripts/import-mojo-legacy-coating-packages.mjs            # dry run
 *   node scripts/import-mojo-legacy-coating-packages.mjs --apply
 *   node scripts/import-mojo-legacy-coating-packages.mjs --rollback
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import {
  parseSheetDate,
  parseTermYears,
  parseMaintenanceWork,
  buildVisitSchedule,
  normalizeIndianPhone
} from './mojo-legacy-coating-validate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const source = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'data', 'mojo-legacy-coating-packages.json'), 'utf8')
);

const IMPORT_REF = source.importRef;
const IMPORT_TAG = `[${IMPORT_REF}]`;
const INVOICE_PREFIX = 'LEGACY-COAT-';

/** Rows judged duplicates of an earlier row; see the import report for the reasoning. */
const SKIP_ROWS = new Map([
  [43, 'duplicate of row 40 (RAYEES, KL18AE9425, same dates) — kept the ₹28,000 row'],
  [55, 'duplicate of row 77 (JIJO, KL56W7425, one day apart) — kept the 3 YEAR row']
]);

/** Sheet typos corrected on import. */
const DATE_FIXES = new Map([
  [62, { expiryDate: '6/13/2030', reason: 'sheet said 6/13/1930; 5 YEAR from 6/13/2025' }]
]);

/** Sheet vehicle-category label -> service-category label used by the business. */
const VISIT_KINDS = ['service', 'recoat', 'maintenance'];

function titleCase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "Borophene Service" / "Graphene Recoat" / "Borophene Maintaince" (existing spelling kept). */
function visitServiceName(coating, kind) {
  const suffix = kind === 'maintenance' ? 'Maintaince' : titleCase(kind);
  return `${titleCase(coating)} ${suffix}`;
}

function packageName(row, years) {
  return `${row.coating} COATING - ${row.carCategory} - ${years} YEAR`;
}

function yearsBetween(start, end) {
  return (new Date(end) - new Date(start)) / (365.25 * 24 * 3600 * 1000);
}

function placeholderPhone(rowNumber) {
  return `+91${String(rowNumber).padStart(10, '0')}`;
}

async function connect() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 60000 });
}

async function loadModels() {
  const [Customer, Car, Service, PackageTemplate, CustomerPackage, PackageVisit, InvoiceModule, Branch, User] =
    await Promise.all([
      import('../models/Customer.model.js'),
      import('../models/Car.model.js'),
      import('../models/Service.model.js'),
      import('../models/PackageTemplate.model.js'),
      import('../models/CustomerPackage.model.js'),
      import('../models/PackageVisit.model.js'),
      import('../models/Invoice.model.js'),
      import('../models/Branch.model.js'),
      import('../models/User.model.js')
    ]);
  return {
    Customer: Customer.default,
    Car: Car.default,
    Service: Service.default,
    PackageTemplate: PackageTemplate.default,
    CustomerPackage: CustomerPackage.default,
    PackageVisit: PackageVisit.default,
    Invoice: InvoiceModule.default,
    generateShareToken: InvoiceModule.generateShareToken,
    Branch: Branch.default,
    User: User.default
  };
}

async function resolveContext(models) {
  const owner = await models.User.findOne({
    email: new RegExp(`^${source.businessEmail}$`, 'i')
  }).lean();
  if (!owner) throw new Error(`No user found for ${source.businessEmail}`);

  const branch = await models.Branch.findOne({
    businessId: owner.businessId,
    isDefault: true,
    status: 'ACTIVE'
  }).lean();
  if (!branch) throw new Error('No default active branch found');

  return { businessId: owner.businessId, branchId: branch._id, ownerId: owner._id };
}

/** Force createdAt/updatedAt to the historical sale date so current-period reports stay clean. */
async function backdate(Model, id, when) {
  await Model.collection.updateOne({ _id: id }, { $set: { createdAt: when, updatedAt: when } });
}

// ==================== Rollback ====================

async function rollback(models, ctx) {
  const { businessId } = ctx;
  const tag = new RegExp(IMPORT_TAG.replace(/[[\]]/g, '\\$&'));

  const packages = await models.CustomerPackage.find({ businessId, description: tag }).select('_id').lean();
  const packageIds = packages.map((p) => p._id);

  const results = {
    packageVisits: (await models.PackageVisit.deleteMany({ businessId, customerPackageId: { $in: packageIds } })).deletedCount,
    invoices: (await models.Invoice.deleteMany({ businessId, invoiceNumber: new RegExp(`^${INVOICE_PREFIX}`) })).deletedCount,
    customerPackages: (await models.CustomerPackage.deleteMany({ businessId, description: tag })).deletedCount,
    packageTemplates: (await models.PackageTemplate.deleteMany({ businessId, description: tag })).deletedCount,
    cars: (await models.Car.deleteMany({ businessId, notes: tag })).deletedCount,
    customers: (await models.Customer.deleteMany({ businessId, notes: tag })).deletedCount,
    services: (await models.Service.deleteMany({ businessId, description: tag })).deletedCount
  };
  console.log('Rollback complete:', results);
  return results;
}

// ==================== Import ====================

async function run({ apply }) {
  const models = await loadModels();
  const ctx = await resolveContext(models);
  const { businessId, branchId, ownerId } = ctx;

  const serviceCache = new Map();
  const templateCache = new Map();
  const report = { importRef: IMPORT_REF, ranAt: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', businessId: String(businessId), branchId: String(branchId), skipped: [], rows: [], created: { customers: 0, cars: 0, services: 0, templates: 0, packages: 0, visits: 0, invoices: 0 }, followUps: [] };

  /** Look up (or create) the ₹0 visit-type service for a coating + visit kind. */
  async function getVisitService(coating, kind) {
    const name = visitServiceName(coating, kind);
    if (serviceCache.has(name)) return serviceCache.get(name);

    let service = await models.Service.findOne({ businessId, name }).lean();
    if (!service && apply) {
      service = (
        await models.Service.create({
          businessId,
          branchId: null,
          name,
          price: 0,
          isVariable: true,
          isActive: true,
          showOnBookingForm: false,
          description: IMPORT_TAG
        })
      ).toObject();
      report.created.services += 1;
    } else if (!service) {
      service = { _id: `NEW:${name}`, name, created: true };
      report.created.services += 1;
    }
    serviceCache.set(name, service);
    return service;
  }

  async function getTemplate(row, years, servicesIncluded, price) {
    const name = packageName(row, years);
    if (templateCache.has(name)) return templateCache.get(name);

    let template = await models.PackageTemplate.findOne({ businessId, name, description: IMPORT_TAG }).lean();
    if (!template && apply) {
      template = (
        await models.PackageTemplate.create({
          businessId,
          name,
          price,
          totalVisits: Math.max(1, servicesIncluded.reduce((sum, s) => sum + s.quantity, 0)),
          validityValue: years,
          validityUnit: 'years',
          validityDays: Math.round(years * 365.25),
          servicesIncluded,
          description: IMPORT_TAG,
          // Kept disabled so these historical templates never show in the sell-a-package list.
          isActive: false
        })
      ).toObject();
      report.created.templates += 1;
    } else if (!template) {
      template = { _id: `NEW:${name}`, name, created: true };
      report.created.templates += 1;
    }
    templateCache.set(name, template);
    return template;
  }

  const dryRunCustomers = new Map();

  async function getCustomer(row, phone, usedPlaceholder) {
    const { findCustomerByPhone } = await import('../utils/customer.utils.js');
    const existing = await findCustomerByPhone(businessId, phone, branchId);
    if (existing) return { customer: existing, created: false };

    const name = row.ownerName || row.vehicleNo || `Legacy row ${row.row}`;
    if (!apply) {
      // Two rows can share one phone (same owner, two cars) — count the customer once.
      if (dryRunCustomers.has(phone)) return { customer: dryRunCustomers.get(phone), created: false };
      const stub = { _id: `NEW:${phone}`, name, phone };
      dryRunCustomers.set(phone, stub);
      report.created.customers += 1;
      return { customer: stub, created: true };
    }
    const customer = await models.Customer.create({
      businessId,
      branchId,
      name,
      phone,
      whatsappNumber: phone,
      notes: IMPORT_TAG
    });
    report.created.customers += 1;
    if (usedPlaceholder) {
      report.followUps.push(`row ${row.row} (${name}): placeholder phone ${phone} — sheet had no number, please correct`);
    }
    return { customer, created: true };
  }

  async function getCar(row, customerId) {
    if (!row.vehicleNo) return null;
    const carNumber = row.vehicleNo.toUpperCase().replace(/\s/g, '');
    const existing = await models.Car.findOne({ businessId, carNumber }).lean();
    if (existing) return existing;
    if (!apply) {
      report.created.cars += 1;
      return { _id: `NEW:${carNumber}`, carNumber };
    }
    const car = await models.Car.create({
      businessId,
      branchId,
      customerId,
      carNumber,
      model: row.car,
      vehicleType: row.carCategory,
      notes: IMPORT_TAG
    });
    report.created.cars += 1;
    return car;
  }

  let invoiceSeq = 0;
  const lastInvoice = await models.Invoice.findOne({ businessId, invoiceNumber: new RegExp(`^${INVOICE_PREFIX}`) })
    .sort({ invoiceNumber: -1 })
    .select('invoiceNumber')
    .lean();
  if (lastInvoice) invoiceSeq = Number(String(lastInvoice.invoiceNumber).replace(INVOICE_PREFIX, '')) || 0;

  for (const row of source.rows) {
    if (SKIP_ROWS.has(row.row)) {
      report.skipped.push({ row: row.row, reason: SKIP_ROWS.get(row.row) });
      continue;
    }

    const rowTag = `${IMPORT_TAG} row ${row.row}`;
    const alreadyImported = await models.CustomerPackage.findOne({
      businessId,
      description: new RegExp(`${IMPORT_TAG.replace(/[[\]]/g, '\\$&')} row ${row.row}\\b`)
    })
      .select('_id')
      .lean();
    if (alreadyImported) {
      report.skipped.push({ row: row.row, reason: `already imported as package ${alreadyImported._id}` });
      continue;
    }

    const fix = DATE_FIXES.get(row.row);
    const startDate = parseSheetDate(row.issueDate);
    const expiryDate = parseSheetDate(fix?.expiryDate || row.expiryDate);
    if (fix) report.followUps.push(`row ${row.row}: expiry corrected to ${fix.expiryDate} (${fix.reason})`);

    const sheetYears = parseTermYears(row.term);
    const actualYears = yearsBetween(startDate, expiryDate);
    const validityValue = Math.max(0.01, Math.round(actualYears * 100) / 100);
    if (sheetYears && Math.abs(actualYears - sheetYears) > 0.2) {
      report.followUps.push(
        `row ${row.row} (${row.ownerName || row.vehicleNo}): sheet says ${sheetYears} YEAR but ${row.issueDate} → ${row.expiryDate} spans ${actualYears.toFixed(2)} years — kept the written dates`
      );
    }

    const parsed = parseMaintenanceWork(row.maintenanceWork);
    const schedule = buildVisitSchedule(startDate, expiryDate, parsed);
    const totalVisits = schedule.length;
    if (!totalVisits) {
      report.skipped.push({ row: row.row, reason: `no visit entitlement parsed from "${row.maintenanceWork}"` });
      continue;
    }

    const servicesIncluded = [];
    for (const kind of VISIT_KINDS) {
      const qty = parsed[kind];
      if (!qty) continue;
      const service = await getVisitService(row.coating, kind);
      servicesIncluded.push({ serviceId: service._id, quantity: qty });
    }

    const { phone, issue } = normalizeIndianPhone(row.phone);
    const usedPlaceholder = !phone;
    const finalPhone = phone || placeholderPhone(row.row);
    if (issue && phone) {
      report.followUps.push(`row ${row.row} (${row.ownerName}): sheet phone "${row.phone}" ${issue} → ${phone}`);
    }

    const { customer } = await getCustomer(row, finalPhone, usedPlaceholder);
    const car = await getCar(row, customer._id);
    const template = await getTemplate(row, sheetYears || Math.round(actualYears), servicesIncluded, row.price);

    const name = packageName(row, sheetYears || Math.round(actualYears));
    const description = `${rowTag} | ${row.coating} | ${row.term} | ${row.vehicleNo || 'no vehicle'} | sheet: "${row.maintenanceWork}" | sold at ₹${row.price} before go-live, invoice closed at ₹0`;
    const status = expiryDate < new Date() ? 'expired' : 'active';

    invoiceSeq += 1;
    const invoiceNumber = `${INVOICE_PREFIX}${String(invoiceSeq).padStart(3, '0')}`;

    const rowReport = {
      row: row.row,
      owner: row.ownerName || null,
      vehicle: row.vehicleNo || null,
      phone: finalPhone,
      placeholderPhone: usedPlaceholder,
      packageName: name,
      sheetPrice: row.price,
      startDate: startDate.toISOString().slice(0, 10),
      expiryDate: expiryDate.toISOString().slice(0, 10),
      status,
      totalVisits,
      visitBreakdown: { service: parsed.service, recoat: parsed.recoat, maintenance: parsed.maintenance },
      sixMonthly: parsed.sixMonthly,
      invoiceNumber,
      dueDates: schedule.map((v) => `${v.kind} ${v.dueDate.toISOString().slice(0, 10)}`)
    };

    if (!apply) {
      report.created.packages += 1;
      report.created.invoices += 1;
      report.created.visits += totalVisits;
      report.rows.push(rowReport);
      continue;
    }

    const customerPackage = await models.CustomerPackage.create({
      businessId,
      branchId,
      customerId: customer._id,
      packageTemplateId: template._id,
      name,
      price: row.price,
      totalVisits,
      validityValue,
      validityUnit: 'years',
      validityDays: Math.round(validityValue * 365.25),
      servicesIncluded,
      servicesRemaining: servicesIncluded.map((s) => ({
        serviceId: s.serviceId,
        total: s.quantity,
        remaining: s.quantity
      })),
      description,
      visitsUsed: 0,
      visitsRemaining: totalVisits,
      startDate,
      expiryDate,
      status
    });
    await backdate(models.CustomerPackage, customerPackage._id, startDate);
    report.created.packages += 1;

    const invoice = await models.Invoice.create({
      saleType: 'PACKAGE',
      packageId: customerPackage._id,
      packageName: name,
      businessId,
      branchId,
      invoiceNumber,
      customerId: customer._id,
      customerName: customer.name || '',
      customerPhone: finalPhone,
      vehicleNumber: car?.carNumber || '',
      items: [{ serviceName: `${name} (sold before go-live)`, servicePrice: 0 }],
      discount: 0,
      discountType: 'PERCENT',
      discountAmount: 0,
      subtotal: 0,
      gstAmount: 0,
      finalAmount: 0,
      advancePayment: 0,
      paymentMethod: 'CASH',
      paymentCashAmount: 0,
      paymentOnlineAmount: 0,
      paymentStatus: 'RECEIVED',
      paymentReceivedAt: startDate,
      saleConfirmedAt: startDate,
      settlementMode: 'FULL',
      outstandingAmount: 0,
      shareToken: models.generateShareToken(),
      createdBy: ownerId
    });
    await backdate(models.Invoice, invoice._id, startDate);
    report.created.invoices += 1;

    let index = 0;
    for (const visit of schedule) {
      index += 1;
      const service = await getVisitService(row.coating, visit.kind);
      await models.PackageVisit.create({
        businessId,
        branchId,
        customerPackageId: customerPackage._id,
        scheduledFor: visit.dueDate,
        date: visit.dueDate,
        status: 'scheduled',
        notes: `${rowTag} | ${visit.kind} ${index} of ${totalVisits} | due ${visit.dueDate.toISOString().slice(0, 10)}`,
        servicesUsed: [{ serviceId: service._id, quantity: 1 }]
      });
      report.created.visits += 1;
    }

    rowReport.customerId = String(customer._id);
    rowReport.customerPackageId = String(customerPackage._id);
    rowReport.invoiceId = String(invoice._id);
    if (car?._id) rowReport.carId = String(car._id);
    report.rows.push(rowReport);
  }

  const reportPath = path.resolve(__dirname, 'data', `mojo-legacy-coating-import-report.${apply ? 'apply' : 'dry-run'}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n=== ${report.mode.toUpperCase()} — ${IMPORT_REF} ===`);
  console.log('created:', report.created);
  console.log(`skipped: ${report.skipped.length}`);
  for (const s of report.skipped) console.log(`   row ${s.row}: ${s.reason}`);
  console.log(`\nfollow-ups needing your confirmation (${report.followUps.length}):`);
  for (const f of report.followUps) console.log(`   ${f}`);
  console.log(`\nreport written to ${reportPath}`);
  return report;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const doRollback = process.argv.includes('--rollback');
  await connect();
  try {
    if (doRollback) {
      const models = await loadModels();
      const ctx = await resolveContext(models);
      await rollback(models, ctx);
    } else {
      await run({ apply });
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
