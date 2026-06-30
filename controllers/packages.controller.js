import mongoose from 'mongoose';
import CustomerPackage from '../models/CustomerPackage.model.js';
import PackageTemplate from '../models/PackageTemplate.model.js';
import PackageVisit from '../models/PackageVisit.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import Invoice, { generateInvoiceNumber, generateShareToken } from '../models/Invoice.model.js';
import User from '../models/User.model.js';
import { sendPushNotification } from '../services/notificationService.js';
import { balanceDue, assertSettlementMatchesDue, normalizeInvoicePaymentFields, roundMoney } from '../utils/invoicePayment.js';
import { isCreditSettlementMode, closePackageOnCredit } from '../services/credit/creditInvoiceService.js';
import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';
import { moduleDisabledResponse } from '../middleware/businessModules.middleware.js';
import { getInvoiceCompanySnapshot } from '../utils/invoiceCompany.js';
import { applyBranchScope } from '../utils/branchQuery.js';
import { assertBranchAccess, findScoped, branchIdForCreate } from '../utils/branchAccess.js';

// ==================== Helpers ====================

function oid(id) {
  if (!id) return null;
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

async function resolveOwnerId(req) {
  if (req.user?.role === 'CAR_WASH_ADMIN') return req.user._id;
  const owner = await User.findOne({
    businessId: req.businessId,
    role: 'CAR_WASH_ADMIN',
    status: 'ACTIVE'
  }).select('_id').lean();
  return owner?._id || null;
}

async function markExpiredPackages(businessId, filter = {}) {
  const now = new Date();
  await CustomerPackage.updateMany(
    {
      businessId,
      ...filter,
      status: 'active',
      expiryDate: { $lt: now }
    },
    { $set: { status: 'expired' } }
  );
}

function normalizeServicesUsed(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    const err = new Error('At least one service is required');
    err.status = 400;
    throw err;
  }
  const out = [];
  for (const row of raw) {
    const serviceId = row?.serviceId;
    if (!serviceId || !mongoose.isValidObjectId(String(serviceId))) {
      const err = new Error('Invalid service');
      err.status = 400;
      throw err;
    }
    const quantity = Math.max(1, Math.floor(Number(row?.quantity || 1)));
    out.push({ serviceId, quantity });
  }
  return out;
}

function buildServicesRemainingFromIncluded(servicesIncluded) {
  return (Array.isArray(servicesIncluded) ? servicesIncluded : []).map((row) => {
    const total = Math.max(0, Math.floor(Number(row?.quantity || 0)));
    return {
      serviceId: row.serviceId,
      total,
      remaining: total
    };
  });
}

function assertPackageActive(pkg) {
  if (!pkg) {
    const err = new Error('Customer package not found');
    err.status = 404;
    throw err;
  }
  if (pkg.status !== 'active') {
    const err = new Error(`Package is ${pkg.status}`);
    err.status = 400;
    throw err;
  }
  if (Number(pkg.visitsRemaining || 0) <= 0) {
    const err = new Error('No visits remaining on this package');
    err.status = 400;
    throw err;
  }
  if (pkg.expiryDate && new Date(pkg.expiryDate) < new Date()) {
    const err = new Error('Package has expired');
    err.status = 400;
    throw err;
  }
}

function assertInvoicePaid(invoice) {
  if (!invoice) {
    const err = new Error('Invoice not found for this package');
    err.status = 404;
    throw err;
  }
  if (invoice.paymentStatus !== 'RECEIVED') {
    const err = new Error('Payment required before package actions');
    err.status = 402;
    throw err;
  }
}

function validateServiceDeductions(pkg, servicesUsed) {
  const remainingMap = new Map(
    (pkg.servicesRemaining || []).map((row) => [String(row.serviceId), Number(row.remaining || 0)])
  );
  for (const row of servicesUsed) {
    const key = String(row.serviceId);
    const remaining = remainingMap.get(key);
    if (remaining == null) {
      const err = new Error('Service is not included in this package');
      err.status = 400;
      throw err;
    }
    if (row.quantity > remaining) {
      const err = new Error('Insufficient service quantity remaining');
      err.status = 400;
      throw err;
    }
  }
}

function applyServiceDeductions(pkg, servicesUsed) {
  const remainingMap = new Map(
    (pkg.servicesRemaining || []).map((row) => [String(row.serviceId), { ...row.toObject?.() || row }])
  );
  for (const row of servicesUsed) {
    const key = String(row.serviceId);
    const entry = remainingMap.get(key);
    if (entry) {
      entry.remaining = Math.max(0, Number(entry.remaining || 0) - row.quantity);
      remainingMap.set(key, entry);
    }
  }
  pkg.servicesRemaining = Array.from(remainingMap.values());
}

async function findPackageInvoice(businessId, customerPackageId) {
  return Invoice.findOne({ businessId, packageId: customerPackageId });
}

async function attachInvoiceMeta(businessId, packages) {
  const rows = Array.isArray(packages) ? packages : [];
  if (!rows.length) return rows;
  const ids = rows.map((p) => p._id).filter(Boolean);
  const invoices = await Invoice.find({ businessId, packageId: { $in: ids } })
    .select('_id packageId paymentStatus')
    .lean();
  const byPkg = new Map(invoices.map((inv) => [String(inv.packageId), inv]));
  return rows.map((p) => {
    const inv = byPkg.get(String(p._id));
    return {
      ...p,
      invoiceId: inv?._id || null,
      invoicePaymentStatus: inv?.paymentStatus || null
    };
  });
}

async function attachCustomerCars(businessId, packages) {
  const rows = Array.isArray(packages) ? packages : [];
  if (!rows.length) return rows;
  const customerIds = [
    ...new Set(rows.map((p) => String(p.customerId?._id || p.customerId)).filter(Boolean))
  ].map((id) => oid(id)).filter(Boolean);
  if (!customerIds.length) return rows.map((p) => ({ ...p, customerCars: [] }));

  const cars = await Car.find({ businessId, customerId: { $in: customerIds } })
    .select('customerId carNumber brand model color registrationNumber')
    .lean();
  const byCustomer = new Map();
  for (const car of cars) {
    const key = String(car.customerId);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(car);
  }
  return rows.map((p) => {
    const key = String(p.customerId?._id || p.customerId || '');
    return { ...p, customerCars: byCustomer.get(key) || [] };
  });
}

async function validateTemplateServices(businessId, servicesIncluded) {
  const rows = Array.isArray(servicesIncluded) ? servicesIncluded : [];
  if (!rows.length) return [];
  const ids = rows.map((r) => r.serviceId).filter((id) => mongoose.isValidObjectId(String(id)));
  if (!ids.length) return [];
  const found = await Service.find({ businessId, _id: { $in: ids }, isActive: { $ne: false } })
    .select('_id')
    .lean();
  const allowed = new Set(found.map((s) => String(s._id)));
  return rows
    .filter((r) => allowed.has(String(r.serviceId)))
    .map((r) => ({
      serviceId: r.serviceId,
      quantity: Math.max(1, Math.floor(Number(r.quantity || 1)))
    }));
}

function visitPayloadFromBody(body) {
  return {
    notes: body.notes?.trim() || undefined,
    servicesUsed: normalizeServicesUsed(body.servicesUsed),
    assignedTo: body.assignedTo && mongoose.isValidObjectId(String(body.assignedTo)) ? body.assignedTo : null,
    createWithoutImages: !!body.createWithoutImages,
    beforeImages: body.createWithoutImages ? [] : (Array.isArray(body.beforeImages) ? body.beforeImages : []),
    afterImages: body.createWithoutImages ? [] : (Array.isArray(body.afterImages) ? body.afterImages : [])
  };
}

// ==================== Template CRUD ====================

export async function listTemplates(req, res) {
  try {
    const templates = await PackageTemplate.find({ businessId: req.businessId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: templates });
  } catch (error) {
    console.error('List package templates error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function createTemplate(req, res) {
  try {
    const { name, price, totalVisits, validityDays, servicesIncluded, description } = req.body;
    const normalizedServices = await validateTemplateServices(req.businessId, servicesIncluded);
    const template = await PackageTemplate.create({
      businessId: req.businessId,
      name: String(name).trim(),
      price: roundMoney(price),
      totalVisits: Math.max(1, Math.floor(Number(totalVisits))),
      validityDays: Math.max(1, Math.floor(Number(validityDays))),
      servicesIncluded: normalizedServices,
      description: description?.trim() || undefined,
      isActive: true
    });
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    console.error('Create package template error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function updateTemplate(req, res) {
  try {
    const template = await PackageTemplate.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const { name, price, totalVisits, validityDays, servicesIncluded, description, isActive } = req.body;
    if (name !== undefined) template.name = String(name).trim();
    if (price !== undefined) template.price = roundMoney(price);
    if (totalVisits !== undefined) template.totalVisits = Math.max(1, Math.floor(Number(totalVisits)));
    if (validityDays !== undefined) template.validityDays = Math.max(1, Math.floor(Number(validityDays)));
    if (description !== undefined) template.description = description?.trim() || undefined;
    if (isActive !== undefined) template.isActive = !!isActive;
    if (servicesIncluded !== undefined) {
      template.servicesIncluded = await validateTemplateServices(req.businessId, servicesIncluded);
    }

    await template.save();
    res.json({ success: true, data: template });
  } catch (error) {
    console.error('Update package template error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function softDeleteTemplate(req, res) {
  try {
    const template = await PackageTemplate.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    template.isActive = false;
    await template.save();
    res.json({ success: true, data: template, message: 'Template disabled' });
  } catch (error) {
    console.error('Disable package template error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ==================== Purchase ====================

export async function purchasePackage(req, res) {
  try {
    const { templateId, customerId, carId } = req.body;

    const template = await PackageTemplate.findOne({
      _id: templateId,
      businessId: req.businessId,
      isActive: { $ne: false }
    });
    if (!template) {
      return res.status(404).json({ success: false, message: 'Package template not found' });
    }

    const customer = await findScoped(Customer, req, { _id: customerId });
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    assertBranchAccess(req, customer);

    let car = null;
    if (carId) {
      car = await findScoped(Car, req, { _id: carId, customerId: customer._id });
      if (!car) {
        return res.status(400).json({ success: false, message: 'Car not found for this customer' });
      }
    }

    const startDate = new Date();
    const expiryDate = new Date(startDate);
    expiryDate.setDate(expiryDate.getDate() + Number(template.validityDays || 0));

    const servicesIncluded = (template.servicesIncluded || []).map((row) => ({
      serviceId: row.serviceId,
      quantity: Math.max(1, Math.floor(Number(row.quantity || 1)))
    }));

    const purchaseBranchId = customer.branchId || req.branchId || branchIdForCreate(req);

    const customerPackage = await CustomerPackage.create({
      businessId: req.businessId,
      branchId: purchaseBranchId,
      customerId: customer._id,
      packageTemplateId: template._id,
      name: template.name,
      price: template.price,
      totalVisits: template.totalVisits,
      validityDays: template.validityDays,
      servicesIncluded,
      servicesRemaining: buildServicesRemainingFromIncluded(servicesIncluded),
      description: template.description,
      visitsUsed: 0,
      visitsRemaining: template.totalVisits,
      startDate,
      expiryDate,
      status: 'active'
    });

    let invoiceNumber = generateInvoiceNumber();
    while (await Invoice.findOne({ businessId: req.businessId, invoiceNumber })) {
      invoiceNumber = generateInvoiceNumber();
    }

    const company = await getInvoiceCompanySnapshot(req.businessId);
    const subtotal = roundMoney(template.price);
    const invoice = await Invoice.create({
      saleType: 'PACKAGE',
      packageId: customerPackage._id,
      packageName: template.name,
      businessId: req.businessId,
      branchId: purchaseBranchId,
      invoiceNumber,
      companyName: company?.businessName || null,
      companyOwnerName: company?.ownerName || null,
      companyAddress: company?.address || null,
      companyPhone: company?.phone || null,
      companyGst: company?.gstNumber || null,
      customerId: customer._id,
      customerName: customer.name ?? '',
      customerPhone: customer.phone || customer.whatsappNumber || '',
      vehicleNumber: car?.carNumber ?? '',
      items: [{ serviceName: template.name, servicePrice: subtotal }],
      discount: 0,
      subtotal,
      finalAmount: subtotal,
      advancePayment: 0,
      paymentMethod: 'CASH',
      paymentCashAmount: 0,
      paymentOnlineAmount: 0,
      paymentStatus: 'PENDING',
      shareToken: generateShareToken(),
      createdBy: req.user._id
    });

    try {
      const ownerId = await resolveOwnerId(req);
      if (ownerId) {
        await sendPushNotification({
          businessOwnerId: ownerId,
          title: 'Package purchased',
          body: `${customer.name} purchased ${template.name}`,
          data: {
            type: 'package_purchased',
            packageId: String(customerPackage._id),
            url: `/admin/packages/${customerPackage._id}`
          }
        });
      }
    } catch (pushErr) {
      console.warn('Push notification error (package_purchased):', pushErr?.message || pushErr);
    }

    res.status(201).json({
      success: true,
      data: { customerPackage, invoice }
    });
  } catch (error) {
    console.error('Purchase package error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ==================== Customer packages ====================

export async function getCustomerPackages(req, res) {
  try {
    const customerId = req.params.customerId;
    if (!mongoose.isValidObjectId(String(customerId))) {
      return res.status(400).json({ success: false, message: 'Invalid customer id' });
    }

    await markExpiredPackages(req.businessId, { customerId });

    const packages = await CustomerPackage.find({
      businessId: req.businessId,
      customerId
    })
      .populate('customerId', 'name phone email whatsappNumber')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: packages });
  } catch (error) {
    console.error('Get customer packages error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function listCustomerPackages(req, res) {
  try {
    const { status, remaining } = req.query;
    const query = applyBranchScope({ businessId: req.businessId }, req);
    if (status && typeof status === 'string' && status.trim()) {
      query.status = status.trim();
    }
    if (remaining === 'true') {
      query.visitsRemaining = { $gt: 0 };
    }

    await markExpiredPackages(req.businessId, query);

    let packages = await CustomerPackage.find(query)
      .populate('customerId', 'name phone email whatsappNumber')
      .sort({ createdAt: -1 })
      .lean();

    packages = await attachInvoiceMeta(req.businessId, packages);
    packages = await attachCustomerCars(req.businessId, packages);

    res.json({ success: true, data: packages });
  } catch (error) {
    console.error('List customer packages error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function getCustomerPackageDetail(req, res) {
  try {
    const pkgId = req.params.id;
    if (!mongoose.isValidObjectId(String(pkgId))) {
      return res.status(400).json({ success: false, message: 'Invalid package id' });
    }

    await markExpiredPackages(req.businessId, { _id: pkgId });

    const customerPackage = await CustomerPackage.findOne(applyBranchScope({
      _id: pkgId,
      businessId: req.businessId
    }, req))
      .populate('customerId', 'name phone email whatsappNumber')
      .lean();

    if (!customerPackage) {
      return res.status(404).json({ success: false, message: 'Customer package not found' });
    }

    const [invoice, visits, customerCars] = await Promise.all([
      Invoice.findOne({ businessId: req.businessId, packageId: pkgId }).lean(),
      PackageVisit.find({ businessId: req.businessId, customerPackageId: pkgId })
        .sort({ date: -1, createdAt: -1 })
        .lean(),
      Car.find({ businessId: req.businessId, customerId: customerPackage.customerId?._id || customerPackage.customerId })
        .select('carNumber brand model color registrationNumber')
        .lean()
    ]);

    res.json({
      success: true,
      data: {
        customerPackage: { ...customerPackage, customerCars },
        invoice,
        visits
      }
    });
  } catch (error) {
    console.error('Get customer package detail error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function closeCustomerPackage(req, res) {
  try {
    const pkg = await CustomerPackage.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!pkg) {
      return res.status(404).json({ success: false, message: 'Customer package not found' });
    }

    const invoice = await findPackageInvoice(req.businessId, pkg._id);
    try {
      assertInvoicePaid(invoice);
    } catch (e) {
      return res.status(e.status || 402).json({ success: false, message: e.message });
    }

    if (pkg.status === 'cancelled') {
      return res.json({ success: true, data: pkg, message: 'Package already cancelled' });
    }

    pkg.status = 'cancelled';
    await pkg.save();

    res.json({ success: true, data: pkg, message: 'Package cancelled' });
  } catch (error) {
    console.error('Close customer package error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function closePackageSale(req, res) {
  try {
    const pkg = await CustomerPackage.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!pkg) {
      return res.status(404).json({ success: false, message: 'Customer package not found' });
    }

    const invoice = await findPackageInvoice(req.businessId, pkg._id);
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found for this package' });
    }

    if (invoice.paymentStatus === 'RECEIVED') {
      return res.json({ success: true, invoice, message: 'Package already marked paid' });
    }
    if (invoice.settlementMode === 'CREDIT' && invoice.saleConfirmedAt) {
      return res.json({ success: true, invoice, message: 'Package sale already recorded on credit' });
    }

    if (!invoice.customerId) {
      invoice.customerId = pkg.customerId;
    }

    if (isCreditSettlementMode(req.body)) {
      const modules = await getBusinessModules(req.businessId);
      if (!isModuleEnabled(modules, 'credit')) {
        return moduleDisabledResponse(res, 'credit');
      }
      try {
        const result = await closePackageOnCredit({
          invoice,
          businessId: req.businessId,
          user: req.user,
          body: req.body,
          customerId: pkg.customerId
        });
        return res.json({ success: true, invoice: result.invoice, message: result.message });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message || 'Credit close failed' });
      }
    }

    const due = balanceDue(invoice.finalAmount, invoice.advancePayment);
    try {
      normalizeInvoicePaymentFields(invoice, {
        paymentMethod: req.body.paymentMethod ?? invoice.paymentMethod,
        paymentCashAmount: req.body.paymentCashAmount,
        paymentOnlineAmount: req.body.paymentOnlineAmount
      });
      assertSettlementMatchesDue(
        invoice.paymentMethod,
        due,
        invoice.paymentCashAmount,
        invoice.paymentOnlineAmount
      );
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message || 'Payment does not match balance due' });
    }

    invoice.paymentStatus = 'RECEIVED';
    invoice.paymentReceivedAt = new Date();
    await invoice.save();

    res.json({ success: true, invoice, message: 'Package marked paid' });
  } catch (error) {
    console.error('Close package sale error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ==================== Visits ====================

export async function listVisits(req, res) {
  try {
    const customerPackageId = req.params.customerPackageId;
    if (!mongoose.isValidObjectId(String(customerPackageId))) {
      return res.status(400).json({ success: false, message: 'Invalid package id' });
    }

    const pkg = await CustomerPackage.findOne(applyBranchScope({
      _id: customerPackageId,
      businessId: req.businessId
    }, req)).select('_id').lean();
    if (!pkg) {
      return res.status(404).json({ success: false, message: 'Customer package not found' });
    }

    const visits = await PackageVisit.find(applyBranchScope({
      businessId: req.businessId,
      customerPackageId
    }, req))
      .sort({ date: -1, createdAt: -1 })
      .lean();

    res.json({ success: true, data: visits });
  } catch (error) {
    console.error('List package visits error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function listScheduledVisits(req, res) {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
    const includeOverdue = req.query.includeOverdue === 'true';
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + days);

    const dateFilter = includeOverdue
      ? { $lte: end }
      : { $gte: now, $lte: end };

    const visits = await PackageVisit.find({
      businessId: req.businessId,
      status: 'scheduled',
      date: dateFilter
    })
      .populate({
        path: 'customerPackageId',
        select: 'name status totalVisits visitsUsed visitsRemaining customerId expiryDate',
        populate: { path: 'customerId', select: 'name phone email whatsappNumber' }
      })
      .sort({ date: 1, createdAt: 1 })
      .lean();

    res.json({ success: true, data: visits });
  } catch (error) {
    console.error('List scheduled visits error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function scheduleVisit(req, res) {
  try {
    const { customerPackageId, date } = req.body;
    const scheduledAt = new Date(date);
    if (Number.isNaN(scheduledAt.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date' });
    }

    const pkg = await CustomerPackage.findOne({ _id: customerPackageId, businessId: req.businessId });
    if (!pkg) {
      return res.status(404).json({ success: false, message: 'Customer package not found' });
    }

    await markExpiredPackages(req.businessId, { _id: pkg._id });
    const refreshed = await CustomerPackage.findById(pkg._id);
    try {
      assertPackageActive(refreshed);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    const invoice = await findPackageInvoice(req.businessId, pkg._id);
    try {
      assertInvoicePaid(invoice);
    } catch (e) {
      return res.status(e.status || 402).json({ success: false, message: e.message });
    }

    let visitFields;
    try {
      visitFields = visitPayloadFromBody(req.body);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    validateServiceDeductions(refreshed, visitFields.servicesUsed);

    const visit = await PackageVisit.create({
      businessId: req.businessId,
      branchId: req.branchId || null,
      customerPackageId: refreshed._id,
      scheduledFor: scheduledAt,
      date: scheduledAt,
      status: 'scheduled',
      ...visitFields
    });

    try {
      const ownerId = await resolveOwnerId(req);
      if (ownerId) {
        await sendPushNotification({
          businessOwnerId: ownerId,
          title: 'Package visit scheduled',
          body: `${refreshed.name} visit scheduled for ${scheduledAt.toLocaleString()}`,
          data: {
            type: 'visit_scheduled',
            packageId: String(refreshed._id),
            refId: String(visit._id),
            url: `/admin/packages/${refreshed._id}`
          }
        });
      }
    } catch (pushErr) {
      console.warn('Push notification error (visit_scheduled):', pushErr?.message || pushErr);
    }

    res.status(201).json({ success: true, data: visit });
  } catch (error) {
    console.error('Schedule package visit error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function completeVisit(req, res) {
  try {
    const { customerPackageId, bookingId } = req.body;

    const pkg = await CustomerPackage.findOne({ _id: customerPackageId, businessId: req.businessId });
    if (!pkg) {
      return res.status(404).json({ success: false, message: 'Customer package not found' });
    }

    await markExpiredPackages(req.businessId, { _id: pkg._id });
    const refreshed = await CustomerPackage.findById(pkg._id);
    try {
      assertPackageActive(refreshed);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    const invoice = await findPackageInvoice(req.businessId, pkg._id);
    try {
      assertInvoicePaid(invoice);
    } catch (e) {
      return res.status(e.status || 402).json({ success: false, message: e.message });
    }

    let visitFields;
    try {
      visitFields = visitPayloadFromBody(req.body);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    validateServiceDeductions(refreshed, visitFields.servicesUsed);

    if (bookingId && mongoose.isValidObjectId(String(bookingId))) {
      const existing = await PackageVisit.findOne({
        businessId: req.businessId,
        customerPackageId: refreshed._id,
        bookingId,
        status: 'completed'
      }).select('_id').lean();
      if (existing) {
        const current = await CustomerPackage.findById(refreshed._id).lean();
        return res.json({ success: true, data: existing, customerPackage: current, message: 'Visit already completed' });
      }
    }

    const now = new Date();
    const decremented = await CustomerPackage.findOneAndUpdate(
      {
        _id: refreshed._id,
        businessId: req.businessId,
        status: 'active',
        visitsRemaining: { $gt: 0 },
        expiryDate: { $gte: now }
      },
      { $inc: { visitsUsed: 1, visitsRemaining: -1 } },
      { new: true }
    );
    if (!decremented) {
      return res.status(409).json({ success: false, message: 'No visits remaining or package is no longer active' });
    }
    if (decremented.visitsRemaining === 0) {
      decremented.status = 'completed';
      await CustomerPackage.updateOne({ _id: decremented._id }, { $set: { status: 'completed' } });
    }

    let visit = await PackageVisit.findOne({
      businessId: req.businessId,
      customerPackageId: refreshed._id,
      status: 'scheduled'
    }).sort({ date: 1, createdAt: 1 });

    if (visit) {
      visit.scheduledFor = visit.scheduledFor || visit.date;
      visit.date = now;
      visit.status = 'completed';
      visit.notes = visitFields.notes ?? visit.notes;
      visit.servicesUsed = visitFields.servicesUsed;
      visit.assignedTo = visitFields.assignedTo;
      visit.createWithoutImages = visitFields.createWithoutImages;
      visit.beforeImages = visitFields.beforeImages;
      visit.afterImages = visitFields.afterImages;
      if (bookingId && mongoose.isValidObjectId(String(bookingId))) {
        visit.bookingId = bookingId;
      }
      await visit.save();
    } else {
      visit = await PackageVisit.create({
        businessId: req.businessId,
        branchId: req.branchId || null,
        customerPackageId: refreshed._id,
        bookingId: bookingId && mongoose.isValidObjectId(String(bookingId)) ? bookingId : undefined,
        date: now,
        status: 'completed',
        ...visitFields
      });
    }

    applyServiceDeductions(decremented, visitFields.servicesUsed);
    await decremented.save();

    try {
      const ownerId = await resolveOwnerId(req);
      if (ownerId) {
        await sendPushNotification({
          businessOwnerId: ownerId,
          title: 'Package visit completed',
          body: `${decremented.name} visit marked completed`,
          data: {
            type: 'visit_completed',
            packageId: String(decremented._id),
            refId: String(visit._id),
            url: `/admin/packages/${decremented._id}`
          }
        });
      }
    } catch (pushErr) {
      console.warn('Push notification error (visit_completed):', pushErr?.message || pushErr);
    }

    res.json({ success: true, data: visit, customerPackage: decremented });
  } catch (error) {
    console.error('Complete package visit error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}
