/**
 * Service categories — additive workflow.
 * When serviceCategoriesEnabled is false, categoryId on services is ignored by UI/filters.
 */

import mongoose from 'mongoose';
import ServiceCategory from '../models/ServiceCategory.model.js';
import Service from '../models/Service.model.js';

export const DEFAULT_SERVICE_CATEGORY_NAME = 'Default';

/**
 * Ensure the business has a Default category and assign it to services missing categoryId.
 * Safe to call repeatedly (idempotent).
 */
export async function ensureDefaultServiceCategory(businessId) {
  if (!businessId) {
    const err = new Error('businessId required');
    err.status = 400;
    throw err;
  }
  let def = await ServiceCategory.findOne({ businessId, isDefault: true });
  if (!def) {
    // Prefer existing "Default" name if present without flag
    def = await ServiceCategory.findOne({
      businessId,
      name: { $regex: /^default$/i }
    });
    if (def) {
      def.isDefault = true;
      if (!def.name || !String(def.name).trim()) def.name = DEFAULT_SERVICE_CATEGORY_NAME;
      await def.save();
    } else {
      try {
        def = await ServiceCategory.create({
          businessId,
          name: DEFAULT_SERVICE_CATEGORY_NAME,
          isDefault: true,
          isActive: true,
          sortOrder: 0
        });
      } catch (e) {
        // Race: unique name conflict — re-fetch
        def = await ServiceCategory.findOne({ businessId, isDefault: true })
          || await ServiceCategory.findOne({ businessId, name: { $regex: /^default$/i } });
        if (!def) throw e;
        if (!def.isDefault) {
          def.isDefault = true;
          await def.save();
        }
      }
    }
  }

  await Service.updateMany(
    {
      businessId,
      $or: [
        { categoryId: null },
        { categoryId: { $exists: false } },
      ],
    },
    { $set: { categoryId: def._id } }
  );

  return def;
}

export async function listServiceCategories(businessId, { ensureDefault = false } = {}) {
  if (ensureDefault) {
    await ensureDefaultServiceCategory(businessId);
  }
  return ServiceCategory.find({ businessId })
    .sort({ isDefault: -1, sortOrder: 1, name: 1 })
    .lean();
}

/**
 * Resolve categoryId for create/update.
 * When feature off: keep existing / null (do not invent).
 * When feature on: validate ownership; blank → default category.
 */
export async function resolveServiceCategoryId({
  businessId,
  categoryId,
  featureEnabled,
  existingCategoryId = null,
}) {
  if (!featureEnabled) {
    if (categoryId === undefined) return existingCategoryId ?? null;
    if (categoryId === null || categoryId === '' || categoryId === 'NONE') return existingCategoryId ?? null;
    if (!mongoose.isValidObjectId(String(categoryId))) {
      const err = new Error('Invalid service category');
      err.status = 400;
      throw err;
    }
    const cat = await ServiceCategory.findOne({ _id: categoryId, businessId }).select('_id').lean();
    if (!cat) {
      const err = new Error('Invalid service category');
      err.status = 400;
      throw err;
    }
    return cat._id;
  }

  const def = await ensureDefaultServiceCategory(businessId);
  if (categoryId === undefined || categoryId === null || categoryId === '' || categoryId === 'NONE') {
    return existingCategoryId || def._id;
  }
  if (!mongoose.isValidObjectId(String(categoryId))) {
    const err = new Error('Invalid service category');
    err.status = 400;
    throw err;
  }
  const cat = await ServiceCategory.findOne({ _id: categoryId, businessId }).select('_id').lean();
  if (!cat) {
    const err = new Error('Invalid service category');
    err.status = 400;
    throw err;
  }
  return cat._id;
}

export function normalizeCategoryName(name) {
  return String(name || '').trim().slice(0, 80);
}
