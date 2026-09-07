import mongoose from 'mongoose';
import Service from '../models/Service.model.js';
import StockLedger from '../models/StockLedger.model.js';
import { shouldTrackInventory } from './serviceCatalog.js';

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function roundQty(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/**
 * Post a stock movement and update Service.stockQuantity / avgCost.
 * qtyDelta > 0 = in, < 0 = out.
 */
export async function postStockMovement({
  businessId,
  branchId = null,
  serviceId,
  type,
  qtyDelta,
  unitCost = null,
  refType = null,
  refId = null,
  notes = '',
  movementDate = new Date(),
  createdBy = null,
  session = null
}) {
  const delta = roundQty(qtyDelta);
  if (!delta) {
    const err = new Error('Stock quantity change cannot be zero');
    err.status = 400;
    throw err;
  }

  const service = await Service.findOne({ _id: serviceId, businessId }).session(session || null);
  if (!service) {
    const err = new Error('Product not found');
    err.status = 404;
    throw err;
  }
  if (!shouldTrackInventory(service)) {
    const err = new Error(`Inventory is not tracked for "${service.name}"`);
    err.status = 400;
    throw err;
  }

  const prevQty = roundQty(Number(service.stockQuantity) || 0);
  const prevAvg = roundMoney(Number(service.avgCost) || 0);
  const prevValue = roundMoney(prevQty * prevAvg);
  const nextQty = roundQty(prevQty + delta);

  if (nextQty < -0.0001) {
    const err = new Error(`Insufficient stock for "${service.name}" (${prevQty} available)`);
    err.status = 409;
    throw err;
  }

  let costPerUnit = unitCost != null ? roundMoney(unitCost) : prevAvg;
  if (costPerUnit < 0) costPerUnit = 0;

  let nextAvg = prevAvg;
  let nextValue = prevValue;
  let valueDelta = 0;

  if (delta > 0) {
    // Inbound: weighted average
    valueDelta = roundMoney(delta * costPerUnit);
    nextValue = roundMoney(prevValue + valueDelta);
    nextAvg = nextQty > 0.0001 ? roundMoney(nextValue / nextQty) : 0;
  } else {
    // Outbound: use current avg cost unless explicit unitCost provided
    costPerUnit = unitCost != null ? roundMoney(unitCost) : prevAvg;
    valueDelta = roundMoney(delta * costPerUnit); // negative
    nextValue = roundMoney(Math.max(0, prevValue + valueDelta));
    nextAvg = nextQty > 0.0001 ? roundMoney(nextValue / nextQty) : (prevAvg || 0);
  }

  const safeQty = Math.max(0, nextQty);
  const safeValue = Math.max(0, nextValue);

  service.stockQuantity = safeQty;
  service.avgCost = nextAvg;
  await service.save(session ? { session } : undefined);

  const [entry] = session
    ? await StockLedger.create(
      [
        {
          businessId,
          branchId: branchId || service.branchId || null,
          serviceId: service._id,
          type,
          qtyDelta: delta,
          unitCost: costPerUnit,
          valueDelta,
          balanceQty: safeQty,
          balanceValue: safeValue,
          refType,
          refId,
          notes: notes || '',
          movementDate: movementDate || new Date(),
          createdBy
        }
      ],
      { session }
    )
    : [
      await StockLedger.create({
        businessId,
        branchId: branchId || service.branchId || null,
        serviceId: service._id,
        type,
        qtyDelta: delta,
        unitCost: costPerUnit,
        valueDelta,
        balanceQty: safeQty,
        balanceValue: safeValue,
        refType,
        refId,
        notes: notes || '',
        movementDate: movementDate || new Date(),
        createdBy
      })
    ];

  return {
    entry,
    service,
    previousQty: prevQty,
    balanceQty: safeQty,
    avgCost: nextAvg,
    unitCost: costPerUnit,
    valueDelta
  };
}

/** Seed OPENING ledger from current Service.stockQuantity when enabling inventory. */
export async function seedOpeningStockFromCatalog({
  businessId,
  branchId = null,
  createdBy = null,
  movementDate = new Date()
}) {
  const products = await Service.find({
    businessId,
    isVariable: true,
    skipWorkProcess: true,
    trackInventory: { $ne: false },
    stockQuantity: { $gt: 0 }
  });

  const created = [];
  for (const svc of products) {
    const qty = roundQty(Number(svc.stockQuantity) || 0);
    if (qty <= 0) continue;

    const existing = await StockLedger.exists({
      businessId,
      serviceId: svc._id,
      type: 'OPENING'
    });
    if (existing) continue;

    const avg = roundMoney(Number(svc.avgCost) || 0);
    // Reset cache then post so ledger balance matches current qty
    const holdQty = qty;
    const holdAvg = avg;
    svc.stockQuantity = 0;
    svc.avgCost = 0;
    await svc.save();

    const result = await postStockMovement({
      businessId,
      branchId: branchId || svc.branchId || null,
      serviceId: svc._id,
      type: 'OPENING',
      qtyDelta: holdQty,
      unitCost: holdAvg,
      refType: 'OPENING',
      notes: 'Opening stock (inventory enabled)',
      movementDate,
      createdBy
    });
    created.push(result.entry);
  }
  return created;
}

/**
 * Stock qty + value as of a point in time (latest ledger on or before asOf).
 * Falls back to Service cache when no ledger exists.
 */
export async function stockSnapshotAsOf(businessId, asOf, { serviceIds = null } = {}) {
  const match = {
    businessId: new mongoose.Types.ObjectId(String(businessId)),
    movementDate: { $lte: asOf }
  };
  if (serviceIds?.length) {
    match.serviceId = {
      $in: serviceIds.map((id) => new mongoose.Types.ObjectId(String(id)))
    };
  }

  const rows = await StockLedger.aggregate([
    { $match: match },
    { $sort: { movementDate: 1, createdAt: 1 } },
    {
      $group: {
        _id: '$serviceId',
        balanceQty: { $last: '$balanceQty' },
        balanceValue: { $last: '$balanceValue' },
        unitCost: { $last: '$unitCost' }
      }
    }
  ]);

  const byId = new Map(rows.map((r) => [String(r._id), r]));

  const productQuery = {
    businessId,
    isVariable: true,
    skipWorkProcess: true,
    trackInventory: { $ne: false }
  };
  if (serviceIds?.length) {
    productQuery._id = { $in: serviceIds };
  }
  const products = await Service.find(productQuery)
    .select('name sku unit price avgCost stockQuantity lowStockThreshold isActive')
    .lean();

  return products.map((p) => {
    const snap = byId.get(String(p._id));
    const qty = snap ? roundQty(snap.balanceQty) : roundQty(Number(p.stockQuantity) || 0);
    const value = snap
      ? roundMoney(snap.balanceValue)
      : roundMoney(qty * (Number(p.avgCost) || 0));
    const avgCost = qty > 0.0001 ? roundMoney(value / qty) : roundMoney(Number(p.avgCost) || 0);
    return {
      serviceId: p._id,
      name: p.name,
      sku: p.sku || '',
      unit: p.unit || 'pcs',
      sellPrice: p.price,
      quantity: qty,
      avgCost,
      value,
      isActive: p.isActive !== false
    };
  });
}

/** Purchases total (net goods after discount) in period. */
export async function purchasesTotalInPeriod(businessId, start, endExclusive) {
  const Purchase = (await import('../models/Purchase.model.js')).default;
  const agg = await Purchase.aggregate([
    {
      $match: {
        businessId: new mongoose.Types.ObjectId(String(businessId)),
        stockPosted: true,
        purchaseDate: { $gte: start, $lt: endExclusive }
      }
    },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $ifNull: [
              '$netGoodsAmount',
              {
                $subtract: [
                  { $ifNull: ['$subtotal', 0] },
                  { $ifNull: ['$discountAmount', 0] }
                ]
              }
            ]
          }
        }
      }
    }
  ]);
  return roundMoney(agg[0]?.total ?? 0);
}

/** COGS from SALE ledger value (absolute) in period. */
export async function cogsFromSalesInPeriod(businessId, start, endExclusive) {
  const agg = await StockLedger.aggregate([
    {
      $match: {
        businessId: new mongoose.Types.ObjectId(String(businessId)),
        type: 'SALE',
        movementDate: { $gte: start, $lt: endExclusive }
      }
    },
    { $group: { _id: null, total: { $sum: { $abs: '$valueDelta' } } } }
  ]);
  return roundMoney(agg[0]?.total ?? 0);
}

export { roundMoney, roundQty };
