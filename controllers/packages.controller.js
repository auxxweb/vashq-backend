import mongoose from 'mongoose';
import PackageTemplate from '../models/PackageTemplate.model.js';
import CustomerPackage from '../models/CustomerPackage.model.js';
import PackageVisit from '../models/PackageVisit.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Invoice, { generateShareToken, generateInvoiceNumber } from '../models/Invoice.model.js';
import User from '../models/User.model.js';
import { sendPushNotification } from '../services/notificationService.js';
import { balanceDue, assertSettlementMatchesDue } from '../utils/invoicePayment.js';

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function normalizeServicesIncluded(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const x of input) {
    // Backward compatibility: allow array of ids -> quantity 1
    if (typeof x === 'string' || x instanceof mongoose.Types.ObjectId) {
      out.push({ serviceId: x, quantity: 1 });
      continue;
    }
    if (x && typeof x === 'object' && x.serviceId) {
      const qtyRaw = Number(x.quantity);
      const qty = Number.isFinite(qtyRaw) ? Math.floor(qtyRaw) : 1;
      // Allow 0 to exclude the service
      if (qty > 0) out.push({ serviceId: x.serviceId, quantity: qty });
    }
  }
  // Merge duplicates by summing quantities
  const merged = new Map();
  for (const r of out) {
    const key = String(r.serviceId);
    merged.set(key, (merged.get(key) || 0) + r.quantity);
  }
  return [...merged.entries()]
    .map(([serviceId, quantity]) => ({ serviceId, quantity }))
    .filter((x) => x.quantity > 0);
}

function sumServiceQuantities(servicesIncluded) {
  return (Array.isArray(servicesIncluded) ? servicesIncluded : []).reduce((s, x) => s + Math.max(0, Number(x?.quantity || 0)), 0);
}

function buildServicesRemaining(servicesIncluded) {
  const norm = normalizeServicesIncluded(servicesIncluded);
  return norm.map((x) => ({
    serviceId: x.serviceId,
    total: Number(x.quantity || 0),
    remaining: Number(x.quantity || 0)
  }));
}

function normalizeServicesUsed(input) {
  // Same shape as servicesIncluded, but must have quantity >= 1
  const norm = normalizeServicesIncluded(input);
  return norm.map((x) => ({ serviceId: x.serviceId, quantity: Math.max(1, Math.floor(Number(x.quantity || 1))) }));
}

export async function refreshExpiredPackages(businessId) {
  const now = new Date();
  await CustomerPackage.updateMany(
    {
      businessId,
      status: 'active',
      expiryDate: { $lt: now },
      visitsRemaining: { $gt: 0 }
    },
    { $set: { status: 'expired' } }
  );
}

export async function createTemplate(req, res) {
  try {
    const { name, price, totalVisits, validityDays, servicesIncluded, description } = req.body;
    const normServices = normalizeServicesIncluded(servicesIncluded);
    const computedVisits = sumServiceQuantities(normServices);
    const tpl = await PackageTemplate.create({
      businessId: req.businessId,
      name: String(name || '').trim(),
      price: Number(price),
      totalVisits: computedVisits > 0 ? computedVisits : Number(totalVisits),
      validityDays: Number(validityDays),
      servicesIncluded: normServices,
      description: description ? String(description).trim() : undefined,
      isActive: true
    });
    res.status(201).json({ success: true, data: tpl, message: 'Package template created' });
  } catch (e) {
    console.error('Create package template error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function updateTemplate(req, res) {
  try {
    const { id } = req.params;
    const update = {};
    const allowed = ['name', 'price', 'totalVisits', 'validityDays', 'servicesIncluded', 'description', 'isActive'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    if (update.name !== undefined) update.name = String(update.name || '').trim();
    if (update.description !== undefined) update.description = String(update.description || '').trim();
    if (update.price !== undefined) update.price = Number(update.price);
    if (update.totalVisits !== undefined) update.totalVisits = Number(update.totalVisits);
    if (update.validityDays !== undefined) update.validityDays = Number(update.validityDays);
    if (update.servicesIncluded !== undefined) {
      update.servicesIncluded = normalizeServicesIncluded(update.servicesIncluded);
      const computed = sumServiceQuantities(update.servicesIncluded);
      if (computed > 0) update.totalVisits = computed;
    }

    const tpl = await PackageTemplate.findOneAndUpdate(
      { _id: id, businessId: req.businessId },
      update,
      { new: true, runValidators: true }
    );
    if (!tpl) return res.status(404).json({ success: false, message: 'Template not found' });
    res.json({ success: true, data: tpl, message: 'Template updated' });
  } catch (e) {
    console.error('Update package template error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function softDeleteTemplate(req, res) {
  try {
    const { id } = req.params;
    const tpl = await PackageTemplate.findOneAndUpdate(
      { _id: id, businessId: req.businessId },
      { $set: { isActive: false } },
      { new: true }
    );
    if (!tpl) return res.status(404).json({ success: false, message: 'Template not found' });
    res.json({ success: true, data: tpl, message: 'Template disabled' });
  } catch (e) {
    console.error('Delete template error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function listTemplates(req, res) {
  try {
    const includeInactive = String(req.query.includeInactive || '') === 'true';
    const q = { businessId: req.businessId };
    if (!includeInactive) q.isActive = true;
    const templates = await PackageTemplate.find(q).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: templates });
  } catch (e) {
    console.error('List templates error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function purchasePackage(req, res) {
  const session = await mongoose.startSession();
  try {
    const { templateId, customerId, carId } = req.body;
    session.startTransaction();

    const tpl = await PackageTemplate.findOne({ _id: templateId, businessId: req.businessId, isActive: true }).lean();
    if (!tpl) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Package template not found' });
    }
    const customer = await Customer.findOne({ _id: customerId, businessId: req.businessId }).select('_id name phone whatsappNumber email').lean();
    if (!customer) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    let vehicleNumber = '';
    if (carId) {
      const car = await Car.findOne({ _id: carId, businessId: req.businessId, customerId }).select('carNumber').lean();
      if (!car) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'Car not found for this customer' });
      }
      vehicleNumber = car.carNumber || '';
    }

    const startDate = startOfToday();
    const expiryDate = new Date(startDate);
    expiryDate.setDate(expiryDate.getDate() + Number(tpl.validityDays || 0));
    expiryDate.setHours(23, 59, 59, 999);

    const normServices = normalizeServicesIncluded(tpl.servicesIncluded);
    const computedVisits = sumServiceQuantities(normServices);
    const cp = await CustomerPackage.create([{
      businessId: req.businessId,
      customerId,
      packageTemplateId: tpl._id,
      name: tpl.name,
      price: tpl.price,
      totalVisits: computedVisits > 0 ? computedVisits : tpl.totalVisits,
      validityDays: tpl.validityDays,
      servicesIncluded: normServices,
      servicesRemaining: buildServicesRemaining(normServices),
      description: tpl.description,
      visitsUsed: 0,
      visitsRemaining: computedVisits > 0 ? computedVisits : tpl.totalVisits,
      startDate,
      expiryDate,
      status: 'active'
    }], { session });

    // Create a draft invoice (pending). Sales counting will happen when it's marked RECEIVED,
    // similar to job invoice workflow (sale completed on delivery/close).
    let invoiceNumber = generateInvoiceNumber();
    while (await Invoice.findOne({ businessId: req.businessId, invoiceNumber }).session(session)) {
      invoiceNumber = generateInvoiceNumber();
    }
    const subtotal = Number(tpl.price || 0);
    const pkgInvoice = await Invoice.create([{
      saleType: 'PACKAGE',
      packageId: cp[0]._id,
      packageName: tpl.name,
      businessId: req.businessId,
      invoiceNumber,
      companyName: null,
      companyAddress: null,
      companyPhone: null,
      companyGst: null,
      customerName: customer?.name ?? '',
      customerPhone: customer?.phone || customer?.whatsappNumber || '',
      customerGst: null,
      vehicleNumber,
      items: [{ serviceName: `Package: ${tpl.name}`, servicePrice: subtotal }],
      discount: 0,
      subtotal,
      finalAmount: subtotal,
      advancePayment: 0,
      paymentMethod: 'CASH',
      paymentCashAmount: 0,
      paymentOnlineAmount: 0,
      paymentStatus: 'PENDING',
      shareToken: generateShareToken(),
      createdBy: req.user?._id
    }], { session });

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      data: { customerPackage: cp[0], invoice: pkgInvoice[0] },
      message: 'Package purchased'
    });

    // Push notification to business owner (package_purchased)
    try {
      const ownerId = req.user?.role === 'CAR_WASH_ADMIN'
        ? req.user._id
        : (await User.findOne({ businessId: req.businessId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' }).select('_id').lean())?._id;
      if (ownerId) {
        const pushRes = await sendPushNotification({
          businessOwnerId: ownerId,
          title: 'Package purchased',
          body: `${customer?.name || 'Customer'} purchased ${tpl?.name || 'a package'}.`,
          data: { type: 'package_purchased', packageId: cp[0]._id, url: `/admin/packages/${cp[0]._id}` }
        });
        console.log('Push package_purchased:', pushRes);
      }
    } catch (pushErr) {
      console.warn('Push notification error (package_purchased):', pushErr?.message || pushErr);
    }
  } catch (e) {
    console.error('Purchase package error:', e);
    try { await session.abortTransaction(); } catch {}
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    session.endSession();
  }
}

export async function closePackageSale(req, res) {
  try {
    const { id } = req.params; // customerPackageId
    const pkg = await CustomerPackage.findOne({ _id: id, businessId: req.businessId }).lean();
    if (!pkg) return res.status(404).json({ success: false, message: 'Customer package not found' });

    const invoice = await Invoice.findOne({ businessId: req.businessId, saleType: 'PACKAGE', packageId: pkg._id });
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found for this package' });

    if (invoice.paymentStatus === 'RECEIVED') {
      return res.json({ success: true, invoice, message: 'Package already marked paid' });
    }

    try {
      const due = balanceDue(invoice.finalAmount, invoice.advancePayment);
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
  } catch (e) {
    console.error('Close package sale error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function getCustomerPackages(req, res) {
  try {
    const { customerId } = req.params;
    await refreshExpiredPackages(req.businessId);

    const q = { businessId: req.businessId, customerId };
    const status = req.query.status ? String(req.query.status) : '';
    if (status) q.status = status;
    if (String(req.query.remaining || '') === 'true') q.visitsRemaining = { $gt: 0 };

    const pkgs = await CustomerPackage.find(q).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: pkgs });
  } catch (e) {
    console.error('Get customer packages error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function listCustomerPackages(req, res) {
  try {
    await refreshExpiredPackages(req.businessId);
    const q = { businessId: req.businessId };
    if (req.query.status) q.status = String(req.query.status);
    if (String(req.query.remaining || '') === 'true') q.visitsRemaining = { $gt: 0 };

    const pkgs = await CustomerPackage.find(q)
      .sort({ createdAt: -1 })
      .populate('customerId', 'name phone email')
      .lean();

    const packageIds = pkgs.map((p) => p._id).filter(Boolean);
    const invoices = await Invoice.find({ businessId: req.businessId, saleType: 'PACKAGE', packageId: { $in: packageIds } })
      .select('packageId paymentStatus')
      .lean();
    const invoiceByPackageId = new Map();
    for (const inv of invoices) {
      invoiceByPackageId.set(String(inv.packageId), inv);
    }

    const customerIds = pkgs.map((p) => p.customerId?._id).filter(Boolean);
    const cars = await Car.find({ customerId: { $in: customerIds } })
      .select('customerId carNumber registrationNumber brand model')
      .lean();
    const carsByCustomerId = new Map();
    for (const c of cars) {
      const key = String(c.customerId);
      if (!carsByCustomerId.has(key)) carsByCustomerId.set(key, []);
      carsByCustomerId.get(key).push(c);
    }
    const out = pkgs.map((p) => {
      const cid = p.customerId?._id ? String(p.customerId._id) : null;
      const inv = invoiceByPackageId.get(String(p._id)) || null;
      return {
        ...p,
        customerCars: cid ? (carsByCustomerId.get(cid) || []) : [],
        invoiceId: inv?._id || null,
        invoicePaymentStatus: inv?.paymentStatus || null
      };
    });

    res.json({ success: true, data: out });
  } catch (e) {
    console.error('List customer packages error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function completeVisit(req, res) {
  const session = await mongoose.startSession();
  try {
    const { customerPackageId, bookingId, notes, servicesUsed, assignedTo, createWithoutImages, beforeImages, afterImages } = req.body;
    session.startTransaction();

    const pkg = await CustomerPackage.findOne({ _id: customerPackageId, businessId: req.businessId }).session(session);
    if (!pkg) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Customer package not found' });
    }

    await refreshExpiredPackages(req.businessId);
    if (pkg.status !== 'active') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Package is ${pkg.status}` });
    }
    if (pkg.expiryDate && new Date() > new Date(pkg.expiryDate)) {
      pkg.status = 'expired';
      await pkg.save({ session });
      await session.commitTransaction();
      return res.status(400).json({ success: false, message: 'Package expired' });
    }
    if (pkg.visitsRemaining <= 0) {
      pkg.status = 'completed';
      await pkg.save({ session });
      await session.commitTransaction();
      return res.status(400).json({ success: false, message: 'No visits remaining' });
    }

    const used = normalizeServicesUsed(servicesUsed);
    if (!used.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Select at least one service for this visit' });
    }

    // If there is a scheduled visit, complete the earliest scheduled one instead of creating new.
    const scheduled = await PackageVisit.findOne({
      businessId: req.businessId,
      customerPackageId: pkg._id,
      status: 'scheduled'
    }).sort({ date: 1, createdAt: 1 }).session(session);

    let visitDoc;
    if (scheduled) {
      scheduled.status = 'completed';
      scheduled.bookingId = bookingId || scheduled.bookingId;
      scheduled.notes = notes ? String(notes).trim() : scheduled.notes;
      scheduled.servicesUsed = used.length ? used : scheduled.servicesUsed;
      scheduled.assignedTo = assignedTo || scheduled.assignedTo || null;
      scheduled.createWithoutImages = !!createWithoutImages;
      scheduled.beforeImages = Array.isArray(beforeImages) ? beforeImages : (scheduled.beforeImages || []);
      scheduled.afterImages = Array.isArray(afterImages) ? afterImages : (scheduled.afterImages || []);
      if (!scheduled.scheduledFor) scheduled.scheduledFor = scheduled.date; // preserve original schedule
      scheduled.date = new Date(); // actual completion date
      await scheduled.save({ session });
      visitDoc = scheduled;
    } else {
      const created = await PackageVisit.create([{
        businessId: req.businessId,
        customerPackageId: pkg._id,
        bookingId: bookingId || undefined,
        date: new Date(),
        status: 'completed',
        notes: notes ? String(notes).trim() : undefined,
        servicesUsed: used,
        assignedTo: assignedTo || null,
        createWithoutImages: !!createWithoutImages,
        beforeImages: Array.isArray(beforeImages) ? beforeImages : [],
        afterImages: Array.isArray(afterImages) ? afterImages : []
      }], { session });
      visitDoc = created[0];
    }

    // Decrement remaining services + recompute totals
    const remainingMap = new Map((pkg.servicesRemaining || []).map((r) => [String(r.serviceId), r]));
    for (const u of used) {
      const key = String(u.serviceId);
      const row = remainingMap.get(key);
      if (!row) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'Selected service is not included in this package' });
      }
      if (Number(row.remaining || 0) < Number(u.quantity || 0)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'Not enough remaining count for selected service' });
      }
      row.remaining = Math.max(0, Number(row.remaining || 0) - Number(u.quantity || 0));
      remainingMap.set(key, row);
    }
    pkg.servicesRemaining = Array.from(remainingMap.values());
    const totalRemaining = (pkg.servicesRemaining || []).reduce((s, r) => s + Math.max(0, Number(r.remaining || 0)), 0);
    pkg.visitsUsed = Math.max(0, (Number(pkg.totalVisits || 0) - totalRemaining));
    pkg.visitsRemaining = totalRemaining;
    if (pkg.visitsRemaining === 0) pkg.status = 'completed';

    await pkg.save({ session });

    await session.commitTransaction();
    res.status(201).json({ success: true, data: { visit: visitDoc, customerPackage: pkg }, message: 'Visit completed' });

    // Push: owner always; employee only if visit assignedTo set
    try {
      const ownerId = req.user?.role === 'CAR_WASH_ADMIN'
        ? req.user._id
        : (await User.findOne({ businessId: req.businessId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' }).select('_id').lean())?._id;
      if (ownerId) {
        await sendPushNotification({
          businessOwnerId: ownerId,
          title: 'Visit completed',
          body: `${pkg?.name || 'Package'} · Remaining ${pkg?.visitsRemaining ?? 0}`,
          data: { type: 'visit_completed', packageId: pkg._id, url: `/admin/packages/${pkg._id}` }
        });
      }
      const empId = visitDoc?.assignedTo || null;
      if (empId) {
        await sendPushNotification({
          businessOwnerId: empId,
          title: 'Visit completed',
          body: `${pkg?.name || 'Package'} · Remaining ${pkg?.visitsRemaining ?? 0}`,
          data: { type: 'visit_completed', packageId: pkg._id, url: `/employee/packages/${pkg._id}` }
        });
      }
    } catch (e) {
      console.warn('Push error (visit completed):', e?.message || e);
    }
  } catch (e) {
    console.error('Complete visit error:', e);
    try { await session.abortTransaction(); } catch {}
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    session.endSession();
  }
}

export async function closeCustomerPackage(req, res) {
  try {
    const { id } = req.params;
    const pkg = await CustomerPackage.findOneAndUpdate(
      { _id: id, businessId: req.businessId },
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    if (!pkg) return res.status(404).json({ success: false, message: 'Customer package not found' });
    res.json({ success: true, data: pkg, message: 'Package cancelled' });
  } catch (e) {
    console.error('Close package error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function listVisits(req, res) {
  try {
    const { customerPackageId } = req.params;
    const visits = await PackageVisit.find({ businessId: req.businessId, customerPackageId })
      .sort({ date: -1, createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, data: visits });
  } catch (e) {
    console.error('List package visits error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function listScheduledVisits(req, res) {
  try {
    const includeOverdue = String(req.query.includeOverdue || '') === 'true';
    const days = Math.min(90, Math.max(1, Number(req.query.days || 30)));
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + days);

    const dateQuery = includeOverdue
      ? { $lte: end }
      : { $gte: now, $lte: end };

    const baseQuery = {
      businessId: req.businessId,
      status: 'scheduled',
      date: dateQuery
    };

    const visits = await PackageVisit.find(baseQuery)
      .populate({
        path: 'customerPackageId',
        select: 'name status visitsRemaining totalVisits customerId expiryDate',
        populate: { path: 'customerId', select: 'name phone email' }
      })
      .sort({ date: 1, createdAt: 1 })
      .limit(500)
      .lean();

    res.json({ success: true, data: visits, meta: { now, end, includeOverdue, days } });
  } catch (e) {
    console.error('List scheduled visits error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function getCustomerPackageDetail(req, res) {
  try {
    const { id } = req.params;
    await refreshExpiredPackages(req.businessId);

    const pkg = await CustomerPackage.findOne({ _id: id, businessId: req.businessId })
      .populate('customerId', 'name phone email')
      .lean();
    if (!pkg) return res.status(404).json({ success: false, message: 'Customer package not found' });

    const cars = await Car.find({ customerId: pkg.customerId?._id })
      .select('customerId carNumber registrationNumber brand model')
      .lean();

    const visits = await PackageVisit.find({ businessId: req.businessId, customerPackageId: pkg._id })
      .sort({ date: -1, createdAt: -1 })
      .limit(500)
      .lean();

    const invoice = await Invoice.findOne({ businessId: req.businessId, saleType: 'PACKAGE', packageId: pkg._id })
      .select('invoiceNumber paymentStatus paymentReceivedAt subtotal finalAmount createdAt')
      .lean();

    res.json({
      success: true,
      data: {
        customerPackage: { ...pkg, customerCars: cars },
        invoice: invoice || null,
        visits
      }
    });
  } catch (e) {
    console.error('Get customer package detail error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function scheduleVisit(req, res) {
  try {
    const { customerPackageId, date, notes, servicesUsed, assignedTo, createWithoutImages, beforeImages, afterImages } = req.body;
    const when = date ? new Date(date) : null;
    if (!when || isNaN(when.getTime())) {
      return res.status(400).json({ success: false, message: 'Valid date/time is required' });
    }

    await refreshExpiredPackages(req.businessId);
    const pkg = await CustomerPackage.findOne({ _id: customerPackageId, businessId: req.businessId }).lean();
    if (!pkg) return res.status(404).json({ success: false, message: 'Customer package not found' });
    if (pkg.status !== 'active') return res.status(400).json({ success: false, message: `Package is ${pkg.status}` });
    if (pkg.expiryDate && new Date() > new Date(pkg.expiryDate)) return res.status(400).json({ success: false, message: 'Package expired' });
    if (Number(pkg.visitsRemaining || 0) <= 0) return res.status(400).json({ success: false, message: 'No visits remaining' });

    const used = normalizeServicesUsed(servicesUsed);
    if (!used.length) return res.status(400).json({ success: false, message: 'Select at least one service for this visit' });

    // Enforce: at a time only ONE scheduled visit per customer package.
    // If a scheduled visit already exists, update it instead of creating a new one.
    const existing = await PackageVisit.findOne({
      businessId: req.businessId,
      customerPackageId,
      status: 'scheduled'
    }).sort({ date: 1, createdAt: 1 });

    if (existing) {
      existing.date = when;
      existing.scheduledFor = when;
      existing.notes = notes ? String(notes).trim() : existing.notes;
      existing.servicesUsed = used;
      existing.assignedTo = assignedTo || null;
      existing.createWithoutImages = !!createWithoutImages;
      existing.beforeImages = Array.isArray(beforeImages) ? beforeImages : [];
      existing.afterImages = Array.isArray(afterImages) ? afterImages : [];
      await existing.save();
      res.json({ success: true, data: existing, message: 'Scheduled visit updated' });

      // Push: owner always; assigned employee only if set
      try {
        const ownerId = req.user?.role === 'CAR_WASH_ADMIN'
          ? req.user._id
          : (await User.findOne({ businessId: req.businessId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' }).select('_id').lean())?._id;
        const whenText = existing?.date ? new Date(existing.date).toLocaleString() : 'scheduled';
        if (ownerId) {
          await sendPushNotification({
            businessOwnerId: ownerId,
            title: 'Visit scheduled',
            body: `${pkg?.name || 'Package'} · ${whenText}`,
            data: { type: 'visit_scheduled', packageId: pkg._id, url: `/admin/packages/${pkg._id}` }
          });
        }
        if (existing?.assignedTo) {
          await sendPushNotification({
            businessOwnerId: existing.assignedTo,
            title: 'Visit assigned',
            body: `${pkg?.name || 'Package'} · ${whenText}`,
            data: { type: 'visit_scheduled', packageId: pkg._id, url: `/employee/packages/${pkg._id}` }
          });
        }
      } catch (e) {
        console.warn('Push error (visit scheduled updated):', e?.message || e);
      }
      return;
    }

    const visit = await PackageVisit.create({
      businessId: req.businessId,
      customerPackageId,
      scheduledFor: when,
      date: when,
      status: 'scheduled',
      notes: notes ? String(notes).trim() : undefined,
      servicesUsed: used,
      assignedTo: assignedTo || null,
      createWithoutImages: !!createWithoutImages,
      beforeImages: Array.isArray(beforeImages) ? beforeImages : [],
      afterImages: Array.isArray(afterImages) ? afterImages : []
    });

    res.status(201).json({ success: true, data: visit, message: 'Visit scheduled' });

    // Push: owner always; assigned employee only if set
    try {
      const ownerId = req.user?.role === 'CAR_WASH_ADMIN'
        ? req.user._id
        : (await User.findOne({ businessId: req.businessId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' }).select('_id').lean())?._id;
      const whenText = visit?.date ? new Date(visit.date).toLocaleString() : 'scheduled';
      if (ownerId) {
        await sendPushNotification({
          businessOwnerId: ownerId,
          title: 'Visit scheduled',
          body: `${pkg?.name || 'Package'} · ${whenText}`,
          data: { type: 'visit_scheduled', packageId: pkg._id, url: `/admin/packages/${pkg._id}` }
        });
      }
      if (visit?.assignedTo) {
        await sendPushNotification({
          businessOwnerId: visit.assignedTo,
          title: 'Visit assigned',
          body: `${pkg?.name || 'Package'} · ${whenText}`,
          data: { type: 'visit_scheduled', packageId: pkg._id, url: `/employee/packages/${pkg._id}` }
        });
      }
    } catch (e) {
      console.warn('Push error (visit scheduled):', e?.message || e);
    }
  } catch (e) {
    console.error('Schedule visit error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

