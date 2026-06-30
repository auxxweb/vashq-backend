import CreditLedgerEvent from '../../models/CreditLedgerEvent.model.js';

export async function appendCreditLedgerEvent({
  businessId,
  customerId,
  invoiceId,
  collectionId,
  eventType,
  amount = 0,
  metadata = {},
  notes,
  createdBy,
  session
}) {
  const doc = new CreditLedgerEvent({
    businessId,
    customerId: customerId || undefined,
    invoiceId: invoiceId || undefined,
    collectionId: collectionId || undefined,
    eventType,
    amount: Math.max(0, Number(amount) || 0),
    metadata,
    notes: notes || undefined,
    createdBy: createdBy || undefined
  });

  if (session) {
    await doc.save({ session });
  } else {
    await doc.save();
  }

  return doc;
}
