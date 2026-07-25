/** Online channel under paymentMethod ONLINE / SPLIT. */
import BusinessSettings from '../models/BusinessSettings.model.js';

export const ONLINE_PAYMENT_MODES = ['UPI', 'CARD'];
export const DEFAULT_ONLINE_PAYMENT_MODE = 'UPI';

/**
 * Normalize online payment mode.
 * @param {unknown} raw
 * @param {{ cardEnabled?: boolean }} [opts] — when cardEnabled is false, CARD is coerced to UPI
 */
export function resolveOnlinePaymentMode(raw, { cardEnabled = false } = {}) {
  const m = String(raw || '').trim().toUpperCase();
  if (m === 'CARD') {
    return cardEnabled ? 'CARD' : DEFAULT_ONLINE_PAYMENT_MODE;
  }
  return DEFAULT_ONLINE_PAYMENT_MODE;
}

/** Reject CARD when the business has not enabled card payments. */
export function assertOnlinePaymentModeAllowed(mode, cardEnabled) {
  if (String(mode).toUpperCase() === 'CARD' && !cardEnabled) {
    const err = new Error('Card payment is not enabled. Turn on Card payments in Settings → Preferences.');
    err.status = 400;
    throw err;
  }
}

export function onlinePaymentModeLabel(mode) {
  return String(mode).toUpperCase() === 'CARD' ? 'Card' : 'UPI';
}

/** Whether onlinePaymentMode applies for this payment method. */
export function paymentUsesOnlineChannel(paymentMethod) {
  return paymentMethod === 'ONLINE' || paymentMethod === 'SPLIT';
}

export async function getCardPaymentEnabled(businessId) {
  if (!businessId) return false;
  const s = await BusinessSettings.findOne({ businessId }).select('cardPaymentEnabled').lean();
  return !!s?.cardPaymentEnabled;
}
