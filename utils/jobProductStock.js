import Service from '../models/Service.model.js';
import { isProductCatalogService } from './jobCart.js';
import { assertSufficientStock, deductServiceStockForSale, restoreServiceStock } from './serviceInventory.js';

/**
 * Soft stock check for wash jobs that include tracked products (at create/edit).
 * No-op when there are no tracked product lines.
 */
export async function assertProductStockForJobLines(businessId, jobLines = [], catalogServices = []) {
  const products = (catalogServices || []).filter(isProductCatalogService);
  if (!products.length) return;
  assertSufficientStock(jobLines, catalogServices);
}

/**
 * Deduct tracked product stock when a wash job is delivered.
 * Idempotent via job.productStockDeductedAt. Skips directBill (deducted at create).
 * Mutates job.productStockDeductedAt when successful / no products.
 */
export async function deductProductStockOnWashJobDelivery(job, businessId) {
  if (!job || job.directBill) return { deducted: false };
  if (job.productStockDeductedAt) return { deducted: false, already: true };

  const serviceIds = (job.services || [])
    .map((s) => s.serviceId?._id || s.serviceId)
    .filter(Boolean);

  if (!serviceIds.length) {
    job.productStockDeductedAt = new Date();
    return { deducted: false };
  }

  const catalogServices = await Service.find({
    businessId,
    _id: { $in: serviceIds }
  }).lean();

  const hasProducts = catalogServices.some(isProductCatalogService);
  if (!hasProducts) {
    job.productStockDeductedAt = new Date();
    return { deducted: false };
  }

  let deductions = [];
  try {
    deductions = await deductServiceStockForSale(businessId, job.services, catalogServices);
    job.productStockDeductedAt = new Date();
    return { deducted: deductions.length > 0, deductions };
  } catch (err) {
    if (deductions.length) {
      await restoreServiceStock(businessId, deductions).catch(() => {});
    }
    throw err;
  }
}

/**
 * For paths that set DELIVERED via findOneAndUpdate (close-job / credit).
 * Loads the job, deducts stock, then sets status.
 */
export async function markJobDeliveredWithProductStock({ jobId, businessId, extraSet = {} }) {
  const Job = (await import('../models/Job.model.js')).default;
  const job = await Job.findOne({ _id: jobId, businessId });
  if (!job) {
    const err = new Error('Job not found');
    err.status = 404;
    throw err;
  }

  if (job.status !== 'DELIVERED') {
    await deductProductStockOnWashJobDelivery(job, businessId);
    job.status = 'DELIVERED';
    job.actualDelivery = new Date();
    Object.assign(job, extraSet);
    await job.save();
  } else if (!job.directBill && !job.productStockDeductedAt) {
    await deductProductStockOnWashJobDelivery(job, businessId);
    await job.save();
  }

  return job;
}
