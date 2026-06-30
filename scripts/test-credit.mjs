import {
  assertPartialSettlementValid,
  normalizeCreditCheckoutPayment,
  normalizeCollectionPayment,
  isCreditSettlementMode,
  parseCreditDueDate
} from '../utils/creditPayment.js';
import {
  computeOutstanding,
  deriveCollectionDisplayStatus,
  getCheckoutTotal,
  getTotalCollected,
  syncInvoiceOutstanding,
  applyCollectionToInvoice,
  sumCustomerOutstanding,
  COLLECTION_STATUS
} from '../services/credit/outstandingService.js';
import {
  allocateFifo,
  validateManualAllocations
} from '../services/credit/collectionService.js';
import { applyCreditCloseToInvoice } from '../services/credit/creditInvoiceService.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function mockInvoice(overrides = {}) {
  return {
    _id: overrides._id || 'inv1',
    invoiceNumber: overrides.invoiceNumber || 'INV-001',
    finalAmount: 1000,
    advancePayment: 0,
    paymentMethod: 'CASH',
    paymentCashAmount: 0,
    paymentOnlineAmount: 0,
    settlementMode: 'FULL',
    saleConfirmedAt: null,
    amountCollectedAtCheckout: 0,
    amountCollectedLater: 0,
    outstandingAmount: 0,
    paymentStatus: 'PENDING',
    paymentReceivedAt: null,
    createdAt: new Date('2026-01-01'),
    ...overrides
  };
}

// --- creditPayment ---
assert(isCreditSettlementMode({ settlementMode: 'CREDIT' }), 'credit mode detect');
assert(!isCreditSettlementMode({ settlementMode: 'FULL' }), 'full mode detect');

let inv = mockInvoice({ finalAmount: 1000, advancePayment: 200, paymentMethod: 'CASH' });
normalizeCreditCheckoutPayment(inv, { paymentCashAmount: 400 });
assert(inv.paymentCashAmount === 400 && inv.paymentOnlineAmount === 0, 'partial cash checkout');
assertPartialSettlementValid('CASH', 800, 400, 0);

let threw = false;
try {
  assertPartialSettlementValid('CASH', 800, 900, 0);
} catch {
  threw = true;
}
assert(threw, 'over collection at checkout rejected');

threw = false;
try {
  normalizeCreditCheckoutPayment(mockInvoice({ finalAmount: 1000, advancePayment: 0 }), {
    paymentMethod: 'SPLIT',
    paymentCashAmount: 600,
    paymentOnlineAmount: 500
  });
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'split exceeding due rejected');

const coll = normalizeCollectionPayment(350, 'SPLIT', {
  paymentCashAmount: 200,
  paymentOnlineAmount: 150
});
assert(coll.amount === 350 && coll.paymentCashAmount === 200, 'collection split normalize');

threw = false;
try {
  normalizeCollectionPayment(0, 'CASH', {});
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'zero collection rejected');

assert(parseCreditDueDate('2026-12-31') instanceof Date, 'due date parse');

// --- outstandingService ---
inv = mockInvoice({ finalAmount: 1000, advancePayment: 200 });
applyCreditCloseToInvoice(inv, { paymentCashAmount: 400, settlementMode: 'CREDIT' });
assert(inv.settlementMode === 'CREDIT', 'credit mode set');
assert(getTotalCollected(inv) === 600, 'total collected 200+400');
assert(computeOutstanding(inv) === 400, 'outstanding 400');
assert(
  deriveCollectionDisplayStatus(inv) === COLLECTION_STATUS.PARTIALLY_PAID,
  'partially paid status'
);

applyCollectionToInvoice(inv, 400);
assert(computeOutstanding(inv) === 0, 'fully collected');
assert(inv.paymentStatus === 'RECEIVED', 'marked received when paid');
assert(deriveCollectionDisplayStatus(inv) === COLLECTION_STATUS.PAID, 'paid status');

inv = mockInvoice({ finalAmount: 1000 });
applyCreditCloseToInvoice(inv, { paymentCashAmount: 0 });
assert(computeOutstanding(inv) === 1000, 'full outstanding');
assert(deriveCollectionDisplayStatus(inv) === COLLECTION_STATUS.OUTSTANDING, 'outstanding status');

// --- FIFO allocation (spec example) ---
const fifoInvoices = [];
for (let i = 1; i <= 10; i++) {
  const row = mockInvoice({
    _id: `inv${i}`,
    invoiceNumber: `INV${String(i).padStart(3, '0')}`,
    finalAmount: 100,
    createdAt: new Date(`2026-01-${String(i).padStart(2, '0')}`)
  });
  applyCreditCloseToInvoice(row, { paymentCashAmount: 0 });
  row.saleConfirmedAt = new Date(`2026-01-${String(i).padStart(2, '0')}`);
  fifoInvoices.push(row);
}

const fifoAlloc = allocateFifo(fifoInvoices, 350);
assert(fifoAlloc.length === 4, 'FIFO applies to 4 invoices');
assert(fifoAlloc[0].amount === 100 && fifoAlloc[1].amount === 100, 'INV001 INV002 full');
assert(fifoAlloc[2].amount === 100 && fifoAlloc[3].amount === 50, 'INV003 full INV004 partial');

let remainingOutstanding = 0;
const appliedMap = new Map(fifoAlloc.map((a) => [a.invoiceId, a.amount]));
for (const row of fifoInvoices) {
  const applied = appliedMap.get(row._id) || 0;
  const copy = { ...row };
  if (applied > 0) applyCollectionToInvoice(copy, applied);
  remainingOutstanding += computeOutstanding(copy);
}
assert(remainingOutstanding === 650, 'FIFO leaves 650 outstanding');

threw = false;
try {
  allocateFifo(fifoInvoices, 1001);
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'FIFO over-collection rejected');

// --- manual allocation ---
const manualInvoices = fifoInvoices.slice(0, 3).map((row) => ({ ...row }));
const manual = validateManualAllocations(manualInvoices, [
  { invoiceId: 'inv1', amount: 50 },
  { invoiceId: 'inv2', amount: 50 }
], 100);
assert(manual.length === 2 && manual[0].amount === 50, 'manual allocation valid');

threw = false;
try {
  validateManualAllocations(manualInvoices, [
    { invoiceId: 'inv1', amount: 60 },
    { invoiceId: 'inv2', amount: 50 }
  ], 100);
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'manual sum mismatch rejected');

threw = false;
try {
  validateManualAllocations(manualInvoices, [
    { invoiceId: 'inv1', amount: 150 }
  ], 150);
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'manual over invoice outstanding rejected');

// --- duplicate credit close guard ---
inv = mockInvoice({ finalAmount: 500 });
applyCreditCloseToInvoice(inv, { paymentCashAmount: 100 });
threw = false;
try {
  applyCreditCloseToInvoice(inv, { paymentCashAmount: 50 });
} catch (e) {
  threw = e.status === 409;
}
assert(threw, 'duplicate credit close rejected');

// --- FIFO prefers target invoice first ---
const preferInvoices = fifoInvoices.slice(0, 4).map((row) => ({ ...row }));
const preferAlloc = allocateFifo(preferInvoices, 150, 'inv3');
assert(preferAlloc[0].invoiceId === 'inv3' && preferAlloc[0].amount === 100, 'prefer invoice paid first');
assert(preferAlloc[1].invoiceId === 'inv1' && preferAlloc[1].amount === 50, 'remainder FIFO oldest');

// --- manual allocation merges duplicate rows ---
const merged = validateManualAllocations(manualInvoices, [
  { invoiceId: 'inv1', amount: 30 },
  { invoiceId: 'inv1', amount: 20 },
  { invoiceId: 'inv2', amount: 50 }
], 100);
assert(merged.find((m) => m.invoiceId === 'inv1')?.amount === 50, 'duplicate manual rows merged');

// --- customer aggregate ---
const aggInvoices = [
  mockInvoice({ finalAmount: 500 }),
  mockInvoice({ finalAmount: 300 })
];
for (const row of aggInvoices) {
  applyCreditCloseToInvoice(row, { paymentCashAmount: 0 });
}
assert(sumCustomerOutstanding(aggInvoices) === 800, 'customer outstanding sum');

// --- legacy invoice unchanged ---
const legacy = mockInvoice({ paymentStatus: 'RECEIVED', settlementMode: 'FULL' });
assert(deriveCollectionDisplayStatus(legacy) === COLLECTION_STATUS.PAID, 'legacy paid');
assert(deriveCollectionDisplayStatus(mockInvoice()) === null, 'pending non-credit null status');

console.log('credit module tests passed');
