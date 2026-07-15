/**
 * Copy WhatsApp settings from default branch → business settings when business is missing them.
 * Fixes accounts that configured WhatsApp only via branch settings (WhatsApp Settings page).
 *
 * Usage:
 *   node backend/scripts/sync-branch-whatsapp-settings.mjs
 *   node backend/scripts/sync-branch-whatsapp-settings.mjs --dry-run
 *   node backend/scripts/sync-branch-whatsapp-settings.mjs --email=renjithmv1048@gmail.com
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Business from '../models/Business.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Branch from '../models/Branch.model.js';
import BranchSettings from '../models/BranchSettings.model.js';
import User from '../models/User.model.js';
import { normalizeWhatsappTemplates } from '../utils/whatsappTemplates.js';

const dryRun = process.argv.includes('--dry-run');
const emailArg = process.argv.find((a) => a.startsWith('--email='));
const filterEmail = emailArg ? emailArg.split('=')[1]?.trim().toLowerCase() : '';

async function syncBusiness(businessId, businessName) {
  const defaultBranch = await Branch.findOne({ businessId, isDefault: true }).lean();
  if (!defaultBranch) {
    console.log(`  skip ${businessName}: no default branch`);
    return { synced: false };
  }

  const branchSettings = await BranchSettings.findOne({ branchId: defaultBranch._id }).lean();
  const branchShop = String(branchSettings?.shopWhatsappNumber || '').trim();
  if (!branchShop) {
    console.log(`  skip ${businessName}: branch has no shop WhatsApp`);
    return { synced: false };
  }

  let bizSettings = await BusinessSettings.findOne({ businessId });
  if (!bizSettings) {
    if (dryRun) {
      console.log(`  would create BusinessSettings for ${businessName}`);
      return { synced: true };
    }
    bizSettings = await BusinessSettings.create({ businessId });
  }

  const bizShop = String(bizSettings.shopWhatsappNumber || '').trim();
  if (bizShop) {
    console.log(`  skip ${businessName}: business already has shop WhatsApp`);
    return { synced: false };
  }

  const update = {
    shopWhatsappNumber: branchShop
  };
  const branchReview = String(branchSettings.googleReviewLink || '').trim();
  if (branchReview && !String(bizSettings.googleReviewLink || '').trim()) {
    update.googleReviewLink = branchReview;
  }
  if (branchSettings.whatsappTemplates && Object.keys(branchSettings.whatsappTemplates).length) {
    update.whatsappTemplates = normalizeWhatsappTemplates({
      ...(bizSettings.whatsappTemplates || {}),
      ...branchSettings.whatsappTemplates
    });
  }

  if (dryRun) {
    console.log(`  would sync ${businessName}: shop=${branchShop}`);
    return { synced: true };
  }

  await BusinessSettings.updateOne({ businessId }, { $set: update });
  console.log(`  synced ${businessName}: shop=${branchShop}`);
  return { synced: true };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI or MONGODB_URI required');
  await mongoose.connect(uri);
  console.log(`Connected${dryRun ? ' (dry run)' : ''}`);

  let businessIds = null;
  if (filterEmail) {
    const user = await User.findOne({ email: filterEmail }).select('businessId email').lean();
    const biz = user?.businessId
      ? await Business.findById(user.businessId).select('_id businessName email').lean()
      : await Business.findOne({ email: filterEmail }).select('_id businessName email').lean();
    if (!biz) {
      console.error(`Business not found for email: ${filterEmail}`);
      process.exit(1);
    }
    businessIds = [biz];
    console.log(`Targeting: ${biz.businessName} (${filterEmail})`);
  } else {
    businessIds = await Business.find({ status: { $ne: 'INACTIVE' } })
      .select('_id businessName')
      .lean();
  }

  let synced = 0;
  let skipped = 0;
  for (const biz of businessIds) {
    const result = await syncBusiness(biz._id, biz.businessName);
    if (result.synced) synced += 1;
    else skipped += 1;
  }

  console.log(`Done. synced=${synced} skipped=${skipped}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
