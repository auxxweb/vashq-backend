/**
 * Ensure default (main) branch per business and backfill branchId on legacy records,
 * including employees/branch admins created before multi-branch.
 *
 * Usage:
 *   node backend/scripts/migrate-default-branches.js
 *   node backend/scripts/migrate-default-branches.js --dry-run
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Business from '../models/Business.model.js';
import User from '../models/User.model.js';
import {
  ensureDefaultBranchForBusiness,
  countLegacyBranchIdGaps
} from '../services/branchService.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI required');
  await mongoose.connect(uri);
  console.log(`Connected${dryRun ? ' (dry run)' : ''}`);

  const businesses = await Business.find({ status: { $ne: 'INACTIVE' } })
    .select('_id businessName')
    .lean();

  const totals = {
    businesses: 0,
    staffBefore: 0,
    staffAfter: 0,
    backfilled: {
      jobs: 0,
      invoices: 0,
      expenses: 0,
      bookings: 0,
      packageVisits: 0,
      customers: 0,
      cars: 0,
      services: 0,
      customerPackages: 0,
      staff: 0,
      whatsappMessages: 0
    }
  };

  for (const b of businesses) {
    totals.businesses += 1;
    const before = await countLegacyBranchIdGaps(b._id);
    totals.staffBefore += before.staff;

    if (before.staff > 0) {
      const legacyStaff = await User.find({
        businessId: b._id,
        role: { $in: ['EMPLOYEE', 'BRANCH_ADMIN'] },
        $or: [{ branchId: null }, { branchId: { $exists: false } }]
      })
        .select('name email employeeCode role')
        .lean();
      console.log(`\n${b.businessName} — ${before.staff} staff without branch:`);
      for (const u of legacyStaff) {
        console.log(`  - ${u.role} ${u.name || u.email} (${u.employeeCode || 'no code'})`);
      }
    }

    if (before.total === 0) {
      console.log(`\n${b.businessName} — already fully backfilled`);
      continue;
    }

    if (dryRun) {
      console.log(
        `\n${b.businessName} — would backfill ${before.total} records`
        + ` (staff: ${before.staff}, jobs: ${before.jobs}, customers: ${before.customers}, …)`
      );
      continue;
    }

    const branch = await ensureDefaultBranchForBusiness(b._id);
    const after = await countLegacyBranchIdGaps(b._id);
    totals.staffAfter += after.staff;

    const backfilledStaff = before.staff - after.staff;
    console.log(
      `\n${b.businessName} → ${branch.name} (${branch.code})`
      + ` | staff backfilled: ${backfilledStaff}`
      + ` | remaining gaps: ${after.total}`
    );

    if (before.total > after.total) {
      // ensureDefaultBranchForBusiness runs backfill internally; approximate from deltas
      totals.backfilled.staff += backfilledStaff;
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Businesses processed: ${totals.businesses}`);
  console.log(`Staff missing branch (before): ${totals.staffBefore}`);
  if (!dryRun) {
    console.log(`Staff missing branch (after): ${totals.staffAfter}`);
  }
  console.log('Done.');
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
