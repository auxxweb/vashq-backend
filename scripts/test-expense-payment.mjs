import {
  applyExpensePayablePayment,
  expenseCashOnline,
  expensePaidAmountAggregationExpr,
  expensePaymentStatusQuery,
  resolveExpensePaymentFields,
  sumExpenseChannelTotals,
} from '../utils/expensePayment.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- FULL (legacy unchanged) ---
let r = resolveExpensePaymentFields(500, { paymentMethod: 'CASH' });
assert(r.settlementMode === 'FULL' && r.outstandingAmount === 0 && r.paymentStatus === 'PAID', 'FULL defaults');
assert(r.paymentCashAmount === 500 && r.paymentOnlineAmount === 0, 'CASH split');

r = resolveExpensePaymentFields(300, { paymentMethod: 'ONLINE' });
assert(r.paymentOnlineAmount === 300 && r.paymentCashAmount === 0, 'ONLINE split');

r = resolveExpensePaymentFields(1000, {
  paymentMethod: 'SPLIT',
  paymentCashAmount: 400,
  paymentOnlineAmount: 600,
});
assert(r.paymentCashAmount === 400 && r.paymentOnlineAmount === 600, 'SPLIT both');

r = resolveExpensePaymentFields(250, { paymentMethod: 'SPLIT', paymentCashAmount: 100 });
assert(r.paymentCashAmount === 100 && r.paymentOnlineAmount === 150, 'SPLIT infer online');

// Body without settlementMode stays FULL (existing clients)
r = resolveExpensePaymentFields(250, { paymentMethod: 'ONLINE' });
assert(r.settlementMode === 'FULL' && r.paymentOnlineAmount === 250 && !r.creditDueDate, 'legacy body');

let threw = false;
try {
  resolveExpensePaymentFields(100, {
    paymentMethod: 'SPLIT',
    paymentCashAmount: 40,
    paymentOnlineAmount: 40,
  });
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'SPLIT mismatch throws');

threw = false;
try {
  resolveExpensePaymentFields(0, { paymentMethod: 'CASH' });
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'zero amount throws');

const legacy = { amount: 200, paymentMethod: 'CASH' };
const ch = expenseCashOnline(legacy);
assert(ch.cash === 200 && ch.online === 0, 'legacy CASH');

const totals = sumExpenseChannelTotals([
  { amount: 100, paymentMethod: 'CASH' },
  { amount: 200, paymentMethod: 'ONLINE', paymentCashAmount: 0, paymentOnlineAmount: 200 },
  { amount: 300, paymentMethod: 'SPLIT', paymentCashAmount: 100, paymentOnlineAmount: 200 },
]);
assert(totals.totalAmount === 600, 'total amount');
assert(totals.totalCashAmount === 200, 'total cash');
assert(totals.totalOnlineAmount === 400, 'total online');
assert(totals.totalOutstandingPayable === 0, 'no payable on FULL');

// --- CREDIT / pay-later ---
r = resolveExpensePaymentFields(1000, {
  settlementMode: 'CREDIT',
  amountPaidNow: 0,
  creditDueDate: '2026-08-01',
});
assert(r.settlementMode === 'CREDIT', 'credit mode');
assert(r.outstandingAmount === 1000 && r.paymentStatus === 'UNPAID', 'unpaid credit');
assert(r.paymentCashAmount === 0 && r.paymentOnlineAmount === 0, 'no cash out unpaid');
assert(r.creditDueDate instanceof Date, 'due date parsed');

r = resolveExpensePaymentFields(1000, {
  settlementMode: 'CREDIT',
  amountPaidNow: 250,
  paymentMethod: 'CASH',
});
assert(r.outstandingAmount === 750 && r.paymentStatus === 'PARTIAL', 'partial credit');
assert(r.paymentCashAmount === 250 && r.paymentOnlineAmount === 0, 'partial cash');

r = resolveExpensePaymentFields(500, {
  settlementMode: 'CREDIT',
  amountPaidNow: 500,
  paymentMethod: 'ONLINE',
});
assert(r.outstandingAmount === 0 && r.paymentStatus === 'PAID', 'credit paid in full still CREDIT');
assert(r.paymentOnlineAmount === 500, 'credit full online');

threw = false;
try {
  resolveExpensePaymentFields(100, { settlementMode: 'CREDIT', amountPaidNow: 150 });
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'paid now > amount throws');

r = resolveExpensePaymentFields(400, {
  settlementMode: 'CREDIT',
  amountPaidNow: 100,
  paymentMethod: 'SPLIT',
  paymentCashAmount: 40,
  paymentOnlineAmount: 60,
});
assert(r.paymentCashAmount === 40 && r.paymentOnlineAmount === 60 && r.outstandingAmount === 300, 'credit split');

const creditTotals = sumExpenseChannelTotals([
  { amount: 100, paymentMethod: 'CASH', settlementMode: 'FULL', paymentCashAmount: 100, paymentOnlineAmount: 0 },
  {
    amount: 500,
    settlementMode: 'CREDIT',
    outstandingAmount: 300,
    paymentCashAmount: 200,
    paymentOnlineAmount: 0,
    paymentMethod: 'CASH',
  },
]);
assert(creditTotals.totalCashAmount === 300, 'credit cash out is paid only');
assert(creditTotals.totalOutstandingPayable === 300, 'payable total');
assert(creditTotals.totalPaidAmount === 300, 'paid amount');

// Settle payable
const expenseDoc = {
  settlementMode: 'CREDIT',
  amount: 500,
  outstandingAmount: 300,
  paymentCashAmount: 200,
  paymentOnlineAmount: 0,
  paymentMethod: 'CASH',
  paymentStatus: 'PARTIAL',
};
applyExpensePayablePayment(expenseDoc, { amount: 100, paymentMethod: 'ONLINE' });
assert(expenseDoc.outstandingAmount === 200, 'after partial settle');
assert(expenseDoc.paymentOnlineAmount === 100 && expenseDoc.paymentCashAmount === 200, 'channels accumulate');
assert(expenseDoc.paymentMethod === 'SPLIT', 'method becomes SPLIT');
assert(expenseDoc.paymentStatus === 'PARTIAL', 'still partial');

applyExpensePayablePayment(expenseDoc, { amount: 200, paymentMethod: 'CASH' });
assert(expenseDoc.outstandingAmount === 0 && expenseDoc.paymentStatus === 'PAID', 'fully settled');

threw = false;
try {
  applyExpensePayablePayment(
    { settlementMode: 'FULL', amount: 100, outstandingAmount: 0 },
    { amount: 10, paymentMethod: 'CASH' }
  );
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'FULL cannot use pay endpoint');

threw = false;
try {
  applyExpensePayablePayment(
    { settlementMode: 'CREDIT', amount: 100, outstandingAmount: 0, paymentCashAmount: 100, paymentOnlineAmount: 0 },
    { amount: 10, paymentMethod: 'CASH' }
  );
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'zero outstanding cannot pay');

// Update without amountPaidNow must preserve paid-to-date
const existingCredit = {
  settlementMode: 'CREDIT',
  amount: 1000,
  outstandingAmount: 700,
  paymentCashAmount: 300,
  paymentOnlineAmount: 0,
  paymentMethod: 'CASH',
  paymentStatus: 'PARTIAL',
  creditDueDate: new Date('2026-08-01'),
};
r = resolveExpensePaymentFields(1000, { settlementMode: 'CREDIT', paymentMethod: 'CASH' }, existingCredit);
assert(r.outstandingAmount === 700 && r.paymentCashAmount === 300, 'update preserves paid without amountPaidNow');

r = resolveExpensePaymentFields(1000, { settlementMode: 'CREDIT' }, existingCredit);
assert(r.outstandingAmount === 700 && r.paymentCashAmount === 300, 'update preserves paid with settlement only');

// Aggregation expr exists and is valid object
const agg = expensePaidAmountAggregationExpr();
assert(agg.$let && agg.$let.in, 'aggregation expr shape');

assert(expensePaymentStatusQuery('ALL') === null, 'ALL filter null');
assert(expensePaymentStatusQuery('OUTSTANDING').settlementMode === 'CREDIT', 'outstanding filter');
assert(expensePaymentStatusQuery('PAID').$or?.length >= 2, 'paid filter');

console.log('expensePayment tests passed');
