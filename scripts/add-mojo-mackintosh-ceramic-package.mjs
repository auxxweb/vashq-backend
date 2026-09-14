/**
 * Add / patch Mojo Autocafe legacy ceramic package for ARJUN KARAYAD (MACKINTOSH).
 *
 * Same rules as the coating import: ₹0 paid invoice, no money-ledger / sales impact.
 * Vehicle number was missing on the original sheet; use the mobile number as the plate.
 * One of two yearly services is already done — leave one visit remaining.
 *
 *   node scripts/add-mojo-mackintosh-ceramic-package.mjs            # dry run
 *   node scripts/add-mojo-mackintosh-ceramic-package.mjs --apply
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const EMAIL = 'mojoautocafe@gmail.com';
const IMPORT_TAG = '[MOJO-LEGACY-COATING-2026-09]';
const ROW_TAG = `${IMPORT_TAG} row 25`;
const PHONE = '+919947106451';
const PLATE = '9947106451';
const OWNER = 'ARJUN KARAYAD';
const COMPANY = 'MACKINTOSH';
const CUSTOMER_NAME = `${OWNER} - ${COMPANY}`;
const START = new Date(Date.UTC(2025, 6, 16));
const EXPIRY = new Date(Date.UTC(2026, 6, 16));
const FIRST_VISIT = new Date(Date.UTC(2026, 0, 16));
const SECOND_VISIT = new Date(Date.UTC(2026, 6, 16));
const APPLY = process.argv.includes('--apply');

async function connect() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 60000 });
}

function inspect(label, doc) {
  if (!doc) {
    console.log(`${label}: (none)`);
    return;
  }
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  console.log(`${label}:`, JSON.stringify(plain, null, 2));
}

async function main() {
  const [
    { default: User },
    { default: Branch },
    { default: Customer },
    { default: Car },
    { default: Service },
    { default: PackageTemplate },
    { default: CustomerPackage },
    { default: PackageVisit },
    InvoiceModule,
    { findCustomerByPhone }
  ] = await Promise.all([
    import('../models/User.model.js'),
    import('../models/Branch.model.js'),
    import('../models/Customer.model.js'),
    import('../models/Car.model.js'),
    import('../models/Service.model.js'),
    import('../models/PackageTemplate.model.js'),
    import('../models/CustomerPackage.model.js'),
    import('../models/PackageVisit.model.js'),
    import('../models/Invoice.model.js'),
    import('../utils/customer.utils.js').then((m) => ({ findCustomerByPhone: m.findCustomerByPhone }))
  ]);
  const Invoice = InvoiceModule.default;
  const generateShareToken = InvoiceModule.generateShareToken;

  const owner = await User.findOne({ email: new RegExp(`^${EMAIL}$`, 'i') }).lean();
  if (!owner) throw new Error(`No user found for ${EMAIL}`);
  const businessId = owner.businessId;
  const branch = await Branch.findOne({ businessId, isDefault: true, status: 'ACTIVE' }).lean();
  if (!branch) throw new Error('No default active branch found');
  const branchId = branch._id;

  let customer = await findCustomerByPhone(businessId, PHONE, branchId);
  if (!customer) {
    customer = await Customer.findOne({
      businessId,
      name: new RegExp('ARJUN KARAYAD', 'i')
    });
  }

  const existingPkg = customer
    ? await CustomerPackage.findOne({
      businessId,
      customerId: customer._id,
      $or: [
        { description: new RegExp('row 25\\b') },
        { name: /CERAMIC COATING/i, startDate: START }
      ]
    })
    : await CustomerPackage.findOne({ businessId, description: new RegExp('row 25\\b') });

  const carQuery = {
    businessId,
    $or: [{ carNumber: PLATE }, { carNumber: PHONE }]
  };
  if (customer) carQuery.$or.push({ customerId: customer._id, model: /CRETA/i });
  const existingCar = await Car.findOne(carQuery);

  const existingInvoice = existingPkg
    ? await Invoice.findOne({ businessId, packageId: existingPkg._id }).lean()
    : null;

  const existingVisits = existingPkg
    ? await PackageVisit.find({ businessId, customerPackageId: existingPkg._id }).sort({ date: 1 }).lean()
    : [];

  console.log('mode:', APPLY ? 'APPLY' : 'dry-run');
  inspect('customer', customer && {
    _id: customer._id,
    name: customer.name,
    phone: customer.phone,
    notes: customer.notes
  });
  inspect('package', existingPkg && {
    _id: existingPkg._id,
    name: existingPkg.name,
    price: existingPkg.price,
    status: existingPkg.status,
    visitsUsed: existingPkg.visitsUsed,
    visitsRemaining: existingPkg.visitsRemaining,
    startDate: existingPkg.startDate,
    expiryDate: existingPkg.expiryDate,
    description: existingPkg.description
  });
  inspect('car', existingCar && {
    _id: existingCar._id,
    carNumber: existingCar.carNumber,
    model: existingCar.model,
    customerId: existingCar.customerId
  });
  inspect('invoice', existingInvoice && {
    _id: existingInvoice._id,
    invoiceNumber: existingInvoice.invoiceNumber,
    finalAmount: existingInvoice.finalAmount,
    paymentStatus: existingInvoice.paymentStatus,
    vehicleNumber: existingInvoice.vehicleNumber
  });
  console.log('visits:', existingVisits.map((v) => ({
    _id: v._id,
    status: v.status,
    date: v.date,
    notes: v.notes
  })));

  if (!APPLY) {
    console.log('\nWould: keep/create ₹0 invoice, set customer name with MACKINTOSH, plate 9947106451, 1 visit completed / 1 remaining. No ledger writes.');
    return;
  }

  if (customer) {
    const notes = String(customer.notes || '');
    await Customer.collection.updateOne(
      { _id: customer._id },
      {
        $set: {
          name: CUSTOMER_NAME,
          notes: notes.includes('MACKINTOSH')
            ? notes
            : [notes, `Company: ${COMPANY}`, ROW_TAG].filter(Boolean).join(' | ')
        }
      }
    );
    customer.name = CUSTOMER_NAME;
  } else {
    customer = await Customer.create({
      businessId,
      branchId,
      name: CUSTOMER_NAME,
      phone: PHONE,
      whatsappNumber: PHONE,
      notes: `Company: ${COMPANY} | ${ROW_TAG}`
    });
    await Customer.collection.updateOne(
      { _id: customer._id },
      { $set: { createdAt: START, updatedAt: START } }
    );
  }

  let car = existingCar;
  if (car) {
    await Car.collection.updateOne(
      { _id: car._id },
      {
        $set: {
          carNumber: PLATE,
          model: 'CRETA',
          vehicleType: 'COMPACT SUV',
          customerId: customer._id,
          notes: String(car.notes || '').includes(IMPORT_TAG)
            ? car.notes
            : [car.notes, ROW_TAG, 'plate stored as mobile (sheet said NEW)'].filter(Boolean).join(' | ')
        },
        $addToSet: { customerIds: customer._id }
      }
    );
    car = { ...car.toObject?.() || car, carNumber: PLATE };
  } else {
    car = await Car.create({
      businessId,
      branchId,
      customerId: customer._id,
      customerIds: [customer._id],
      carNumber: PLATE,
      model: 'CRETA',
      vehicleType: 'COMPACT SUV',
      notes: `${ROW_TAG} | plate stored as mobile (sheet said NEW)`
    });
    await Car.collection.updateOne(
      { _id: car._id },
      { $set: { createdAt: START, updatedAt: START } }
    );
  }

  let visitService = await Service.findOne({ businessId, name: 'Ceramic Service' });
  if (!visitService) {
    visitService = await Service.create({
      businessId,
      branchId: null,
      name: 'Ceramic Service',
      price: 0,
      isVariable: true,
      isActive: true,
      showOnBookingForm: false,
      description: IMPORT_TAG
    });
  }

  const servicesIncluded = [{ serviceId: visitService._id, quantity: 2 }];
  const templateName = 'CERAMIC COATING - COMPACT SUV - 1 YEAR';
  let template = await PackageTemplate.findOne({ businessId, name: templateName, description: IMPORT_TAG });
  if (!template) {
    template = await PackageTemplate.create({
      businessId,
      name: templateName,
      price: 0,
      totalVisits: 2,
      validityValue: 1,
      validityUnit: 'years',
      validityDays: 365,
      servicesIncluded,
      description: IMPORT_TAG,
      isActive: false
    });
  }

  const description = `${ROW_TAG} | CERAMIC | 1 YEAR | ${PLATE} | Company: ${COMPANY} | sheet: "2 SERVICE per year, 1 completed" | sold before go-live, invoice closed at ₹0, original sheet price ₹14000 not posted to sales/ledger`;

  let pkg = existingPkg;
  const pkgSet = {
    name: templateName,
    price: 0,
    totalVisits: 2,
    visitsUsed: 1,
    visitsRemaining: 1,
    servicesIncluded,
    servicesRemaining: [{ serviceId: visitService._id, total: 2, remaining: 1 }],
    description,
    startDate: START,
    expiryDate: EXPIRY,
    status: 'expired',
    createdAt: START,
    updatedAt: START
  };
  if (pkg) {
    await CustomerPackage.collection.updateOne({ _id: pkg._id }, { $set: pkgSet });
    pkg = { ...pkg.toObject?.() || pkg, ...pkgSet };
  } else {
    pkg = await CustomerPackage.create({
      businessId,
      branchId,
      customerId: customer._id,
      packageTemplateId: template._id,
      name: templateName,
      price: 0,
      totalVisits: 2,
      validityValue: 1,
      validityUnit: 'years',
      validityDays: 365,
      servicesIncluded,
      servicesRemaining: [{ serviceId: visitService._id, total: 2, remaining: 1 }],
      description,
      visitsUsed: 1,
      visitsRemaining: 1,
      startDate: START,
      expiryDate: EXPIRY,
      status: 'expired'
    });
  }
  await CustomerPackage.collection.updateOne(
    { _id: pkg._id },
    { $set: { createdAt: START, updatedAt: START, price: 0 } }
  );

  const invoiceSet = {
    customerId: customer._id,
    customerName: CUSTOMER_NAME,
    customerPhone: PHONE,
    vehicleNumber: PLATE,
    items: [{ serviceName: `${templateName} (sold before go-live)`, servicePrice: 0 }],
    subtotal: 0,
    gstAmount: 0,
    finalAmount: 0,
    advancePayment: 0,
    paymentCashAmount: 0,
    paymentOnlineAmount: 0,
    outstandingAmount: 0,
    paymentStatus: 'RECEIVED',
    paymentMethod: 'CASH',
    settlementMode: 'FULL',
    createdAt: START,
    updatedAt: START
  };
  let invoice = existingInvoice;
  if (invoice) {
    await Invoice.collection.updateOne({ _id: invoice._id }, { $set: invoiceSet });
    invoice = { ...invoice, ...invoiceSet };
  } else {
    const lastInvoice = await Invoice.findOne({ businessId, invoiceNumber: /^LEGACY-COAT-/ })
      .sort({ invoiceNumber: -1 })
      .select('invoiceNumber')
      .lean();
    const seq = (Number(String(lastInvoice?.invoiceNumber || '').replace('LEGACY-COAT-', '')) || 0) + 1;
    invoice = await Invoice.create({
      saleType: 'PACKAGE',
      packageId: pkg._id,
      packageName: templateName,
      businessId,
      branchId,
      invoiceNumber: `LEGACY-COAT-${String(seq).padStart(3, '0')}`,
      customerId: customer._id,
      customerName: CUSTOMER_NAME,
      customerPhone: PHONE,
      vehicleNumber: PLATE,
      items: [{ serviceName: `${templateName} (sold before go-live)`, servicePrice: 0 }],
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
      paymentReceivedAt: START,
      saleConfirmedAt: START,
      settlementMode: 'FULL',
      outstandingAmount: 0,
      shareToken: generateShareToken(),
      createdBy: owner._id
    });
  }
  const visits = await PackageVisit.find({ businessId, customerPackageId: pkg._id }).sort({ date: 1 });
  if (visits.length === 0) {
    await PackageVisit.create({
      businessId,
      branchId,
      customerPackageId: pkg._id,
      scheduledFor: FIRST_VISIT,
      date: FIRST_VISIT,
      status: 'completed',
      notes: `${ROW_TAG} | service 1 of 2 completed before remaining visit`,
      servicesUsed: [{ serviceId: visitService._id, quantity: 1 }]
    });
    await PackageVisit.create({
      businessId,
      branchId,
      customerPackageId: pkg._id,
      scheduledFor: SECOND_VISIT,
      date: SECOND_VISIT,
      status: 'scheduled',
      notes: `${ROW_TAG} | service 2 of 2 remaining`,
      servicesUsed: [{ serviceId: visitService._id, quantity: 1 }]
    });
  } else {
    const first = visits[0];
    await PackageVisit.collection.updateOne(
      { _id: first._id },
      {
        $set: {
          status: 'completed',
          scheduledFor: first.scheduledFor || FIRST_VISIT,
          date: FIRST_VISIT,
          notes: `${ROW_TAG} | service 1 of 2 completed before remaining visit`,
          servicesUsed: [{ serviceId: visitService._id, quantity: 1 }]
        }
      }
    );
    for (let i = 1; i < visits.length; i += 1) {
      await PackageVisit.collection.updateOne(
        { _id: visits[i]._id },
        {
          $set: {
            status: i === 1 ? 'scheduled' : 'cancelled',
            date: SECOND_VISIT,
            scheduledFor: SECOND_VISIT,
            notes: `${ROW_TAG} | service 2 of 2 remaining`
          }
        }
      );
    }
    if (visits.length === 1) {
      await PackageVisit.create({
        businessId,
        branchId,
        customerPackageId: pkg._id,
        scheduledFor: SECOND_VISIT,
        date: SECOND_VISIT,
        status: 'scheduled',
        notes: `${ROW_TAG} | service 2 of 2 remaining`,
        servicesUsed: [{ serviceId: visitService._id, quantity: 1 }]
      });
    }
  }

  const extraVisits = await PackageVisit.find({
    businessId,
    customerPackageId: pkg._id,
    status: { $nin: ['completed', 'scheduled'] }
  });
  if (extraVisits.length) {
    await PackageVisit.deleteMany({ _id: { $in: extraVisits.map((v) => v._id) } });
  }

  const leftover = await PackageVisit.find({ businessId, customerPackageId: pkg._id }).sort({ date: 1 });
  if (leftover.length > 2) {
    const keep = leftover.filter((v) => v.status === 'completed').slice(0, 1)
      .concat(leftover.filter((v) => v.status === 'scheduled').slice(0, 1));
    const drop = leftover.filter((v) => !keep.some((k) => String(k._id) === String(v._id)));
    if (drop.length) await PackageVisit.deleteMany({ _id: { $in: drop.map((v) => v._id) } });
  }

  const MoneyLedger = (await import('../models/MoneyLedger.model.js').catch(() => ({ default: null }))).default;
  let ledgerHits = 0;
  if (MoneyLedger) {
    ledgerHits = await MoneyLedger.countDocuments({
      businessId,
      $or: [
        { sourceId: invoice._id },
        { invoiceId: invoice._id },
        { refId: invoice._id }
      ]
    });
  }

  console.log('\nApplied:', {
    customerId: String(customer._id),
    customerName: customer.name,
    carNumber: car.carNumber,
    packageId: String(pkg._id),
    packagePrice: pkg.price,
    visitsUsed: pkg.visitsUsed,
    visitsRemaining: pkg.visitsRemaining,
    status: pkg.status,
    invoiceNumber: invoice.invoiceNumber,
    invoiceAmount: invoice.finalAmount,
    moneyLedgerRowsForInvoice: ledgerHits
  });
}

connect()
  .then(main)
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
