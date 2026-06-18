/**
 * One-time fix: assign collectionNumber to PaymentCollection rows missing it.
 * Run: node scripts/backfill-collection-numbers.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import PaymentCollection, { generateCollectionNumber } from '../models/PaymentCollection.model.js';

async function uniqueNumber(businessId, used) {
  for (let i = 0; i < 20; i++) {
    const n = generateCollectionNumber();
    const key = `${businessId}:${n}`;
    if (!used.has(key)) {
      used.add(key);
      return n;
    }
  }
  throw new Error(`Could not allocate collection number for business ${businessId}`);
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGODB_URI in backend/.env');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const rows = await PaymentCollection.find({
    $or: [
      { collectionNumber: null },
      { collectionNumber: '' },
      { collectionNumber: { $exists: false } }
    ]
  }).sort({ createdAt: 1 });

  if (!rows.length) {
    console.log('No payment collections need backfill.');
    await mongoose.disconnect();
    return;
  }

  const used = new Set(
    (await PaymentCollection.find({ collectionNumber: { $exists: true, $nin: [null, ''] } })
      .select('businessId collectionNumber')
      .lean())
      .map((r) => `${r.businessId}:${r.collectionNumber}`)
  );

  let updated = 0;
  for (const row of rows) {
    row.collectionNumber = await uniqueNumber(String(row.businessId), used);
    await row.save();
    updated++;
    console.log(`Updated ${row._id} -> ${row.collectionNumber}`);
  }

  console.log(`Backfill complete: ${updated} record(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
