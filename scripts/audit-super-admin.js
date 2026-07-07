/**
 * Inspect super-admin account state and rule out common deletion causes.
 * Usage: node scripts/audit-super-admin.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.model.js';

dotenv.config();

function maskUri(uri) {
  if (!uri) return '(not set)';
  return uri.replace(/:([^:@/]+)@/, ':***@');
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set in backend/.env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const dbName = mongoose.connection.db.databaseName;

  console.log('=== Super Admin Audit ===');
  console.log('Database URI (masked):', maskUri(uri));
  console.log('Database name:', dbName);
  console.log('');

  const superAdmins = await User.find({ role: 'SUPER_ADMIN' })
    .select('email role status businessId createdAt updatedAt lastLoginAt')
    .lean();

  console.log(`SUPER_ADMIN count: ${superAdmins.length}`);
  for (const u of superAdmins) {
    console.log('---');
    console.log('  id:', u._id);
    console.log('  email:', u.email);
    console.log('  status:', u.status);
    console.log('  businessId:', u.businessId);
    console.log('  createdAt:', u.createdAt);
    console.log('  updatedAt:', u.updatedAt);
    console.log('  lastLoginAt:', u.lastLoginAt || '(never)');
  }

  const washq = await User.findOne({ email: 'washq@gmail.com' }).lean();
  console.log('');
  console.log('washq@gmail.com exists:', !!washq);
  if (washq) {
    console.log('  role:', washq.role);
    console.log('  createdAt:', washq.createdAt);
  }

  const nullBizUsers = await User.find({ businessId: null })
    .select('email role createdAt')
    .lean();
  console.log('');
  console.log(`Users with businessId=null: ${nullBizUsers.length}`);
  nullBizUsers.forEach((u) => console.log(`  - ${u.email} (${u.role})`));

  const roleCounts = await User.aggregate([
    { $group: { _id: '$role', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  console.log('');
  console.log('Users by role:', Object.fromEntries(roleCounts.map((r) => [r._id, r.count])));

  console.log('');
  console.log('=== App deletion rules (code review) ===');
  console.log('- SUPER_ADMIN is NOT deleted by DELETE /super-admin/businesses/:id');
  console.log('  (that only runs User.deleteMany({ businessId: <business ObjectId> }))');
  console.log('- Only employee delete exists in admin routes (role EMPLOYEE / BRANCH_ADMIN)');
  console.log('- No cron job or script deletes SUPER_ADMIN users');
  console.log('');
  console.log('If SUPER_ADMIN is missing, likely causes:');
  console.log('  1. create-admin was never run on THIS database');
  console.log('  2. Manual delete in MongoDB Compass / Atlas shell');
  console.log('  3. Wrong database checked (local vs Atlas cluster)');
  console.log('  4. Atlas restore / cluster reset (check Atlas Activity Feed)');

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
