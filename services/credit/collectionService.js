import mongoose from 'mongoose';
import Job from '../../models/Job.model.js';
import Customer from '../../models/Customer.model.js';
import Service from '../../models/Service.model.js';
import Invoice from '../../models/Invoice.model.js';
import PaymentCollection, { generateCollectionNumber } from '../../models/PaymentCollection.model.js';
import {
  isCreditSettlementMode,
  normalizeCreditCheckoutPayment,
  normalizeCollectionPayment,
  parseCreditDueDate,
  roundMoney
} from '../../utils/creditPayment.js';
import {
  applyCollectionToInvoice,
  computeOutstanding,
  getCheckoutTotal,
  getTotalCollected,
  isOpenCreditInvoice,
  sortInvoicesFifo,
  sumCustomerOutstanding,
  syncInvoiceOutstanding
} from './outstandingService.js';
import { appendCreditLedgerEvent } from './creditLedgerService.js';

const EPS = 0.02;

async function allocateCollectionNumber(businessId, session) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const collectionNumber = generateCollectionNumber();
    const exists = await PaymentCollection.findOne({ businessId, collectionNumber })
      .select('_id')
      .session(session)
      .lean();
    if (!exists) return collectionNumber;
  }
  const err = new Error('Could not generate unique collection number');
  err.status = 500;
  throw err;
}

/** Fix legacy rows missing collectionNumber (unique index rejects duplicate null). */
async function backfillMissingCollectionNumbers(businessId, session) {
  const rows = await PaymentCollection.find({
    businessId,
    $or: [
      { collectionNumber: null },
      { collectionNumber: '' },
      { collectionNumber: { $exists: false } }
    ]
  }).session(session);

  for (const row of rows) {
    row.collectionNumber = await allocateCollectionNumber(businessId, session);
    await row.save({ session });
  }
}

/**
 * Pure FIFO allocation across open invoices. Returns allocation rows.
 */
export function allocateFifo(invoices, amount, preferInvoiceId = null) {
  const total = roundMoney(amount);
  if (total <= EPS) {
    const err = new Error('Collection amount must be greater than zero');
    err.status = 400;
    throw err;
  }

  const open = sortInvoicesFifo(
    invoices.filter((inv) => isOpenCreditInvoice(inv) || computeOutstanding(inv) > EPS)
  );

  let remaining = total;
  const allocations = [];

  const pushAlloc = (inv, applied) => {
    if (applied <= EPS) return;
    allocations.push({
      invoiceId: inv._id,
      invoiceNumber: inv.invoiceNumber,
      amount: applied
    });
    remaining = roundMoney(remaining - applied);
  };

  if (preferInvoiceId) {
    const preferred = open.find((inv) => String(inv._id) === String(preferInvoiceId));
    if (preferred) {
      const outstanding = computeOutstanding(preferred);
      pushAlloc(preferred, roundMoney(Math.min(remaining, outstanding)));
    }
  }

  for (const inv of open) {
    if (remaining <= EPS) break;
    if (preferInvoiceId && String(inv._id) === String(preferInvoiceId)) continue;
    const outstanding = computeOutstanding(inv);
    if (outstanding <= EPS) continue;
    pushAlloc(inv, roundMoney(Math.min(remaining, outstanding)));
  }

  if (remaining > EPS) {
    const err = new Error('Collection amount exceeds customer outstanding balance');
    err.status = 400;
    throw err;
  }

  return allocations;
}

/**
 * Validate manual allocation rows against open invoices.
 */
export function validateManualAllocations(invoices, manualAllocations, amount) {
  const total = roundMoney(amount);
  if (!Array.isArray(manualAllocations) || !manualAllocations.length) {
    const err = new Error('Manual allocations are required');
    err.status = 400;
    throw err;
  }

  const merged = new Map();
  for (const row of manualAllocations) {
    const id = String(row.invoiceId);
    merged.set(id, roundMoney((merged.get(id) || 0) + (Number(row.amount) || 0)));
  }

  const byId = new Map(invoices.map((inv) => [String(inv._id), inv]));
  let sum = 0;
  const allocations = [];

  for (const [invoiceId, appliedRaw] of merged.entries()) {
    const inv = byId.get(invoiceId);
    if (!inv) {
      const err = new Error('Invalid invoice in manual allocation');
      err.status = 400;
      throw err;
    }
    const outstanding = computeOutstanding(inv);
    const applied = roundMoney(appliedRaw);
    if (applied <= EPS) {
      const err = new Error('Each allocation must be greater than zero');
      err.status = 400;
      throw err;
    }
    if (applied > outstanding + EPS) {
      const err = new Error(`Allocation exceeds outstanding for invoice ${inv.invoiceNumber || inv._id}`);
      err.status = 400;
      throw err;
    }
    sum = roundMoney(sum + applied);
    allocations.push({
      invoiceId: inv._id,
      invoiceNumber: inv.invoiceNumber,
      amount: applied
    });
  }

  if (Math.abs(sum - total) > EPS) {
    const err = new Error('Manual allocations must sum to collection amount');
    err.status = 400;
    throw err;
  }

  return allocations;
}

export async function loadOpenInvoicesForCustomer(businessId, customerId, session) {
  const query = Invoice.find({
    businessId,
    customerId,
    settlementMode: 'CREDIT',
    saleConfirmedAt: { $ne: null },
    outstandingAmount: { $gt: EPS }
  }).sort({ saleConfirmedAt: 1, createdAt: 1 });

  if (session) query.session(session);
  return query.exec();
}

export async function recordCollection({
  businessId,
  customerId,
  amount,
  paymentMethod,
  paymentCashAmount,
  paymentOnlineAmount,
  allocationMode = 'FIFO',
  manualAllocations,
  preferInvoiceId,
  notes,
  collectedBy,
  idempotencyKey,
  collectionDate
}) {
  if (!mongoose.isValidObjectId(String(customerId))) {
    const err = new Error('Valid customer is required for collections');
    err.status = 400;
    throw err;
  }

  const payment = normalizeCollectionPayment(amount, paymentMethod, {
    paymentCashAmount,
    paymentOnlineAmount
  });

  if (idempotencyKey) {
    const existing = await PaymentCollection.findOne({ businessId, idempotencyKey }).lean();
    if (existing) {
      return { collection: existing, duplicate: true };
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    if (idempotencyKey) {
      const existingInTx = await PaymentCollection.findOne({ businessId, idempotencyKey }).session(session).lean();
      if (existingInTx) {
        await session.abortTransaction();
        return { collection: existingInTx, duplicate: true };
      }
    }

    const customer = await Customer.findOne({ _id: customerId, businessId }).session(session).select('_id').lean();
    if (!customer) {
      const err = new Error('Customer not found');
      err.status = 404;
      throw err;
    }

    await backfillMissingCollectionNumbers(businessId, session);

    const openInvoices = await loadOpenInvoicesForCustomer(businessId, customerId, session);
    const customerOutstanding = sumCustomerOutstanding(openInvoices);

    if (customerOutstanding <= EPS) {
      const err = new Error('Customer has no outstanding balance');
      err.status = 400;
      throw err;
    }
    if (payment.amount > customerOutstanding + EPS) {
      const err = new Error('Collection amount exceeds customer outstanding balance');
      err.status = 400;
      throw err;
    }

    const mode = String(allocationMode || 'FIFO').toUpperCase();
    const allocations = mode === 'MANUAL'
      ? validateManualAllocations(openInvoices, manualAllocations, payment.amount)
      : allocateFifo(openInvoices, payment.amount, preferInvoiceId || null);

    for (const alloc of allocations) {
      const inv = await Invoice.findOne({
        _id: alloc.invoiceId,
        businessId,
        customerId
      }).session(session);
      if (!inv) {
        const err = new Error('Invoice not found during allocation');
        err.status = 400;
        throw err;
      }
      const liveOutstanding = computeOutstanding(inv);
      if (alloc.amount > liveOutstanding + EPS) {
        const err = new Error(`Invoice ${inv.invoiceNumber || inv._id} balance changed; refresh and try again`);
        err.status = 409;
        throw err;
      }
      applyCollectionToInvoice(inv, alloc.amount);
      await inv.save({ session });

      await appendCreditLedgerEvent({
        businessId,
        customerId,
        invoiceId: inv._id,
        eventType: 'PAYMENT_COLLECTED',
        amount: alloc.amount,
        metadata: {
          invoiceNumber: inv.invoiceNumber,
          allocationMode: mode,
          preferInvoiceId: preferInvoiceId ? String(preferInvoiceId) : undefined
        },
        notes,
        createdBy: collectedBy,
        session
      });
    }

    const collectionNumber = await allocateCollectionNumber(businessId, session);

    const collection = new PaymentCollection({
      businessId,
      customerId,
      collectionNumber,
      amount: payment.amount,
      paymentMethod: payment.paymentMethod,
      paymentCashAmount: payment.paymentCashAmount,
      paymentOnlineAmount: payment.paymentOnlineAmount,
      allocationMode: mode,
      allocations,
      notes: notes || undefined,
      collectedBy,
      idempotencyKey: idempotencyKey || undefined,
      collectionDate: collectionDate ? new Date(collectionDate) : new Date()
    });

    await collection.save({ session });

    await session.commitTransaction();

    return { collection: collection.toObject(), duplicate: false };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

export { sumCustomerOutstanding, getTotalCollected, computeOutstanding };
