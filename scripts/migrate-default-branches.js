/**
 * Create default branch for every business that has none, and backfill branchId on legacy records.
 * Usage: node backend/scripts/migrate-default-branches.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Business from '../models/Business.model.js';
import { ensureDefaultBranchForBusiness } from '../services/branchService.js';

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI required');
  await mongoose.connect(uri);
  console.log('Connected');

  const businesses = await Business.find({ status: { $ne: 'INACTIVE' } }).select('_id businessName').lean();
  let created = 0;
  for (const b of businesses) {
    const branch = await ensureDefaultBranchForBusiness(b._id);
    if (branch) {
      created += 1;
      console.log(`OK ${b.businessName} → ${branch.name} (${branch.code})`);
    }
  }
  console.log(`Done. Processed ${businesses.length} businesses.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
