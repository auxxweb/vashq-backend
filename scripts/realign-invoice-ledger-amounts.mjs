/**
 * Re-post Cash & Bank INVOICE ledger amounts to match post-discount settlement
 * (finalAmount − advance), fixing rows that still show pre-discount totals.
 *
 * Usage:
 *   node scripts/realign-invoice-ledger-amounts.mjs --dry-run
 *   node scripts/realign-invoice-ledger-amounts.mjs --execute
 *   node scripts/realign-invoice-ledger-amounts.mjs --execute --business mojoautocafe@gmail.com
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
const EPS = 0.05;

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

  const { syncMoneyBookFromInvoice } = await import('../utils/cashBankSync.js');
  const { invoiceSettlementCashOnline } = await import('../utils/paymentChannelAmounts.js');
  const { rebuildAccountBalancesChronological } = await import('../services/moneyBookService.js');

  const samples = [];
  let fixed = 0;
  let checked = 0;

  for (const bid of businessIds) {
    const invs = await db.collection('invoices').find({
      businessId: bid,
      paymentStatus: 'RECEIVED'
    }).toArray();

    let bizTouched = false;
    for (const inv of invs) {
      checked += 1;
      const want = invoiceSettlementCashOnline(inv);
      const wantTotal = (want.cash || 0) + (want.online || 0);
      const ledgers = await db.collection('moneyledgers').find({
        businessId: bid,
        sourceType: 'INVOICE',
        sourceId: inv._id
      }).toArray();

      const cashLed = ledgers.filter((l) => l.accountType === 'CASH').reduce((s, l) => s + (Number(l.amount) || 0), 0);
      const bankLed = ledgers.filter((l) => l.accountType === 'BANK').reduce((s, l) => s + (Number(l.amount) || 0), 0);
      const ledTotal = cashLed + bankLed;

      const noLedgerButShould = wantTotal > EPS && !ledgers.length;
      const amountMismatch =
        ledgers.length > 0 &&
        (Math.abs(ledTotal - wantTotal) > EPS ||
          Math.abs(cashLed - (want.cash || 0)) > EPS ||
          Math.abs(bankLed - (want.online || 0)) > EPS);

      if (!noLedgerButShould && !amountMismatch) continue;

      samples.push({
        businessId: String(bid),
        invoiceNumber: inv.invoiceNumber,
        finalAmount: inv.finalAmount,
        discountAmount: inv.discountAmount,
        want,
        had: { cash: cashLed, bank: bankLed, total: ledTotal }
      });

      if (!dryRun) {
        await syncMoneyBookFromInvoice(inv, {
          throwOnError: true,
          skipBalanceCheck: true,
          rebuildBalances: false
        });
        bizTouched = true;
      }
      fixed += 1;
    }

    if (!dryRun && bizTouched) {
      await rebuildAccountBalancesChronological(bid);
    }
  }

  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'execute',
    checked,
    fixed,
    sampleCount: samples.length,
    samples: samples.slice(0, 40)
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
