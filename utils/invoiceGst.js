import BusinessSettings from '../models/BusinessSettings.model.js';
import { resolveInvoiceDiscount } from './invoiceDiscount.js';
import { roundMoney } from './invoicePayment.js';

/**
 * Compute GST on amount-after-discount when company GSTIN + tax % are set.
 */
export function computeInvoiceGstAmount(invoice) {
  const { afterDiscount } = resolveInvoiceDiscount(invoice);
  const taxPct = Number(invoice?.taxPercentage) || 0;
  const hasGst = !!(invoice?.companyGst && String(invoice.companyGst).trim() && taxPct > 0);
  return hasGst ? roundMoney(afterDiscount * (taxPct / 100)) : 0;
}

export function applyComputedGstAmount(invoice) {
  invoice.gstAmount = computeInvoiceGstAmount(invoice);
  return invoice.gstAmount;
}

/**
 * Ensure invoice has taxPercentage (and companyGst when available) from business settings
 * so checkout totals match the UI when GST is enabled.
 */
export async function ensureInvoiceGstSettings(invoice, businessId) {
  const needsTax =
    invoice.taxPercentage == null ||
    invoice.taxPercentage === '' ||
    !Number.isFinite(Number(invoice.taxPercentage));
  const needsGstin = !String(invoice.companyGst || '').trim();

  if (!needsTax && !needsGstin) {
    return invoice;
  }

  const settings = await BusinessSettings.findOne({ businessId })
    .select('gstNumber taxPercentage')
    .lean();

  if (needsGstin && settings?.gstNumber) {
    invoice.companyGst = String(settings.gstNumber).trim();
  }

  if (needsTax && String(invoice.companyGst || settings?.gstNumber || '').trim()) {
    if (settings?.taxPercentage != null && settings.taxPercentage !== '') {
      invoice.taxPercentage = Math.max(0, Math.min(100, Number(settings.taxPercentage) || 0));
    }
  }

  return invoice;
}

/**
 * Snapshot GST fields for a new invoice from company + settings.
 */
export async function buildGstFieldsForNewInvoice(businessId, { companyGst, subtotal } = {}) {
  const settings = await BusinessSettings.findOne({ businessId })
    .select('gstNumber taxPercentage')
    .lean();
  const gstin = String(companyGst || settings?.gstNumber || '').trim() || null;
  const taxPercentage =
    gstin && settings?.taxPercentage != null && settings.taxPercentage !== ''
      ? Math.max(0, Math.min(100, Number(settings.taxPercentage) || 0))
      : null;
  const hasGst = !!(gstin && taxPercentage > 0);
  const base = roundMoney(Math.max(0, Number(subtotal) || 0));
  const gstAmount = hasGst ? roundMoney(base * (taxPercentage / 100)) : 0;
  return {
    companyGst: gstin,
    taxPercentage: hasGst ? taxPercentage : null,
    gstAmount,
    finalAmount: roundMoney(base + gstAmount)
  };
}
