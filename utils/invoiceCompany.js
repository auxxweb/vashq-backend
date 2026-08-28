import mongoose from 'mongoose';
import Business from '../models/Business.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Branch from '../models/Branch.model.js';
import BranchSettings from '../models/BranchSettings.model.js';

function normalizeBusinessId(businessId) {
  if (!businessId) return null;
  const id = businessId._id ?? businessId;
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  return id;
}

function normalizeId(value) {
  if (!value) return null;
  const id = value._id ?? value;
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  return id;
}

function pickNonEmpty(...values) {
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

/**
 * Business + settings fields used on invoices (public view & creation snapshot).
 * Non-default branches use THEIR address/phone/location (no silent fallback to main shop).
 */
export async function getInvoiceCompanySnapshot(businessId, options = {}) {
  const id = normalizeBusinessId(businessId);
  if (!id) return null;
  const branchId = normalizeId(options.branchId);

  const [business, settings, branch, branchSettings] = await Promise.all([
    Business.findById(id)
      .select('businessName ownerName logo phone whatsappNumber email address location workingHoursStart workingHoursEnd')
      .lean(),
    BusinessSettings.findOne({ businessId: id })
      .select('gstNumber taxPercentage upiId qrCodeImage paymentMobileNumber showPaymentQrOnInvoice')
      .lean(),
    branchId
      ? Branch.findOne({ _id: branchId, businessId: id })
          .select('name address phone email location workingHoursStart workingHoursEnd isDefault')
          .lean()
      : Promise.resolve(null),
    branchId
      ? BranchSettings.findOne({ businessId: id, branchId })
          .select('gstNumber taxPercentage upiId qrCodeImage paymentMobileNumber')
          .lean()
      : Promise.resolve(null)
  ]);
  if (!business) return null;

  const branchName = pickNonEmpty(branch?.name);
  const isMainBranch = !branch || branch.isDefault === true;
  const displayName = !isMainBranch && branchName
    ? `${pickNonEmpty(business.businessName) || 'Shop'} - ${branchName}`
    : pickNonEmpty(business.businessName);

  // Main / default: branch fields overlay business. Other branches: branch-only for contact/address.
  const address = isMainBranch
    ? pickNonEmpty(branch?.address, business.address)
    : pickNonEmpty(branch?.address);
  const phone = isMainBranch
    ? pickNonEmpty(branch?.phone, business.phone)
    : pickNonEmpty(branch?.phone, business.phone);
  const email = isMainBranch
    ? pickNonEmpty(branch?.email, business.email)
    : pickNonEmpty(branch?.email, business.email);
  const location = isMainBranch
    ? pickNonEmpty(branch?.location, business.location)
    : pickNonEmpty(branch?.location);
  const workingHoursStart = isMainBranch
    ? pickNonEmpty(branch?.workingHoursStart, business.workingHoursStart)
    : pickNonEmpty(branch?.workingHoursStart, business.workingHoursStart);
  const workingHoursEnd = isMainBranch
    ? pickNonEmpty(branch?.workingHoursEnd, business.workingHoursEnd)
    : pickNonEmpty(branch?.workingHoursEnd, business.workingHoursEnd);

  return {
    businessName: displayName,
    ownerName: business.ownerName || '',
    logo: business.logo || null,
    phone,
    whatsappNumber: business.whatsappNumber || '',
    email,
    address,
    location,
    workingHoursStart,
    workingHoursEnd,
    gstNumber: pickNonEmpty(branchSettings?.gstNumber, settings?.gstNumber),
    taxPercentage: branchSettings?.taxPercentage != null && branchSettings?.taxPercentage !== ''
      ? Number(branchSettings.taxPercentage)
      : (settings?.taxPercentage != null ? Number(settings.taxPercentage) : null),
    upiId: pickNonEmpty(branchSettings?.upiId, settings?.upiId),
    qrCodeImage: pickNonEmpty(branchSettings?.qrCodeImage, settings?.qrCodeImage),
    paymentMobileNumber: pickNonEmpty(branchSettings?.paymentMobileNumber, settings?.paymentMobileNumber),
    showPaymentQrOnInvoice: settings?.showPaymentQrOnInvoice === true,
    branchId: branch?._id || null,
    branchName: branchName || '',
    isDefaultBranch: isMainBranch
  };
}

/** Resolved company block for display (live snapshot preferred over stale invoice fields). */
export function resolveInvoiceCompany(invoice, business) {
  const b = business || {};
  const hours =
    b.workingHoursStart && b.workingHoursEnd
      ? `${b.workingHoursStart} – ${b.workingHoursEnd}`
      : '';
  // Prefer live branch-aware snapshot when present so invoices don't keep a stale main address
  const hasLiveProfile = !!(b.businessName || b.address || b.branchId || b.branchName);
  const isNonDefaultBranch = b.isDefaultBranch === false;
  return {
    name: (hasLiveProfile
      ? (b.businessName || invoice?.companyName || '')
      : (invoice?.companyName || b.businessName || '')
    ).trim(),
    ownerName: (invoice?.companyOwnerName || b.ownerName || '').trim(),
    address: (hasLiveProfile
      ? (isNonDefaultBranch
          ? (b.address || '')
          : (b.address || invoice?.companyAddress || ''))
      : (invoice?.companyAddress || b.address || '')
    ).trim(),
    phone: (hasLiveProfile
      ? (b.phone || invoice?.companyPhone || b.whatsappNumber || '')
      : (invoice?.companyPhone || b.phone || b.whatsappNumber || '')
    ).trim(),
    whatsapp: (b.whatsappNumber || '').trim(),
    email: (b.email || '').trim(),
    location: (b.location || '').trim(),
    workingHours: hours,
    gst: (hasLiveProfile
      ? (b.gstNumber || invoice?.companyGst || '')
      : (invoice?.companyGst || b.gstNumber || '')
    ).trim(),
    logo: b.logo || null,
    upiId: (b.upiId || '').trim(),
    qrCodeImage: (b.qrCodeImage || '').trim(),
    paymentMobileNumber: (b.paymentMobileNumber || '').trim(),
    showPaymentQrOnInvoice: b.showPaymentQrOnInvoice === true,
    branchName: (b.branchName || '').trim()
  };
}

/**
 * Always apply live company snapshot onto invoice company fields for display.
 * Fixes invoices that still store the main-shop address after branch differentiation.
 */
export function applyLiveCompanySnapshot(invoice, snapshot) {
  if (!invoice) return invoice;
  if (!snapshot) return { ...invoice };
  return {
    ...invoice,
    companyName: (snapshot.businessName || invoice.companyName || '').trim() || null,
    companyOwnerName: (invoice.companyOwnerName || snapshot.ownerName || '').trim() || null,
    companyAddress: (snapshot.address || '').trim() || null,
    companyPhone: (snapshot.phone || snapshot.whatsappNumber || invoice.companyPhone || '').trim() || null,
    companyGst: (snapshot.gstNumber || invoice.companyGst || '').trim() || null
  };
}

/** Merge business profile into invoice fields for display/storage (fill empties only). */
export function mergeInvoiceWithCompanySnapshot(invoice, snapshot) {
  if (!invoice) return invoice;
  if (!snapshot) return { ...invoice };
  return applyLiveCompanySnapshot(invoice, snapshot);
}

/** Fields to persist so stored invoice matches live branch/main profile. */
export function companyFieldsToPersist(invoice, snapshot) {
  if (!invoice || !snapshot) return null;
  const $set = {};
  const nextName = String(snapshot.businessName || '').trim();
  const nextAddress = String(snapshot.address || '').trim();
  const nextPhone = String(snapshot.phone || snapshot.whatsappNumber || '').trim();
  const nextGst = String(snapshot.gstNumber || '').trim();

  if (nextName && nextName !== String(invoice.companyName || '').trim()) {
    $set.companyName = nextName;
  }
  if (nextAddress !== String(invoice.companyAddress || '').trim()) {
    $set.companyAddress = nextAddress || null;
  }
  if (nextPhone && nextPhone !== String(invoice.companyPhone || '').trim()) {
    $set.companyPhone = nextPhone;
  }
  if (nextGst && nextGst !== String(invoice.companyGst || '').trim()) {
    $set.companyGst = nextGst;
  }
  return Object.keys($set).length ? $set : null;
}
