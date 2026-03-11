/**
 * One-time fix: drop the old global unique index on invoiceNumber
 * so that invoice numbers can be unique per business (INV-000001 per business).
 *
 * After running this, restart the server; Mongoose will create the compound
 * unique index (businessId + invoiceNumber).
 *
 * Usage: node scripts/drop-invoice-number-index.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/test';

async function run() {
  await mongoose.connect(MONGODB_URI);
  const coll = mongoose.connection.collection('invoices');
  const indexes = await coll.indexes();
  const hasOld = indexes.some((i) => i.name === 'invoiceNumber_1');
  if (hasOld) {
    await coll.dropIndex('invoiceNumber_1');
    console.log('Dropped index invoiceNumber_1. Restart the server to create the new compound index.');
  } else {
    console.log('Index invoiceNumber_1 not found (already dropped or never created).');
  }
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
