import {
  expenseCashOnline,
  resolveExpensePaymentFields,
  sumExpenseChannelTotals,
} from '../utils/expensePayment.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// CASH
let r = resolveExpensePaymentFields(500, { paymentMethod: 'CASH' });
assert(r.paymentCashAmount === 500 && r.paymentOnlineAmount === 0, 'CASH split');

// ONLINE
r = resolveExpensePaymentFields(300, { paymentMethod: 'ONLINE' });
assert(r.paymentOnlineAmount === 300 && r.paymentCashAmount === 0, 'ONLINE split');

// SPLIT both
r = resolveExpensePaymentFields(1000, {
  paymentMethod: 'SPLIT',
  paymentCashAmount: 400,
  paymentOnlineAmount: 600,
});
assert(r.paymentCashAmount === 400 && r.paymentOnlineAmount === 600, 'SPLIT both');

// SPLIT cash only
r = resolveExpensePaymentFields(250, { paymentMethod: 'SPLIT', paymentCashAmount: 100 });
assert(r.paymentCashAmount === 100 && r.paymentOnlineAmount === 150, 'SPLIT infer online');

// SPLIT invalid sum
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

// zero amount
threw = false;
try {
  resolveExpensePaymentFields(0, { paymentMethod: 'CASH' });
} catch (e) {
  threw = e.status === 400;
}
assert(threw, 'zero amount throws');

// legacy expense inference
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

console.log('expensePayment tests passed');
