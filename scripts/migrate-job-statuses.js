/**
 * One-time migration: map old job statuses to new simplified statuses.
 * Run after deploying the new status flow (Received, Work Started, Completed, Ready to Deliver).
 *
 * Maps:
 *   IN_PROGRESS, WASHING, DRYING -> WORK_STARTED
 *   READY_TO_DELIVER -> DELIVERED (if you ran an older migration)
 *   RECEIVED, COMPLETED, DELIVERED, CANCELLED -> unchanged
 *
 * Usage: node scripts/migrate-job-statuses.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/washq_saas';

const STATUS_MAP = {
  IN_PROGRESS: 'WORK_STARTED',
  WASHING: 'WORK_STARTED',
  DRYING: 'WORK_STARTED',
  READY_TO_DELIVER: 'DELIVERED' // in case an older migration was run
};

async function migrate() {
  try {
    await mongoose.connect(MONGODB_URI);
    const collection = mongoose.connection.db.collection('jobs');

    const toUpdate = Object.keys(STATUS_MAP);
    const docs = await collection.find({ status: { $in: toUpdate } }).toArray();
    if (docs.length === 0) {
      console.log('No jobs with old statuses found.');
      return;
    }

    const ops = docs.map((doc) => {
      const newStatus = STATUS_MAP[doc.status];
      let update = { $set: { status: newStatus } };
      if (doc.statusHistory && Array.isArray(doc.statusHistory) && doc.statusHistory.length > 0) {
        const migratedHistory = doc.statusHistory.map((entry) => {
          const mapped = STATUS_MAP[entry.status];
          return { ...entry, status: mapped != null ? mapped : entry.status };
        });
        update.$set.statusHistory = migratedHistory;
      }
      return { updateOne: { filter: { _id: doc._id }, update } };
    });
    const result = await collection.bulkWrite(ops);
    console.log(`Migrated ${result.modifiedCount} job(s) to new statuses.`);
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

migrate();
