/**
 * Service subcategories — optional under ServiceCategory when serviceSubcategoriesEnabled.
 * Each category has a Default subcategory (mirrors category Default).
 */

import mongoose from 'mongoose';
import ServiceSubCategory from '../models/ServiceSubCategory.model.js';
import ServiceCategory from '../models/ServiceCategory.model.js';
import Service from '../models/Service.model.js';

export const DEFAULT_SERVICE_SUBCATEGORY_NAME = 'Default';

export function normalizeSubCategoryName(name) {
  return String(name || '').trim().slice(0, 80);
}

/**
 * Ensure a Default subcategory exists for the given category.
 * Backfills services in that category that are missing subCategoryId.
 */
export async function ensureDefaultServiceSubCategory(businessId, categoryId) {
  if (!businessId || !categoryId) {
    const err = new Error('businessId and categoryId required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.isValidObjectId(String(categoryId))) {
    const err = new Error('Invalid category');
    err.status = 400;
    throw err;
  }

  let def = await ServiceSubCategory.findOne({ businessId, categoryId, isDefault: true });
  if (!def) {
    def = await ServiceSubCategory.findOne({
      businessId,
      categoryId,
      name: { $regex: /^default$/i }
    });
    if (def) {
      def.isDefault = true;
      if (!def.name || !String(def.name).trim()) def.name = DEFAULT_SERVICE_SUBCATEGORY_NAME;
      await def.save();
    } else {
      try {
        def = await ServiceSubCategory.create({
          businessId,
          categoryId,
          name: DEFAULT_SERVICE_SUBCATEGORY_NAME,
          isDefault: true,
          isActive: true,
          sortOrder: 0
        });
      } catch (e) {
        def = await ServiceSubCategory.findOne({ businessId, categoryId, isDefault: true })
          || await ServiceSubCategory.findOne({
            businessId,
            categoryId,
            name: { $regex: /^default$/i }
          });
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
      categoryId,
      $or: [
        { subCategoryId: null },
        { subCategoryId: { $exists: false } }
      ]
    },
    { $set: { subCategoryId: def._id } }
  );

  return def;
}

/** Ensure every category has a Default subcategory + backfill services. */
export async function ensureDefaultSubCategoriesForBusiness(businessId) {
  const categories = await ServiceCategory.find({ businessId }).select('_id').lean();
  const defaults = [];
  for (const cat of categories) {
    defaults.push(await ensureDefaultServiceSubCategory(businessId, cat._id));
  }
  return defaults;
}

export async function listServiceSubCategories(businessId, { categoryId, ensureDefault = false } = {}) {
  if (ensureDefault) {
    if (categoryId && mongoose.isValidObjectId(String(categoryId))) {
      await ensureDefaultServiceSubCategory(businessId, categoryId);
    } else {
      await ensureDefaultSubCategoriesForBusiness(businessId);
    }
  }
  const query = { businessId };
  if (categoryId && mongoose.isValidObjectId(String(categoryId))) {
    query.categoryId = categoryId;
  }
  return ServiceSubCategory.find(query)
    .sort({ isDefault: -1, sortOrder: 1, name: 1 })
    .lean();
}

/**
 * Resolve subCategoryId for create/update.
 * When feature off: keep existing / null.
 * When on: blank → Default subcategory for the category; must belong to categoryId.
 */
export async function resolveServiceSubCategoryId({
  businessId,
  subCategoryId,
  categoryId,
  featureEnabled,
  existingSubCategoryId = null,
}) {
  if (!featureEnabled) {
    if (subCategoryId === undefined) return existingSubCategoryId ?? null;
    return existingSubCategoryId ?? null;
  }

  if (!categoryId || !mongoose.isValidObjectId(String(categoryId))) {
    const err = new Error('Select a category before choosing a subcategory');
    err.status = 400;
    throw err;
  }

  const def = await ensureDefaultServiceSubCategory(businessId, categoryId);

  if (subCategoryId === undefined) {
    if (existingSubCategoryId) {
      const existing = await ServiceSubCategory.findOne({
        _id: existingSubCategoryId,
        businessId,
        categoryId
      }).select('_id').lean();
      if (existing) return existing._id;
    }
    return def._id;
  }

  if (subCategoryId === null || subCategoryId === '' || subCategoryId === 'NONE') {
    return def._id;
  }

  if (!mongoose.isValidObjectId(String(subCategoryId))) {
    const err = new Error('Invalid service subcategory');
    err.status = 400;
    throw err;
  }

  const sub = await ServiceSubCategory.findOne({
    _id: subCategoryId,
    businessId,
    categoryId,
    isActive: { $ne: false }
  }).select('_id').lean();

  if (!sub) {
    const err = new Error('Subcategory not found under the selected category');
    err.status = 400;
    throw err;
  }
  return sub._id;
}

/**
 * Remove all subcategories for a category (after services have been reassigned).
 */
export async function deleteSubCategoriesForCategory(businessId, categoryId) {
  await ServiceSubCategory.deleteMany({ businessId, categoryId });
}

export async function assertParentCategory(businessId, categoryId) {
  if (!mongoose.isValidObjectId(String(categoryId))) {
    const err = new Error('Invalid category');
    err.status = 400;
    throw err;
  }
  const cat = await ServiceCategory.findOne({ _id: categoryId, businessId }).select('_id').lean();
  if (!cat) {
    const err = new Error('Category not found');
    err.status = 404;
    throw err;
  }
  return cat;
}
