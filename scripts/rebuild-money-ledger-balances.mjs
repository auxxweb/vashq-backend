/**
 * Rebuild Cash & Bank running balances without flooring at zero.
 * Day closing (open + in − out) then equals next day opening.
 *
 * Usage:
 *   node scripts/rebuild-money-ledger-balances.mjs --dry-run --business mojoautocafe@gmail.com
 *   node scripts/rebuild-money-ledger-balances.mjs --execute --business mojoautocafe@gmail.com
 *   node scripts/rebuild-money-ledger-balances.mjs --execute   # all cash&bank businesses
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
const businessFilter = argValue(argv, '--business');

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function periodClose(db, bid, branchId, accountType, dayStart, dayEnd) {
  const before = await db.collection('moneyledgers').find({
    businessId: bid,
    branchId,
    accountType,
    entryDate: { $lt: dayStart }
  }).sort({ entryDate: -1, createdAt: -1 }).limit(1).toArray();

  let opening;
  if (before[0]) {
    opening = round(before[0].balanceAfter);
  } else {
    const [agg] = await db.collection('moneyledgers').aggregate([
      { $match: { businessId: bid, branchId, accountType, entryDate: { $lt: dayStart } } },
      { $group: { _id: null, sum: { $sum: '$signedAmount' } } }
    ]).toArray();
    if (agg) opening = round(agg.sum);
    else {
      const acc = await db.collection('moneyaccounts').findOne({ businessId: bid, branchId, accountType });
      opening = round(acc?.openingBalance || 0);
    }
  }

  const movs = await db.collection('moneyledgers').find({
    businessId: bid,
    branchId,
    accountType,
    entryDate: { $gte: dayStart, $lt: dayEnd },
    sourceType: { $ne: 'OPENING' }
  }).toArray();

  let tin = 0;
  let tout = 0;
  for (const m of movs) {
    if (m.direction === 'IN') tin += m.amount;
    else tout += m.amount;
  }
  tin = round(tin);
  tout = round(tout);
  const bookClose = round(opening + tin - tout);

  const last = await db.collection('moneyledgers').find({
    businessId: bid,
    branchId,
    accountType,
    entryDate: { $lt: dayEnd }
  }).sort({ entryDate: -1, createdAt: -1 }).limit(1).toArray();

  const ledgerClose = last[0] ? round(last[0].balanceAfter) : opening;
  return { opening, tin, tout, bookClose, ledgerClose, gap: round(ledgerClose - bookClose) };
}

async function rebuildAccount(db, account) {
  const rows = await db.collection('moneyledgers').find({
    businessId: account.businessId,
    branchId: account.branchId,
    accountType: account.accountType
  }).sort({ entryDate: 1, createdAt: 1 }).toArray();

  let bal = 0;
  let changed = 0;
  const ops = [];
  for (const row of rows) {
    bal = round(bal + (Number(row.signedAmount) || 0));
    if (round(row.balanceAfter) !== bal) {
      changed += 1;
      ops.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { balanceAfter: bal } }
        }
      });
    }
  }
  if (execute) {
    if (ops.length) {
      for (let i = 0; i < ops.length; i += 500) {
        await db.collection('moneyledgers').bulkWrite(ops.slice(i, i + 500));
      }
    }
    await db.collection('moneyaccounts').updateOne(
      { _id: account._id },
      { $set: { currentBalance: bal } }
    );
  }
  return { rows: rows.length, changed, finalBalance: bal };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;

  let businessIds = [];
  if (businessFilter) {
    const user = await db.collection('users').findOne({ email: new RegExp(`^${businessFilter}$`, 'i') });
    const biz = await db.collection('businesses').findOne({
      $or: [
        { email: new RegExp(`^${businessFilter}$`, 'i') },
        ...(user?.businessId ? [{ _id: user.businessId }] : []),
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
    const enabled = await db.collection('businesssettings').find({ cashAndBankEnabled: true })
      .project({ businessId: 1 }).toArray();
    businessIds = enabled.map((s) => s.businessId).filter(Boolean);
    console.log('Cash & Bank businesses:', businessIds.length);
  }

  console.log(execute ? 'MODE: EXECUTE' : 'MODE: DRY-RUN');

  const sep4Start = new Date('2026-09-03T18:30:00.000Z');
  const sep5Start = new Date('2026-09-04T18:30:00.000Z');
  const sep6Start = new Date('2026-09-05T18:30:00.000Z');

  for (const bid of businessIds) {
    const biz = await db.collection('businesses').findOne({ _id: bid }, { projection: { businessName: 1, email: 1 } });
    const accounts = await db.collection('moneyaccounts').find({ businessId: bid }).toArray();
    console.log('\n===', biz?.businessName || bid, 'accounts:', accounts.length, '===');

    for (const account of accounts) {
      const before = await periodClose(
        db, bid, account.branchId, account.accountType, sep4Start, sep5Start
      ).catch(() => null);

      const result = await rebuildAccount(db, account);
      console.log({
        type: account.accountType,
        branchId: String(account.branchId),
        ...result,
        prevCurrent: account.currentBalance
      });

      if (before && (account.accountType === 'CASH' || businessFilter)) {
        const after = await periodClose(db, bid, account.branchId, account.accountType, sep4Start, sep5Start);
        const nextOpen = await periodClose(db, bid, account.branchId, account.accountType, sep5Start, sep6Start);
        console.log('  Sep4 book/ledger close:', after.bookClose, after.ledgerClose, 'gap', after.gap);
        console.log('  Sep5 opening (book):', nextOpen.opening, 'matches Sep4 close?', nextOpen.opening === after.bookClose);
      }
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
