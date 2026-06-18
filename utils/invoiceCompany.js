import mongoose from 'mongoose';
import Business from '../models/Business.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';

function normalizeBusinessId(businessId) {
  if (!businessId) return null;
  const id = businessId._id ?? businessId;
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  return id;
}

/** Business + settings fields used on invoices (public view & creation snapshot). */
export async function getInvoiceCompanySnapshot(businessId) {
  const id = normalizeBusinessId(businessId);
  if (!id) return null;
  const [business, settings] = await Promise.all([
    Business.findById(id)
      .select('businessName ownerName logo phone whatsappNumber email address location workingHoursStart workingHoursEnd')
      .lean(),
    BusinessSettings.findOne({ businessId: id }).select('gstNumber').lean()
  ]);
  if (!business) return null;
  return {
    businessName: business.businessName || '',
    ownerName: business.ownerName || '',
    logo: business.logo || null,
    phone: business.phone || '',
    whatsappNumber: business.whatsappNumber || '',
    email: business.email || '',
    address: business.address || '',
    location: business.location || '',
    workingHoursStart: business.workingHoursStart || '',
    workingHoursEnd: business.workingHoursEnd || '',
    gstNumber: settings?.gstNumber || ''
  };
}

/** Resolved company block for display (invoice snapshot overrides business defaults). */
export function resolveInvoiceCompany(invoice, business) {
  const b = business || {};
  const hours =
    b.workingHoursStart && b.workingHoursEnd
      ? `${b.workingHoursStart} – ${b.workingHoursEnd}`
      : '';
  return {
    name: (invoice?.companyName || b.businessName || '').trim(),
    ownerName: (invoice?.companyOwnerName || b.ownerName || '').trim(),
    address: (invoice?.companyAddress || b.address || '').trim(),
    phone: (invoice?.companyPhone || b.phone || b.whatsappNumber || '').trim(),
    whatsapp: (b.whatsappNumber || '').trim(),
    email: (b.email || '').trim(),
    location: (b.location || '').trim(),
    workingHours: hours,
    gst: (invoice?.companyGst || b.gstNumber || '').trim(),
    logo: b.logo || null
  };
}

/** Merge business profile into invoice fields for display/storage. */
export function mergeInvoiceWithCompanySnapshot(invoice, snapshot) {
  if (!invoice) return invoice;
  if (!snapshot) return { ...invoice };
  return {
    ...invoice,
    companyName: (invoice.companyName || snapshot.businessName || '').trim() || null,
    companyOwnerName: (invoice.companyOwnerName || snapshot.ownerName || '').trim() || null,
    companyAddress: (invoice.companyAddress || snapshot.address || '').trim() || null,
    companyPhone: (invoice.companyPhone || snapshot.phone || snapshot.whatsappNumber || '').trim() || null,
    companyGst: (invoice.companyGst || snapshot.gstNumber || '').trim() || null
  };
}

/** Fields to persist when invoice was created without company snapshot. */
export function companyFieldsToPersist(invoice, snapshot) {
  if (!invoice || !snapshot) return null;
  const $set = {};
  if (!String(invoice.companyName || '').trim() && snapshot.businessName) {
    $set.companyName = snapshot.businessName;
  }
  if (!String(invoice.companyOwnerName || '').trim() && snapshot.ownerName) {
    $set.companyOwnerName = snapshot.ownerName;
  }
  if (!String(invoice.companyAddress || '').trim() && snapshot.address) {
    $set.companyAddress = snapshot.address;
  }
  const phone = snapshot.phone || snapshot.whatsappNumber;
  if (!String(invoice.companyPhone || '').trim() && phone) {
    $set.companyPhone = phone;
  }
  if (!String(invoice.companyGst || '').trim() && snapshot.gstNumber) {
    $set.companyGst = snapshot.gstNumber;
  }
  return Object.keys($set).length ? $set : null;
}
