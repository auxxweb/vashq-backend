import Service from '../models/Service.model.js';
import { lineQuantity, shouldTrackInventory } from './serviceCatalog.js';

export function catalogMapById(catalogServices = []) {
  return new Map(catalogServices.map((s) => [String(s._id), s]));
}

/** Pre-check stock before creating a product sale (non-atomic; final deduct is atomic). */
export function assertSufficientStock(jobLines = [], catalogServices = []) {
  const byId = catalogMapById(catalogServices);
  for (const line of jobLines) {
    const sid = String(line.serviceId?._id || line.serviceId || '');
    const svc = byId.get(sid);
    if (!shouldTrackInventory(svc)) continue;
    const qty = lineQuantity(line.quantity);
    const stock = Number(svc.stockQuantity) || 0;
    if (stock < qty) {
      const err = new Error(`Insufficient stock for "${svc.name}" (${stock} available, ${qty} requested)`);
      err.status = 409;
      throw err;
    }
  }
}

/** Atomically reduce stock for tracked products on a completed sale. */
export async function deductServiceStockForSale(businessId, jobLines = [], catalogServices = []) {
  const byId = catalogMapById(catalogServices);
  const deductions = [];

  for (const line of jobLines) {
    const sid = String(line.serviceId?._id || line.serviceId || '');
    const svc = byId.get(sid);
    if (!shouldTrackInventory(svc)) continue;
    const qty = lineQuantity(line.quantity);

    const updated = await Service.findOneAndUpdate(
      {
        _id: svc._id,
        businessId,
        stockQuantity: { $gte: qty }
      },
      { $inc: { stockQuantity: -qty } },
      { new: true }
    );

    if (!updated) {
      const err = new Error(`Insufficient stock for "${svc.name}"`);
      err.status = 409;
      throw err;
    }
    deductions.push({ serviceId: svc._id, quantity: qty });
  }

  return deductions;
}

/** Restore stock if a sale is rolled back (best-effort). */
export async function restoreServiceStock(businessId, deductions = []) {
  for (const row of deductions) {
    if (!row?.serviceId || !row.quantity) continue;
    await Service.findOneAndUpdate(
      { _id: row.serviceId, businessId },
      { $inc: { stockQuantity: row.quantity } }
    );
  }
}
