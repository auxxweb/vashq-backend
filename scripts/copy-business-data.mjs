/**
 * Copy business-scoped operational/catalog data from one business to another.
 *
 * Usage:
 *   node scripts/copy-business-data.mjs --from renish12@gmail.com --to renishmgt@gmail.com --dry-run
 *   node scripts/copy-business-data.mjs --from renish12@gmail.com --to renishmgt@gmail.com --execute
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function stripId(doc) {
  const { _id, __v, ...rest } = doc;
  return rest;
}

function remapId(map, id) {
  if (id == null) return id;
  const key = String(id);
  return map.has(key) ? map.get(key) : id;
}

async function resolveBusiness(db, emailOrId) {
  if (mongoose.isValidObjectId(emailOrId)) {
    const byId = await db.collection('businesses').findOne({ _id: new mongoose.Types.ObjectId(emailOrId) });
    if (byId) return byId;
  }
  const email = String(emailOrId || '').trim().toLowerCase();
  const byEmail = await db.collection('businesses').findOne({ email });
  if (byEmail) return byEmail;
  const user = await db.collection('users').findOne({ email });
  if (user?.businessId) {
    return db.collection('businesses').findOne({ _id: user.businessId });
  }
  return null;
}

async function copyCollection({
  db,
  name,
  sourceBusinessId,
  targetBusinessId,
  idMap,
  branchMap,
  userMap,
  transform,
  execute
}) {
  const rows = await db.collection(name).find({ businessId: sourceBusinessId }).toArray();
  if (!rows.length) {
    console.log(`  ${name}: 0`);
    return { name, copied: 0 };
  }

  const inserts = [];
  for (const row of rows) {
    const oldId = row._id;
    const next = transform
      ? transform(stripId(row), { oldId, idMap, branchMap, userMap })
      : stripId(row);
    next.businessId = targetBusinessId;
    if (next.branchId != null) next.branchId = remapId(branchMap, next.branchId);
    const newId = new mongoose.Types.ObjectId();
    idMap.set(String(oldId), newId);
    inserts.push({ _id: newId, ...next });
  }

  if (execute) {
    // insert in chunks
    const chunk = 500;
    for (let i = 0; i < inserts.length; i += chunk) {
      await db.collection(name).insertMany(inserts.slice(i, i + chunk), { ordered: false });
    }
  }
  console.log(`  ${name}: ${inserts.length}${execute ? ' copied' : ' (dry-run)'}`);
  return { name, copied: inserts.length };
}

async function main() {
  const argv = process.argv.slice(2);
  const from = argValue(argv, '--from');
  const to = argValue(argv, '--to');
  const execute = argv.includes('--execute') || argv.includes('--confirm');
  const dryRun = !execute;

  if (!from || !to) {
    throw new Error('Required: --from <email|businessId> --to <email|businessId> [--execute]');
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;

  try {
    const source = await resolveBusiness(db, from);
    const target = await resolveBusiness(db, to);
    if (!source) throw new Error(`Source business not found: ${from}`);
    if (!target) throw new Error(`Target business not found: ${to}`);
    if (String(source._id) === String(target._id)) {
      throw new Error('Source and target business are the same');
    }

    console.log('Source:', source.email, String(source._id), source.businessName);
    console.log('Target:', target.email, String(target._id), target.businessName);
    console.log('Mode:', dryRun ? 'DRY_RUN' : 'EXECUTE');

    const sourceBusinessId = source._id;
    const targetBusinessId = target._id;

    const srcBranch = await db.collection('branches').findOne({ businessId: sourceBusinessId, isDefault: true })
      || await db.collection('branches').findOne({ businessId: sourceBusinessId });
    const dstBranch = await db.collection('branches').findOne({ businessId: targetBusinessId, isDefault: true })
      || await db.collection('branches').findOne({ businessId: targetBusinessId });
    if (!srcBranch || !dstBranch) {
      throw new Error('Both businesses need at least one branch');
    }

    const branchMap = new Map([[String(srcBranch._id), dstBranch._id]]);
    // map any other source branches to target default
    const allSrcBranches = await db.collection('branches').find({ businessId: sourceBusinessId }).toArray();
    for (const b of allSrcBranches) branchMap.set(String(b._id), dstBranch._id);

    const srcUsers = await db.collection('users').find({ businessId: sourceBusinessId }).toArray();
    const dstUsers = await db.collection('users').find({ businessId: targetBusinessId }).toArray();
    const userMap = new Map();
    const dstOwner = dstUsers.find((u) => u.role === 'CAR_WASH_ADMIN' || u.role === 'BRANCH_ADMIN') || dstUsers[0];
    for (const su of srcUsers) {
      let match = null;
      if (su.employeeCode) {
        match = dstUsers.find((d) => d.employeeCode && d.employeeCode === su.employeeCode);
      }
      if (!match && su.role === 'CAR_WASH_ADMIN') {
        match = dstUsers.find((d) => d.role === 'CAR_WASH_ADMIN');
      }
      if (!match && su.name) {
        match = dstUsers.find((d) => d.name && String(d.name).toLowerCase() === String(su.name).toLowerCase());
      }
      userMap.set(String(su._id), match?._id || dstOwner?._id || null);
    }

    // Safety: refuse if target already has catalog/ops data for key collections
    const blockers = {};
    for (const name of ['services', 'customers', 'cars', 'jobs', 'invoices']) {
      blockers[name] = await db.collection(name).countDocuments({ businessId: targetBusinessId });
    }
    const hasData = Object.values(blockers).some((n) => n > 0);
    if (hasData && !argv.includes('--force')) {
      console.log('Target already has data:', blockers);
      throw new Error('Target is not empty for key collections. Pass --force to append anyway.');
    }

    const idMap = new Map(); // oldId -> newId across collections
    const summary = [];

    // Master data first
    summary.push(await copyCollection({
      db, name: 'servicecategories', sourceBusinessId, targetBusinessId, idMap, branchMap, userMap, execute
    }));

    summary.push(await copyCollection({
      db,
      name: 'services',
      sourceBusinessId,
      targetBusinessId,
      idMap,
      branchMap,
      userMap,
      execute,
      transform: (doc) => {
        if (doc.categoryId) doc.categoryId = remapId(idMap, doc.categoryId);
        return doc;
      }
    }));

    summary.push(await copyCollection({
      db, name: 'expensetypes', sourceBusinessId, targetBusinessId, idMap, branchMap, userMap, execute
    }));

    summary.push(await copyCollection({
      db, name: 'leadstatuses', sourceBusinessId, targetBusinessId, idMap, branchMap, userMap, execute
    }));

    summary.push(await copyCollection({
      db, name: 'leadsources', sourceBusinessId, targetBusinessId, idMap, branchMap, userMap, execute
    }));

    summary.push(await copyCollection({
      db,
      name: 'customers',
      sourceBusinessId,
      targetBusinessId,
      idMap,
      branchMap,
      userMap,
      execute
    }));

    summary.push(await copyCollection({
      db,
      name: 'cars',
      sourceBusinessId,
      targetBusinessId,
      idMap,
      branchMap,
      userMap,
      execute,
      transform: (doc) => {
        if (doc.customerId) doc.customerId = remapId(idMap, doc.customerId);
        return doc;
      }
    }));

    summary.push(await copyCollection({
      db,
      name: 'leads',
      sourceBusinessId,
      targetBusinessId,
      idMap,
      branchMap,
      userMap,
      execute,
      transform: (doc) => {
        if (doc.statusId) doc.statusId = remapId(idMap, doc.statusId);
        if (doc.sourceId) doc.sourceId = remapId(idMap, doc.sourceId);
        if (doc.assignedTo) doc.assignedTo = remapId(userMap, doc.assignedTo);
        if (doc.convertedCustomerId) doc.convertedCustomerId = remapId(idMap, doc.convertedCustomerId);
        return doc;
      }
    }));

    summary.push(await copyCollection({
      db,
      name: 'jobs',
      sourceBusinessId,
      targetBusinessId,
      idMap,
      branchMap,
      userMap,
      execute,
      transform: (doc) => {
        if (doc.customerId) doc.customerId = remapId(idMap, doc.customerId);
        if (doc.carId) doc.carId = remapId(idMap, doc.carId);
        if (doc.assignedTo) doc.assignedTo = remapId(userMap, doc.assignedTo);
        if (doc.createdBy) doc.createdBy = remapId(userMap, doc.createdBy);
        if (Array.isArray(doc.services)) {
          doc.services = doc.services.map((s) => ({
            ...s,
            serviceId: remapId(idMap, s.serviceId)
          }));
        }
        // Legacy global unique index tokenNumber_1
        if (doc.tokenNumber) doc.tokenNumber = `${doc.tokenNumber}-COPY`;
        return doc;
      }
    }));

    summary.push(await copyCollection({
      db,
      name: 'invoices',
      sourceBusinessId,
      targetBusinessId,
      idMap,
      branchMap,
      userMap,
      execute,
      transform: (doc) => {
        if (doc.jobId) doc.jobId = remapId(idMap, doc.jobId);
        if (doc.customerId) doc.customerId = remapId(idMap, doc.customerId);
        if (doc.createdBy) doc.createdBy = remapId(userMap, doc.createdBy);
        if (Array.isArray(doc.items)) {
          doc.items = doc.items.map((it) => ({
            ...it,
            serviceId: it.serviceId ? remapId(idMap, it.serviceId) : it.serviceId
          }));
        }
        if (doc.invoiceNumber) doc.invoiceNumber = `${doc.invoiceNumber}-COPY`;
        return doc;
      }
    }));

    summary.push(await copyCollection({
      db,
      name: 'expenses',
      sourceBusinessId,
      targetBusinessId,
      idMap,
      branchMap,
      userMap,
      execute,
      transform: (doc) => {
        if (doc.expenseTypeId) doc.expenseTypeId = remapId(idMap, doc.expenseTypeId);
        if (doc.createdBy) doc.createdBy = remapId(userMap, doc.createdBy);
        return doc;
      }
    }));

    // Verify
    const verify = {};
    for (const name of ['services', 'customers', 'cars', 'jobs', 'invoices', 'expensetypes', 'leadstatuses', 'leadsources']) {
      verify[name] = {
        source: await db.collection(name).countDocuments({ businessId: sourceBusinessId }),
        target: await db.collection(name).countDocuments({ businessId: targetBusinessId })
      };
    }

    console.log('\nSummary:', JSON.stringify(summary, null, 2));
    console.log('\nVerify counts:', JSON.stringify(verify, null, 2));
    if (dryRun) {
      console.log('\nDry run only. Re-run with --execute to write data.');
    } else {
      console.log('\nCopy completed.');
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
