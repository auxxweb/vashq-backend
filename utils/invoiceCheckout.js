import Customer from '../models/Customer.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import { recalculateInvoiceFinalAmount } from './jobServiceLines.js';
import { normalizeInvoicePaymentFields, roundMoney } from './invoicePayment.js';
import { normalizeCreditCheckoutPayment } from './creditPayment.js';

const LOCKED_FINANCIAL_KEYS = [
  'discount',
  'taxPercentage',
  'gstAmount',
  'loyaltyRedeemedPoints',
  'loyaltyRedeemedAmount',
  'paymentCashAmount',
  'paymentOnlineAmount',
  'allowPartialCheckout'
];

export function rejectLockedFinancialBodyFields(body) {
  for (const key of LOCKED_FINANCIAL_KEYS) {
    if (body[key] !== undefined) {
      const err = new Error('Discount, loyalty, line items, and payment amounts cannot be edited on the invoice');
      err.status = 403;
      throw err;
    }
  }
  if (body.finalAmount !== undefined) {
    const err = new Error('Discount, loyalty, line items, and payment amounts cannot be edited on the invoice');
    err.status = 403;
    throw err;
  }
}

async function applyLoyaltyRedemption(invoice, body, businessId) {
  const customerId = invoice.customerId;
  if (!customerId) {
    const err = new Error('Loyalty redemption requires a registered customer');
    err.status = 400;
    throw err;
  }

  const settings = await BusinessSettings.findOne({ businessId }).select('loyaltyPointValueInr').lean();
  const pointValue = Math.max(0, Number(settings?.loyaltyPointValueInr) || 0);

  let points = 0;
  let amount = 0;

  if (body.loyaltyRedeemedPoints !== undefined) {
    points = Math.max(0, Math.floor(Number(body.loyaltyRedeemedPoints) || 0));
    amount = pointValue > 0 ? roundMoney(points * pointValue) : 0;
  } else {
    amount = roundMoney(Math.max(0, Number(body.loyaltyRedeemedAmount) || 0));
    points = pointValue > 0 ? Math.floor(amount / pointValue) : 0;
    amount = pointValue > 0 ? roundMoney(points * pointValue) : amount;
  }

  if (points === 0) {
    invoice.loyaltyRedeemedPoints = 0;
    invoice.loyaltyRedeemedAmount = 0;
    return;
  }

  if (pointValue <= 0) {
    const err = new Error('Loyalty point value is not configured in Settings');
    err.status = 400;
    throw err;
  }

  const customer = await Customer.findOne({ _id: customerId, businessId }).select('loyaltyPointsBalance').lean();
  if (points > (Number(customer?.loyaltyPointsBalance) || 0)) {
    const err = new Error('Not enough loyalty points available');
    err.status = 400;
    throw err;
  }

  const subtotal = Number(invoice.subtotal) || 0;
  const discountPct = Number(invoice.discount) || 0;
  const afterDiscount = subtotal * (1 - discountPct / 100);
  const gst = Number(invoice.gstAmount) || 0;
  const billBeforeLoyalty = roundMoney(afterDiscount + gst);
  if (amount > billBeforeLoyalty + 0.02) {
    const err = new Error('Loyalty redemption cannot exceed the bill amount');
    err.status = 400;
    throw err;
  }

  invoice.loyaltyRedeemedPoints = points;
  invoice.loyaltyRedeemedAmount = amount;
}

function recalcGstAmount(invoice) {
  const subtotal = Number(invoice.subtotal) || 0;
  const discountPct = Number(invoice.discount) || 0;
  const afterDiscount = subtotal * (1 - discountPct / 100);
  const taxPct = Number(invoice.taxPercentage) || 0;
  const hasGst = !!(invoice.companyGst && String(invoice.companyGst).trim() && taxPct > 0);
  invoice.gstAmount = hasGst ? roundMoney(afterDiscount * (taxPct / 100)) : 0;
}

/**
 * Apply discount, loyalty, GST, and checkout payment fields on an open (unpaid) invoice.
 */
export async function applyOpenInvoiceFinancialFields(invoice, body, businessId) {
  if (body.finalAmount !== undefined) {
    const err = new Error('Final amount is calculated automatically');
    err.status = 400;
    throw err;
  }

  if (body.discount !== undefined) {
    invoice.discount = Math.max(0, Math.min(100, Number(body.discount) || 0));
  }

  if (body.taxPercentage !== undefined) {
    invoice.taxPercentage = Math.max(0, Math.min(100, Number(body.taxPercentage) || 0));
  }

  if (body.gstAmount !== undefined) {
    invoice.gstAmount = roundMoney(Math.max(0, Number(body.gstAmount) || 0));
  } else if (body.taxPercentage !== undefined || body.discount !== undefined) {
    recalcGstAmount(invoice);
  }

  if (body.loyaltyRedeemedPoints !== undefined || body.loyaltyRedeemedAmount !== undefined) {
    await applyLoyaltyRedemption(invoice, body, businessId);
  }

  recalculateInvoiceFinalAmount(invoice);

  const hasPaymentUpdate =
    body.paymentMethod !== undefined ||
    body.paymentCashAmount !== undefined ||
    body.paymentOnlineAmount !== undefined;

  if (hasPaymentUpdate) {
    if (body.allowPartialCheckout === true) {
      normalizeCreditCheckoutPayment(invoice, body);
    } else {
      normalizeInvoicePaymentFields(invoice, body);
    }
  }

  return invoice;
}
