/**
 * Realign Cash & Bank ledger entryDate to match source document dates
 * (invoice paymentReceivedAt, expenseDate, revenueDate, collectionDate).
 *
 * Usage:
 *   node scripts/realign-cash-bank-entry-dates.mjs --dry-run
 *   node scripts/realign-cash-bank-entry-dates.mjs --execute
 *   node scripts/realign-cash-bank-entry-dates.mjs --execute --business mojoautocafe@gmail.com
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const argv = process.argv.slice(2);
const execute = argv.includes('--execute');
const dryRun = !execute;
const businessFilter = argValue(argv, '--business');

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(d) {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;

  let businessIds = [];
  if (businessFilter) {
    const biz = await db.collection('businesses').findOne({
      $or: [
        { email: new RegExp(`^${businessFilter}$`, 'i') },
        { businessName: new RegExp(businessFilter, 'i') }
      ]
    });
    if (!biz) {
      console.error('Business not found:', businessFilter);
      process.exit(1);
    }
    businessIds = [biz._id];
    console.log('Business:', biz.businessName, String(biz._id));
  } else {
    const enabled = await db.collection('businesssettings').find({
      cashAndBankEnabled: true
    }).project({ businessId: 1 }).toArray();
    businessIds = enabled.map((s) => s.businessId).filter(Boolean);
    console.log('Cash & Bank enabled businesses:', businessIds.length);
  }

  const {
    syncMoneyBookFromInvoice,
    syncMoneyBookFromExpense,
    syncMoneyBookFromOtherRevenue,
    syncMoneyBookFromCollection,
    syncMoneyBookFromPurchase
  } = await import('../utils/cashBankSync.js');
  const { rebuildAccountBalancesChronological } = await import('../services/moneyBookService.js');

  const summary = {
    invoicesChecked: 0,
    invoicesFixed: 0,
    expensesFixed: 0,
    otherRevenueFixed: 0,
    collectionsFixed: 0,
    purchasesFixed: 0,
    samples: []
  };

  for (const bid of businessIds) {
    const mismatchedInvoices = [];
    const invoices = await db.collection('invoices').find({
      businessId: bid,
      paymentStatus: 'RECEIVED',
      $or: [
        { paymentCashAmount: { $gt: 0.02 } },
        { paymentOnlineAmount: { $gt: 0.02 } }
      ]
    }).project({
      invoiceNumber: 1,
      paymentReceivedAt: 1,
      saleConfirmedAt: 1,
      paymentCashAmount: 1,
      paymentOnlineAmount: 1,
      paymentMethod: 1,
      branchId: 1,
      businessId: 1
    }).toArray();

    for (const inv of invoices) {
      summary.invoicesChecked += 1;
      const want = inv.paymentReceivedAt || inv.saleConfirmedAt;
      if (!want) continue;
      const ledgers = await db.collection('moneyledgers').find({
        businessId: bid,
        sourceType: 'INVOICE',
        sourceId: inv._id
      }).toArray();
      if (!ledgers.length) continue;
      const drift = ledgers.some((l) => dayKey(l.entryDate) !== dayKey(want));
      if (!drift) continue;
      mismatchedInvoices.push({ inv, ledgers, want });
    }

    for (const { inv, ledgers, want } of mismatchedInvoices) {
      summary.samples.push({
        type: 'INVOICE',
        businessId: String(bid),
        invoiceNumber: inv.invoiceNumber,
        want: want?.toISOString?.() || want,
        had: ledgers.map((l) => ({ account: l.accountType, entryDate: l.entryDate }))
      });
      if (dryRun) {
        summary.invoicesFixed += 1;
        continue;
      }
      await syncMoneyBookFromInvoice(inv);
      summary.invoicesFixed += 1;
    }

    // Expenses
    const expenses = await db.collection('expenses').find({
      businessId: bid,
      $or: [
        { paymentCashAmount: { $gt: 0.02 } },
        { paymentOnlineAmount: { $gt: 0.02 } }
      ]
    }).project({
      expenseDate: 1,
      createdAt: 1,
      paymentCashAmount: 1,
      paymentOnlineAmount: 1,
      branchId: 1,
      businessId: 1
    }).toArray();

    for (const exp of expenses) {
      const want = exp.expenseDate || exp.createdAt;
      if (!want) continue;
      const ledgers = await db.collection('moneyledgers').find({
        businessId: bid,
        sourceType: 'EXPENSE',
        sourceId: exp._id
      }).toArray();
      if (!ledgers.length) continue;
      if (!ledgers.some((l) => dayKey(l.entryDate) !== dayKey(want))) continue;
      summary.samples.push({
        type: 'EXPENSE',
        id: String(exp._id),
        want: want?.toISOString?.() || want,
        had: ledgers.map((l) => l.entryDate)
      });
      if (!dryRun) await syncMoneyBookFromExpense(exp);
      summary.expensesFixed += 1;
    }

    // Other revenue
    const ors = await db.collection('otherrevenues').find({
      businessId: bid,
      $or: [
        { paymentCashAmount: { $gt: 0.02 } },
        { paymentOnlineAmount: { $gt: 0.02 } }
      ]
    }).project({
      revenueDate: 1,
      createdAt: 1,
      paymentCashAmount: 1,
      paymentOnlineAmount: 1,
      branchId: 1,
      businessId: 1
    }).toArray();

    for (const row of ors) {
      const want = row.revenueDate || row.createdAt;
      if (!want) continue;
      const ledgers = await db.collection('moneyledgers').find({
        businessId: bid,
        sourceType: 'OTHER_REVENUE',
        sourceId: row._id
      }).toArray();
      if (!ledgers.length) continue;
      if (!ledgers.some((l) => dayKey(l.entryDate) !== dayKey(want))) continue;
      summary.samples.push({
        type: 'OTHER_REVENUE',
        id: String(row._id),
        want: want?.toISOString?.() || want,
        had: ledgers.map((l) => l.entryDate)
      });
      if (!dryRun) await syncMoneyBookFromOtherRevenue(row);
      summary.otherRevenueFixed += 1;
    }

    // Purchases
    const purchases = await db.collection('purchases').find({
      businessId: bid,
      $or: [
        { paymentCashAmount: { $gt: 0.02 } },
        { paymentOnlineAmount: { $gt: 0.02 } }
      ]
    }).project({
      purchaseDate: 1,
      createdAt: 1,
      paymentCashAmount: 1,
      paymentOnlineAmount: 1,
      branchId: 1,
      businessId: 1,
      billNumber: 1
    }).toArray();

    for (const p of purchases) {
      const want = p.purchaseDate || p.createdAt;
      if (!want) continue;
      const ledgers = await db.collection('moneyledgers').find({
        businessId: bid,
        sourceType: 'PURCHASE',
        sourceId: p._id
      }).toArray();
      if (!ledgers.length) {
        // Missing ledger for paid purchase — force sync
        summary.samples.push({
          type: 'PURCHASE_MISSING',
          id: String(p._id),
          bill: p.billNumber,
          want: want?.toISOString?.() || want
        });
        if (!dryRun) await syncMoneyBookFromPurchase(p);
        summary.purchasesFixed += 1;
        continue;
      }
      const amountDrift = ledgers.some((l) => {
        const expected = l.accountType === 'CASH' ? Number(p.paymentCashAmount) || 0 : Number(p.paymentOnlineAmount) || 0;
        return Math.abs((Number(l.amount) || 0) - expected) > 0.05;
      });
      const dateDrift = ledgers.some((l) => dayKey(l.entryDate) !== dayKey(want));
      if (!dateDrift && !amountDrift) continue;
      summary.samples.push({
        type: 'PURCHASE',
        id: String(p._id),
        bill: p.billNumber,
        want: want?.toISOString?.() || want,
        had: ledgers.map((l) => ({ account: l.accountType, entryDate: l.entryDate, amount: l.amount }))
      });
      if (!dryRun) await syncMoneyBookFromPurchase(p);
      summary.purchasesFixed += 1;
    }

    // Collections
    const cols = await db.collection('paymentcollections').find({
      businessId: bid,
      $or: [
        { paymentCashAmount: { $gt: 0.02 } },
        { paymentOnlineAmount: { $gt: 0.02 } }
      ]
    }).project({
      collectionDate: 1,
      createdAt: 1,
      paymentCashAmount: 1,
      paymentOnlineAmount: 1,
      branchId: 1,
      businessId: 1,
      collectionNumber: 1
    }).toArray();

    for (const c of cols) {
      const want = c.collectionDate || c.createdAt;
      if (!want) continue;
      const ledgers = await db.collection('moneyledgers').find({
        businessId: bid,
        sourceType: 'COLLECTION',
        sourceId: c._id
      }).toArray();
      if (!ledgers.length) continue;
      if (!ledgers.some((l) => dayKey(l.entryDate) !== dayKey(want))) continue;
      summary.samples.push({
        type: 'COLLECTION',
        id: String(c._id),
        number: c.collectionNumber,
        want: want?.toISOString?.() || want,
        had: ledgers.map((l) => l.entryDate)
      });
      if (!dryRun) await syncMoneyBookFromCollection(c, { branchId: c.branchId });
      summary.collectionsFixed += 1;
    }

    if (!dryRun) {
      await rebuildAccountBalancesChronological(bid);
    }
  }

  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'execute',
    ...summary,
    sampleCount: summary.samples.length,
    samples: summary.samples.slice(0, 50)
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
