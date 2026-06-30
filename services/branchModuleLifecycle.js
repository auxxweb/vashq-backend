import mongoose from 'mongoose';
import Business from '../models/Business.model.js';
import Branch from '../models/Branch.model.js';

/** Deactivate all branches when multi-branch module is turned off. */
export async function suspendBranchesForModule(businessId) {
  const businessObjectId = typeof businessId === 'string'
    ? new mongoose.Types.ObjectId(businessId)
    : businessId;

  const business = await Business.findById(businessObjectId)
    .select('branchModuleSuspendSnapshot')
    .lean();
  const existingSnapshot = business?.branchModuleSuspendSnapshot || [];

  const branches = await Branch.find({ businessId: businessObjectId }).lean();
  if (!branches.length) return { suspended: 0 };

  const hasActive = branches.some((b) => b.status === 'ACTIVE');
  if (!hasActive) return { suspended: 0 };

  if (!existingSnapshot.length) {
    const snapshot = branches.map((b) => ({
      branchId: b._id,
      status: b.status || 'ACTIVE'
    }));
    await Business.updateOne(
      { _id: businessObjectId },
      { $set: { branchModuleSuspendSnapshot: snapshot } }
    );
  }

  await Branch.updateMany({ businessId: businessObjectId }, { $set: { status: 'INACTIVE' } });

  return { suspended: branches.length };
}

/** Restore branch statuses saved before module suspension. */
export async function restoreBranchesForModule(businessId) {
  const businessObjectId = typeof businessId === 'string'
    ? new mongoose.Types.ObjectId(businessId)
    : businessId;

  const business = await Business.findById(businessObjectId)
    .select('branchModuleSuspendSnapshot')
    .lean();
  const snapshot = business?.branchModuleSuspendSnapshot || [];

  if (snapshot.length) {
    await Promise.all(snapshot.map((entry) => {
      if (!entry?.branchId) return Promise.resolve();
      return Branch.updateOne(
        { _id: entry.branchId, businessId: businessObjectId },
        { $set: { status: entry.status || 'ACTIVE' } }
      );
    }));
  }

  await Branch.updateOne(
    { businessId: businessObjectId, isDefault: true },
    { $set: { status: 'ACTIVE' } }
  );

  await Business.updateOne(
    { _id: businessObjectId },
    { $set: { branchModuleSuspendSnapshot: [] } }
  );

  return { restored: snapshot.length };
}
