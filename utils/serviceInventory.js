import Service from '../models/Service.model.js';
import { lineQuantity, shouldTrackInventory } from './serviceCatalog.js';
import { isInventoryManagementEnabled } from './inventoryEnabled.js';
import { postStockMovement } from './stockLedger.js';

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

/**
 * Atomically reduce stock for tracked products on a completed sale.
 * When inventoryManagementEnabled: also posts SALE ledger rows (COGS).
 * When off: legacy $inc only (unchanged).
 *
 * IMPORTANT: If inventory flag check fails, fall back to legacy path so sales never break.
 */
export async function deductServiceStockForSale(
  businessId,
  jobLines = [],
  catalogServices = [],
  { refType = 'JOB', refId = null, createdBy = null, movementDate = new Date() } = {}
) {
  let inventoryOn = false;
  try {
    inventoryOn = await isInventoryManagementEnabled(businessId);
  } catch {
    inventoryOn = false;
  }
  const byId = catalogMapById(catalogServices);
  const deductions = [];

  for (const line of jobLines) {
    const sid = String(line.serviceId?._id || line.serviceId || '');
    const svc = byId.get(sid);
    if (!shouldTrackInventory(svc)) continue;
    const qty = lineQuantity(line.quantity);

    if (inventoryOn) {
      try {
        const result = await postStockMovement({
          businessId,
          branchId: svc.branchId || null,
          serviceId: svc._id,
          type: 'SALE',
          qtyDelta: -qty,
          unitCost: null, // use avg cost
          refType,
          refId,
          notes: 'Product sale',
          movementDate,
          createdBy
        });
        deductions.push({
          serviceId: svc._id,
          quantity: qty,
          unitCost: result.unitCost,
          valueDelta: result.valueDelta,
          ledgerId: result.entry?._id
        });
      } catch (err) {
        // If ledger path fails unexpectedly, try legacy deduct for this line so checkout isn't blocked
        if (err.status === 409) {
          if (deductions.length) {
            await restoreServiceStock(businessId, deductions, { inventoryOn: true }).catch(() => {});
          }
          throw err;
        }
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
          if (deductions.length) {
            await restoreServiceStock(businessId, deductions, { inventoryOn: true }).catch(() => {});
          }
          const stockErr = new Error(`Insufficient stock for "${svc.name}"`);
          stockErr.status = 409;
          throw stockErr;
        }
        deductions.push({ serviceId: svc._id, quantity: qty });
      }
      continue;
    }

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

/**
 * Restore stock if a sale is rolled back (best-effort).
 * When inventory on: posts SALE_REVERSAL ledger.
 */
export async function restoreServiceStock(businessId, deductions = [], opts = {}) {
  const inventoryOn =
    opts.inventoryOn !== undefined
      ? opts.inventoryOn
      : await isInventoryManagementEnabled(businessId);

  for (const row of deductions) {
    if (!row?.serviceId || !row.quantity) continue;

    if (inventoryOn) {
      try {
        await postStockMovement({
          businessId,
          serviceId: row.serviceId,
          type: 'SALE_REVERSAL',
          qtyDelta: row.quantity,
          unitCost: row.unitCost != null ? row.unitCost : null,
          refType: opts.refType || 'JOB',
          refId: opts.refId || null,
          notes: 'Sale reversal / stock restore',
          createdBy: opts.createdBy || null
        });
      } catch {
        // best-effort fallback to qty bump
        await Service.findOneAndUpdate(
          { _id: row.serviceId, businessId },
          { $inc: { stockQuantity: row.quantity } }
        );
      }
      continue;
    }

    await Service.findOneAndUpdate(
      { _id: row.serviceId, businessId },
      { $inc: { stockQuantity: row.quantity } }
    );
  }
}
