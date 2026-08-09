import Customer from '../models/Customer.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import { recalculateInvoiceFinalAmount } from './jobServiceLines.js';
import { normalizeInvoicePaymentFields, roundMoney } from './invoicePayment.js';
import { normalizeCreditCheckoutPayment } from './creditPayment.js';
import { applyInvoiceDiscountFields, resolveInvoiceDiscount } from './invoiceDiscount.js';
import { applyComputedGstAmount, ensureInvoiceGstSettings } from './invoiceGst.js';

const LOCKED_FINANCIAL_KEYS = [
  'discount',
  'discountType',
  'discountAmount',
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

  const { afterDiscount } = resolveInvoiceDiscount(invoice);
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

/**
 * Apply discount, loyalty, GST, and checkout payment fields on an open (unpaid) invoice.
 */
export async function applyOpenInvoiceFinancialFields(invoice, body, businessId) {
  if (body.finalAmount !== undefined) {
    const err = new Error('Final amount is calculated automatically');
    err.status = 400;
    throw err;
  }

  // GST-enabled shops: fill missing tax % / GSTIN from settings before totals/payment
  await ensureInvoiceGstSettings(invoice, businessId);

  const discountTouched =
    body.discount !== undefined ||
    body.discountType !== undefined ||
    body.discountAmount !== undefined;

  if (discountTouched) {
    const settings = await BusinessSettings.findOne({ businessId })
      .select('invoiceDiscountAmountEnabled')
      .lean();
    applyInvoiceDiscountFields(invoice, body, {
      amountModeEnabled: !!settings?.invoiceDiscountAmountEnabled
    });
  }

  if (body.taxPercentage !== undefined) {
    invoice.taxPercentage = Math.max(0, Math.min(100, Number(body.taxPercentage) || 0));
  }

  // GST on amount-after-discount (loyalty is applied after tax, matching the UI)
  if (body.gstAmount !== undefined) {
    invoice.gstAmount = roundMoney(Math.max(0, Number(body.gstAmount) || 0));
  } else {
    applyComputedGstAmount(invoice);
  }

  const loyaltyTouched =
    body.loyaltyRedeemedPoints !== undefined || body.loyaltyRedeemedAmount !== undefined;

  if (loyaltyTouched) {
    await applyLoyaltyRedemption(invoice, body, businessId);
  }

  recalculateInvoiceFinalAmount(invoice);

  const hasPaymentUpdate =
    body.paymentMethod !== undefined ||
    body.paymentCashAmount !== undefined ||
    body.paymentOnlineAmount !== undefined ||
    body.onlinePaymentMode !== undefined;

  if (hasPaymentUpdate) {
    const { getCardPaymentEnabled } = await import('./onlinePaymentMode.js');
    const cardEnabled = await getCardPaymentEnabled(businessId);
    if (body.allowPartialCheckout === true) {
      normalizeCreditCheckoutPayment(invoice, body, { cardEnabled });
    } else {
      normalizeInvoicePaymentFields(invoice, body, { cardEnabled });
    }
  }

  return invoice;
}
