/**
 * One-time fix: drop the old unique index on jobId (jobId_1)
 * so that we can store package invoices where jobId is null.
 *
 * After running, restart the server so Mongoose can create the new sparse indexes.
 *
 * Usage:
 *   node backend/scripts/drop-invoice-jobid-unique-index.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI (or MONGODB_URI) is required');

  await mongoose.connect(uri);
  const coll = mongoose.connection.collection('invoices');
  const indexes = await coll.indexes();
  const has = indexes.some((i) => i.name === 'jobId_1');
  if (has) {
    await coll.dropIndex('jobId_1');
    console.log('Dropped index jobId_1.');
  } else {
    console.log('Index jobId_1 not found (already dropped or never created).');
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

