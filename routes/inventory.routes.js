import express from 'express';
import mongoose from 'mongoose';
import { body, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveBranchContext } from '../middleware/branchContext.middleware.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import { adminPanelOnly } from '../middleware/adminPanel.middleware.js';
import { isAdminPanelRole } from '../utils/adminRoles.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Service from '../models/Service.model.js';
import Supplier from '../models/Supplier.model.js';
import Purchase from '../models/Purchase.model.js';
import StockLedger from '../models/StockLedger.model.js';
import { applyBranchScope } from '../utils/branchQuery.js';
import { parseBusinessDateRange } from '../utils/businessDateRange.js';
import {
  postStockMovement,
  seedOpeningStockFromCatalog,
  stockSnapshotAsOf,
  roundMoney,
  roundQty
} from '../utils/stockLedger.js';
import { shouldTrackInventory } from '../utils/serviceCatalog.js';
import { computePurchaseTotals } from '../utils/purchaseTotals.js';
import { syncMoneyBookFromPurchase } from '../utils/cashBankSync.js';

const router = express.Router();

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.user?.businessId) {
    return res.status(403).json({ success: false, message: 'Business not assigned' });
  }
  // Always normalize to ObjectId-compatible value (lean user.businessId is a string/ObjectId)
  req.businessId = req.user.businessId?._id || req.user.businessId;
  next();
});
router.use(resolveBranchContext);
router.use(enforceActiveSubscription());

async function isInventoryOn(businessId) {
  if (!businessId) return false;
  const settings = await BusinessSettings.findOne({ businessId })
    .select('inventoryManagementEnabled')
    .lean();
  return settings?.inventoryManagementEnabled === true;
}

/** Public to authenticated users — does not require inventory to be enabled. */
router.get('/status', async (req, res) => {
  try {
    const enabled = await isInventoryOn(req.businessId);
    res.json({ success: true, enabled });
  } catch (error) {
    console.error('Inventory status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

async function requireInventoryEnabled(req, res, next) {
  try {
    const enabled = await isInventoryOn(req.businessId);
    if (!enabled) {
      return res.status(403).json({
        success: false,
        message: 'Inventory management is disabled. Enable it in Settings → Save Settings.',
        code: 'INVENTORY_DISABLED'
      });
    }
    next();
  } catch (e) {
    next(e);
  }
}

// Only inventory APIs under this mount — never gate dashboard/jobs/etc.
router.use((req, res, next) => {
  if (req.path === '/status') return next();
  return requireInventoryEnabled(req, res, next);
});

router.use((req, res, next) => {
  if (isAdminPanelRole(req.user?.role) || req.user?.role === 'EMPLOYEE') return next();
  return res.status(403).json({ success: false, message: 'Access denied' });
});

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      message: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array()
    });
    return false;
  }
  return true;
}

async function businessTz(businessId) {
  const s = await BusinessSettings.findOne({ businessId }).select('timezone').lean();
  return s?.timezone || 'Asia/Kolkata';
}

function productFilter(businessId, req) {
  return applyBranchScope(
    {
      businessId,
      isVariable: true,
      skipWorkProcess: true
    },
    req
  );
}

async function buildPurchaseItems(req, rawItems) {
  const serviceIds = rawItems.map((i) => i.serviceId);
  const products = await Service.find({
    ...productFilter(req.businessId, req),
    _id: { $in: serviceIds }
  }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = [];
  let subtotal = 0;
  for (const line of rawItems) {
    const svc = byId.get(String(line.serviceId));
    if (!svc) {
      const err = new Error(`Product not found: ${line.serviceId}`);
      err.status = 400;
      throw err;
    }
    if (!shouldTrackInventory(svc)) {
      const err = new Error(`"${svc.name}" does not track inventory`);
      err.status = 400;
      throw err;
    }
    const quantity = roundQty(Number(line.quantity));
    const unitCost = roundMoney(Number(line.unitCost));
    if (!(quantity > 0)) {
      const err = new Error(`Invalid quantity for "${svc.name}"`);
      err.status = 400;
      throw err;
    }
    const lineTotal = roundMoney(quantity * unitCost);
    subtotal = roundMoney(subtotal + lineTotal);
    items.push({
      serviceId: svc._id,
      productName: svc.name,
      quantity,
      unitCost,
      lineTotal
    });
  }
  return { items, subtotal };
}

function resolvePurchaseSettlement(body, grandTotal) {
  const settlementMode = body.settlementMode === 'CREDIT' ? 'CREDIT' : 'FULL';
  let paymentCashAmount = roundMoney(Number(body.paymentCashAmount) || 0);
  let paymentOnlineAmount = roundMoney(Number(body.paymentOnlineAmount) || 0);
  let paymentMethod = String(body.paymentMethod || 'CASH').toUpperCase();
  if (!['CASH', 'ONLINE', 'SPLIT'].includes(paymentMethod)) paymentMethod = 'CASH';

  let outstandingAmount = 0;
  let paymentStatus = 'PAID';
  const payable = roundMoney(grandTotal);

  if (settlementMode === 'FULL') {
    if (paymentCashAmount + paymentOnlineAmount < 0.009) {
      paymentCashAmount = payable;
      paymentOnlineAmount = 0;
      paymentMethod = 'CASH';
    }
    const paid = roundMoney(paymentCashAmount + paymentOnlineAmount);
    if (Math.abs(paid - payable) > 0.05 && paid > payable + 0.009) {
      const err = new Error('Paid amount cannot exceed purchase total');
      err.status = 400;
      throw err;
    }
    // If underpaid on FULL, treat remainder as unpaid credit
    if (paid + 0.009 < payable) {
      outstandingAmount = roundMoney(payable - paid);
      paymentStatus = paid <= 0.009 ? 'UNPAID' : 'PARTIAL';
    } else {
      outstandingAmount = 0;
      paymentStatus = 'PAID';
    }
  } else {
    const paidNow = roundMoney(paymentCashAmount + paymentOnlineAmount);
    if (paidNow > payable + 0.009) {
      const err = new Error('Paid amount cannot exceed purchase total');
      err.status = 400;
      throw err;
    }
    outstandingAmount = roundMoney(Math.max(0, payable - paidNow));
    paymentStatus =
      outstandingAmount <= 0.009 ? 'PAID' : paidNow <= 0.009 ? 'UNPAID' : 'PARTIAL';
  }

  if (paymentCashAmount > 0.009 && paymentOnlineAmount > 0.009) paymentMethod = 'SPLIT';
  else if (paymentOnlineAmount > 0.009 && paymentCashAmount < 0.009) paymentMethod = 'ONLINE';
  else if (paymentCashAmount > 0.009) paymentMethod = 'CASH';

  return {
    settlementMode,
    paymentCashAmount,
    paymentOnlineAmount,
    paymentMethod,
    outstandingAmount,
    paymentStatus
  };
}

async function postPurchaseStockLines(req, purchase, items, purchaseDate) {
  const posted = [];
  try {
    for (const line of items) {
      const result = await postStockMovement({
        businessId: req.businessId,
        branchId: purchase.branchId || req.branchId || null,
        serviceId: line.serviceId,
        type: 'PURCHASE',
        qtyDelta: line.quantity,
        unitCost: line.unitCost,
        refType: 'PURCHASE',
        refId: purchase._id,
        notes: `Purchase ${purchase.billNumber || purchase._id}`,
        movementDate: purchaseDate,
        createdBy: req.user._id
      });
      posted.push({
        serviceId: line.serviceId,
        quantity: line.quantity,
        unitCost: line.unitCost,
        ledgerId: result.entry._id
      });
    }
  } catch (err) {
    for (const row of posted) {
      try {
        await postStockMovement({
          businessId: req.businessId,
          branchId: purchase.branchId || req.branchId || null,
          serviceId: row.serviceId,
          type: 'ADJUST',
          qtyDelta: -row.quantity,
          unitCost: row.unitCost,
          refType: 'PURCHASE',
          refId: purchase._id,
          notes: 'Purchase rollback',
          createdBy: req.user._id
        });
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
  return posted;
}

async function reversePurchaseStockLines(req, purchase) {
  const items = Array.isArray(purchase.items) ? purchase.items : [];
  for (const line of items) {
    const qty = roundQty(Number(line.quantity) || 0);
    if (qty <= 0) continue;
    await postStockMovement({
      businessId: req.businessId,
      branchId: purchase.branchId || req.branchId || null,
      serviceId: line.serviceId,
      type: 'ADJUST',
      qtyDelta: -qty,
      unitCost: Number(line.unitCost) || 0,
      refType: 'PURCHASE',
      refId: purchase._id,
      notes: `Purchase edit reverse ${purchase.billNumber || purchase._id}`,
      movementDate: purchase.purchaseDate || new Date(),
      createdBy: req.user._id
    });
  }
}

// ─── Products (catalog rows that are retail products) ───────────────────────

router.get('/products', async (req, res) => {
  try {
    const filter = productFilter(req.businessId, req);
    if (req.query.active === '1') filter.isActive = true;
    if (req.query.active === '0') filter.isActive = false;
    if (req.query.q) {
      const q = String(req.query.q).trim();
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { sku: { $regex: q, $options: 'i' } }
      ];
    }
    const products = await Service.find(filter).sort({ name: 1 }).lean();
    const low = [];
    const out = [];
    const rows = products.map((p) => {
      const qty = Number(p.stockQuantity) || 0;
      const track = shouldTrackInventory(p);
      const threshold = Number(p.lowStockThreshold);
      const lowAt = Number.isFinite(threshold) ? threshold : 5;
      const status = !track ? 'untracked' : qty <= 0 ? 'out' : qty <= lowAt ? 'low' : 'ok';
      if (status === 'out') out.push(p._id);
      if (status === 'low') low.push(p._id);
      const avgCost = Number(p.avgCost) || 0;
      const sell = Number(p.price) || 0;
      const marginPct = sell > 0.009 ? roundMoney(((sell - avgCost) / sell) * 100) : null;
      return {
        ...p,
        stockStatus: status,
        stockValue: roundMoney(qty * avgCost),
        marginPct
      };
    });
    res.json({
      success: true,
      products: rows,
      summary: {
        count: rows.length,
        lowStock: low.length,
        outOfStock: out.length,
        stockValue: roundMoney(rows.reduce((s, r) => s + (r.stockValue || 0), 0))
      }
    });
  } catch (error) {
    console.error('Inventory products list error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/products', adminPanelOnly, [
  body('name').trim().notEmpty().withMessage('Product name is required'),
  body('price').optional().isFloat({ min: 0 }),
  body('stockQuantity').optional().isFloat({ min: 0 }),
  body('avgCost').optional().isFloat({ min: 0 }),
  body('lowStockThreshold').optional().isFloat({ min: 0 }),
  body('trackInventory').optional().isBoolean(),
  body('sku').optional().trim().isString(),
  body('unit').optional().trim().isString(),
  body('isActive').optional().isBoolean()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;

    const trackInventory = req.body.trackInventory !== false;
    const openingQty = roundQty(Number(req.body.stockQuantity) || 0);
    const openingCost = roundMoney(Number(req.body.avgCost) || 0);
    const price = roundMoney(Number(req.body.price) || 0);

    const product = await Service.create({
      businessId: req.businessId,
      branchId: req.branchId || null,
      name: String(req.body.name).trim(),
      price,
      description: req.body.description || '',
      isVariable: true,
      skipWorkProcess: true,
      trackInventory,
      stockQuantity: 0,
      avgCost: 0,
      lowStockThreshold:
        req.body.lowStockThreshold != null ? Number(req.body.lowStockThreshold) : 5,
      sku: String(req.body.sku || '').trim(),
      unit: String(req.body.unit || 'pcs').trim() || 'pcs',
      isActive: req.body.isActive !== false,
      showOnBookingForm: false,
      minTime: null,
      maxTime: null,
      categoryId: req.body.categoryId || null,
      subCategoryId: req.body.subCategoryId || null
    });

    if (trackInventory && openingQty > 0) {
      await postStockMovement({
        businessId: req.businessId,
        branchId: req.branchId || null,
        serviceId: product._id,
        type: 'OPENING',
        qtyDelta: openingQty,
        unitCost: openingCost,
        refType: 'OPENING',
        notes: 'Opening stock on product create',
        createdBy: req.user._id
      });
      await product.constructor.findById(product._id).then((fresh) => {
        if (fresh) Object.assign(product, fresh.toObject());
      });
    }

    const fresh = await Service.findById(product._id).lean();
    res.status(201).json({ success: true, product: fresh });
  } catch (error) {
    console.error('Inventory create product error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

router.put('/products/:id', adminPanelOnly, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product id' });
    }
    const filter = productFilter(req.businessId, req);
    filter._id = req.params.id;
    const product = await Service.findOne(filter);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (req.body.name != null) product.name = String(req.body.name).trim();
    if (req.body.price != null) product.price = roundMoney(Number(req.body.price) || 0);
    if (req.body.description != null) product.description = req.body.description;
    if (req.body.sku != null) product.sku = String(req.body.sku).trim();
    if (req.body.unit != null) product.unit = String(req.body.unit).trim() || 'pcs';
    if (req.body.lowStockThreshold != null) {
      product.lowStockThreshold = Number(req.body.lowStockThreshold);
    }
    if (req.body.trackInventory != null) product.trackInventory = !!req.body.trackInventory;
    if (req.body.isActive != null) product.isActive = !!req.body.isActive;
    if (req.body.categoryId !== undefined) product.categoryId = req.body.categoryId || null;
    if (req.body.subCategoryId !== undefined) product.subCategoryId = req.body.subCategoryId || null;

    // Keep product flags
    product.isVariable = true;
    product.skipWorkProcess = true;
    product.minTime = null;
    product.maxTime = null;

    await product.save();
    res.json({ success: true, product });
  } catch (error) {
    console.error('Inventory update product error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/** Manual stock adjustment (+/−) with reason. */
router.post('/products/:id/adjust', adminPanelOnly, [
  body('qtyDelta').isFloat().withMessage('qtyDelta is required'),
  body('notes').optional().trim().isString(),
  body('unitCost').optional().isFloat({ min: 0 })
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const filter = productFilter(req.businessId, req);
    filter._id = req.params.id;
    const product = await Service.findOne(filter).lean();
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const result = await postStockMovement({
      businessId: req.businessId,
      branchId: req.branchId || product.branchId || null,
      serviceId: product._id,
      type: 'ADJUST',
      qtyDelta: Number(req.body.qtyDelta),
      unitCost: req.body.unitCost != null ? Number(req.body.unitCost) : null,
      refType: 'ADJUST',
      notes: req.body.notes || 'Stock adjustment',
      createdBy: req.user._id
    });

    res.json({
      success: true,
      product: result.service,
      ledger: result.entry
    });
  } catch (error) {
    console.error('Inventory adjust error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/** One-time seed opening from existing Service.stockQuantity values. */
router.post('/seed-opening', adminPanelOnly, async (req, res) => {
  try {
    const created = await seedOpeningStockFromCatalog({
      businessId: req.businessId,
      branchId: req.branchId || null,
      createdBy: req.user._id
    });
    res.json({ success: true, seeded: created.length, entries: created });
  } catch (error) {
    console.error('Inventory seed opening error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// ─── Suppliers ──────────────────────────────────────────────────────────────

router.get('/suppliers', async (req, res) => {
  try {
    const filter = applyBranchScope({ businessId: req.businessId }, req);
    if (req.query.active !== '0') filter.isActive = true;
    const suppliers = await Supplier.find(filter).sort({ name: 1 }).lean();

    const ids = suppliers.map((s) => s._id);
    let outstandingBySupplier = new Map();
    if (ids.length) {
      const agg = await Purchase.aggregate([
        {
          $match: {
            businessId: new mongoose.Types.ObjectId(String(req.businessId)),
            supplierId: { $in: ids },
            outstandingAmount: { $gt: 0.009 }
          }
        },
        {
          $group: {
            _id: '$supplierId',
            outstandingPayable: { $sum: '$outstandingAmount' },
            openBills: { $sum: 1 }
          }
        }
      ]);
      outstandingBySupplier = new Map(
        agg.map((r) => [String(r._id), r])
      );
    }

    const rows = suppliers.map((s) => {
      const o = outstandingBySupplier.get(String(s._id));
      return {
        ...s,
        outstandingPayable: roundMoney(o?.outstandingPayable || 0),
        openBills: o?.openBills || 0
      };
    });

    res.json({ success: true, suppliers: rows });
  } catch (error) {
    console.error('Inventory suppliers list error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/suppliers/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid supplier id' });
    }
    const filter = applyBranchScope({ businessId: req.businessId, _id: req.params.id }, req);
    const supplier = await Supplier.findOne(filter).lean();
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    const purchaseFilter = applyBranchScope(
      { businessId: req.businessId, supplierId: supplier._id },
      req
    );
    const purchases = await Purchase.find(purchaseFilter)
      .sort({ purchaseDate: -1, createdAt: -1 })
      .limit(500)
      .lean();

    const totalPurchases = roundMoney(
      purchases.reduce((s, p) => s + (Number(p.subtotal) || 0), 0)
    );
    const outstandingPayable = roundMoney(
      purchases.reduce((s, p) => s + (Number(p.outstandingAmount) || 0), 0)
    );
    const paidTotal = roundMoney(totalPurchases - outstandingPayable);

    res.json({
      success: true,
      supplier,
      purchases,
      summary: {
        purchaseCount: purchases.length,
        totalPurchases,
        outstandingPayable,
        paidTotal
      }
    });
  } catch (error) {
    console.error('Inventory supplier detail error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/suppliers', adminPanelOnly, [
  body('name').trim().notEmpty().withMessage('Supplier name is required')
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const supplier = await Supplier.create({
      businessId: req.businessId,
      branchId: req.branchId || null,
      name: String(req.body.name).trim(),
      phone: String(req.body.phone || '').trim(),
      email: String(req.body.email || '').trim(),
      address: String(req.body.address || '').trim(),
      notes: String(req.body.notes || '').trim(),
      isActive: req.body.isActive !== false
    });
    res.status(201).json({ success: true, supplier });
  } catch (error) {
    console.error('Inventory create supplier error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/suppliers/:id', adminPanelOnly, async (req, res) => {
  try {
    const filter = applyBranchScope({ businessId: req.businessId, _id: req.params.id }, req);
    const supplier = await Supplier.findOne(filter);
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }
    if (req.body.name != null) supplier.name = String(req.body.name).trim();
    if (req.body.phone != null) supplier.phone = String(req.body.phone).trim();
    if (req.body.email != null) supplier.email = String(req.body.email).trim();
    if (req.body.address != null) supplier.address = String(req.body.address).trim();
    if (req.body.notes != null) supplier.notes = String(req.body.notes).trim();
    if (req.body.isActive != null) supplier.isActive = !!req.body.isActive;
    await supplier.save();
    res.json({ success: true, supplier });
  } catch (error) {
    console.error('Inventory update supplier error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/suppliers/:id', adminPanelOnly, async (req, res) => {
  try {
    const filter = applyBranchScope({ businessId: req.businessId, _id: req.params.id }, req);
    const supplier = await Supplier.findOne(filter);
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    const openPayable = await Purchase.exists({
      businessId: req.businessId,
      supplierId: supplier._id,
      outstandingAmount: { $gt: 0.009 }
    });
    if (openPayable) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete supplier with outstanding payable. Clear dues first, or mark inactive.'
      });
    }

    // Soft-delete if purchase history exists; hard-delete if never used
    const hasPurchases = await Purchase.exists({
      businessId: req.businessId,
      supplierId: supplier._id
    });
    if (hasPurchases) {
      supplier.isActive = false;
      await supplier.save();
      return res.json({ success: true, softDeleted: true, supplier });
    }

    await Supplier.deleteOne({ _id: supplier._id });
    res.json({ success: true, deleted: true });
  } catch (error) {
    console.error('Inventory delete supplier error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Purchases ──────────────────────────────────────────────────────────────

router.get('/purchases', async (req, res) => {
  try {
    const tz = await businessTz(req.businessId);
    const { startUtc, endUtc } = parseBusinessDateRange(
      tz,
      req.query.range || 'monthly',
      req.query.from,
      req.query.to
    );
    const filter = applyBranchScope({ businessId: req.businessId }, req);
    if (startUtc && endUtc) {
      filter.purchaseDate = { $gte: startUtc, $lt: endUtc };
    }
    const purchases = await Purchase.find(filter)
      .populate('supplierId', 'name phone')
      .sort({ purchaseDate: -1 })
      .limit(500)
      .lean();
    const total = roundMoney(
      purchases.reduce((s, p) => {
        const gt = Number(p.grandTotal);
        if (Number.isFinite(gt)) return s + gt;
        return s + (Number(p.subtotal) || 0);
      }, 0)
    );
    res.json({ success: true, purchases, total });
  } catch (error) {
    console.error('Inventory purchases list error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/purchases/:id', async (req, res) => {
  try {
    const filter = applyBranchScope({ businessId: req.businessId, _id: req.params.id }, req);
    const purchase = await Purchase.findOne(filter)
      .populate('supplierId', 'name phone email')
      .populate('items.serviceId', 'name sku unit')
      .lean();
    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }
    res.json({ success: true, purchase });
  } catch (error) {
    console.error('Inventory purchase get error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/purchases', adminPanelOnly, [
  body('items').isArray({ min: 1 }).withMessage('At least one line is required'),
  body('items.*.serviceId').notEmpty(),
  body('items.*.quantity').isFloat({ min: 0.001 }),
  body('items.*.unitCost').isFloat({ min: 0 }),
  body('billNumber').optional().trim().isString(),
  body('notes').optional().trim().isString(),
  body('billImage').optional({ nullable: true }).trim().isString()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;

    const { items, subtotal } = await buildPurchaseItems(req, req.body.items || []);
    const totals = computePurchaseTotals({
      subtotal,
      discountType: req.body.discountType,
      discountValue: req.body.discountValue,
      taxMode: req.body.taxMode,
      taxPercent: req.body.taxPercent,
      additionalCharges: req.body.additionalCharges,
      additionalChargesMode: req.body.additionalChargesMode
    });

    let supplierName = String(req.body.supplierName || '').trim();
    let supplierId = req.body.supplierId || null;
    if (supplierId) {
      const supplier = await Supplier.findOne(
        applyBranchScope({ businessId: req.businessId, _id: supplierId }, req)
      ).lean();
      if (!supplier) {
        return res.status(400).json({ success: false, message: 'Supplier not found' });
      }
      supplierName = supplier.name;
    }

    const purchaseDate = req.body.purchaseDate
      ? new Date(req.body.purchaseDate)
      : new Date();

    let settlement;
    try {
      settlement = resolvePurchaseSettlement(req.body, totals.grandTotal);
    } catch (settleErr) {
      return res.status(settleErr.status || 400).json({
        success: false,
        message: settleErr.message || 'Invalid payment'
      });
    }

    const purchase = await Purchase.create({
      businessId: req.businessId,
      branchId: req.branchId || null,
      supplierId,
      supplierName,
      billNumber: String(req.body.billNumber || '').trim(),
      purchaseDate,
      items,
      subtotal: totals.subtotal,
      discountType: totals.discountType,
      discountValue: totals.discountValue,
      discountAmount: totals.discountAmount,
      netGoodsAmount: totals.netGoodsAmount,
      taxMode: totals.taxMode,
      taxPercent: totals.taxPercent,
      taxAmount: totals.taxAmount,
      additionalCharges: totals.additionalCharges,
      additionalChargesMode: totals.additionalChargesMode,
      grandTotal: totals.grandTotal,
      billImage: String(req.body.billImage || '').trim(),
      settlementMode: settlement.settlementMode,
      outstandingAmount: settlement.outstandingAmount,
      paymentStatus: settlement.paymentStatus,
      creditDueDate: req.body.creditDueDate ? new Date(req.body.creditDueDate) : null,
      paymentMethod: settlement.paymentMethod,
      paymentCashAmount: settlement.paymentCashAmount,
      paymentOnlineAmount: settlement.paymentOnlineAmount,
      notes: String(req.body.notes || '').trim(),
      stockPosted: false,
      createdBy: req.user._id
    });

    try {
      await postPurchaseStockLines(req, purchase, items, purchaseDate);
      purchase.stockPosted = true;
      await purchase.save();
    } catch (err) {
      await Purchase.deleteOne({ _id: purchase._id });
      throw err;
    }

    try {
      await syncMoneyBookFromPurchase(purchase, { createdBy: req.user._id });
    } catch (syncErr) {
      console.error('Purchase cash/bank sync error:', syncErr?.message || syncErr);
    }

    const fresh = await Purchase.findById(purchase._id)
      .populate('supplierId', 'name phone')
      .lean();

    res.status(201).json({ success: true, purchase: fresh });
  } catch (error) {
    console.error('Inventory create purchase error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/** Update purchase — reverses old stock, re-posts, realigns Cash & Bank. */
router.put('/purchases/:id', adminPanelOnly, [
  body('items').isArray({ min: 1 }).withMessage('At least one line is required'),
  body('items.*.serviceId').notEmpty(),
  body('items.*.quantity').isFloat({ min: 0.001 }),
  body('items.*.unitCost').isFloat({ min: 0 }),
  body('billNumber').optional().trim().isString(),
  body('notes').optional().trim().isString(),
  body('billImage').optional({ nullable: true }).trim().isString()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid purchase id' });
    }

    const filter = applyBranchScope({ businessId: req.businessId, _id: req.params.id }, req);
    const purchase = await Purchase.findOne(filter);
    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }

    const { items, subtotal } = await buildPurchaseItems(req, req.body.items || []);
    const totals = computePurchaseTotals({
      subtotal,
      discountType: req.body.discountType,
      discountValue: req.body.discountValue,
      taxMode: req.body.taxMode,
      taxPercent: req.body.taxPercent,
      additionalCharges: req.body.additionalCharges,
      additionalChargesMode: req.body.additionalChargesMode
    });

    let supplierName = String(req.body.supplierName || '').trim();
    let supplierId = req.body.supplierId || null;
    if (supplierId) {
      const supplier = await Supplier.findOne(
        applyBranchScope({ businessId: req.businessId, _id: supplierId }, req)
      ).lean();
      if (!supplier) {
        return res.status(400).json({ success: false, message: 'Supplier not found' });
      }
      supplierName = supplier.name;
    } else {
      supplierId = null;
    }

    const purchaseDate = req.body.purchaseDate
      ? new Date(req.body.purchaseDate)
      : purchase.purchaseDate || new Date();

    let settlement;
    try {
      settlement = resolvePurchaseSettlement(req.body, totals.grandTotal);
    } catch (settleErr) {
      return res.status(settleErr.status || 400).json({
        success: false,
        message: settleErr.message || 'Invalid payment'
      });
    }

    if (purchase.stockPosted) {
      try {
        await reversePurchaseStockLines(req, purchase);
      } catch (revErr) {
        return res.status(revErr.status || 409).json({
          success: false,
          message: revErr.message || 'Cannot reverse previous stock for this purchase (insufficient stock).'
        });
      }
    }

    purchase.supplierId = supplierId;
    purchase.supplierName = supplierName;
    purchase.billNumber = String(req.body.billNumber || '').trim();
    purchase.purchaseDate = purchaseDate;
    purchase.items = items;
    purchase.subtotal = totals.subtotal;
    purchase.discountType = totals.discountType;
    purchase.discountValue = totals.discountValue;
    purchase.discountAmount = totals.discountAmount;
    purchase.netGoodsAmount = totals.netGoodsAmount;
    purchase.taxMode = totals.taxMode;
    purchase.taxPercent = totals.taxPercent;
    purchase.taxAmount = totals.taxAmount;
    purchase.additionalCharges = totals.additionalCharges;
    purchase.additionalChargesMode = totals.additionalChargesMode;
    purchase.grandTotal = totals.grandTotal;
    purchase.billImage = String(req.body.billImage || '').trim();
    purchase.settlementMode = settlement.settlementMode;
    purchase.outstandingAmount = settlement.outstandingAmount;
    purchase.paymentStatus = settlement.paymentStatus;
    purchase.creditDueDate = req.body.creditDueDate ? new Date(req.body.creditDueDate) : null;
    purchase.paymentMethod = settlement.paymentMethod;
    purchase.paymentCashAmount = settlement.paymentCashAmount;
    purchase.paymentOnlineAmount = settlement.paymentOnlineAmount;
    purchase.notes = String(req.body.notes || '').trim();
    purchase.stockPosted = false;
    await purchase.save();

    try {
      await postPurchaseStockLines(req, purchase, items, purchaseDate);
      purchase.stockPosted = true;
      await purchase.save();
    } catch (err) {
      console.error('Purchase edit restock failed:', err);
      throw err;
    }

    try {
      await syncMoneyBookFromPurchase(purchase, {
        createdBy: req.user._id,
        throwOnError: true,
        skipBalanceCheck: true,
        rebuildBalances: true
      });
    } catch (syncErr) {
      console.error('Purchase edit cash/bank sync error:', syncErr?.message || syncErr);
      return res.status(syncErr.status || 500).json({
        success: false,
        message: syncErr.message || 'Purchase saved but Cash & Bank sync failed'
      });
    }

    const fresh = await Purchase.findById(purchase._id)
      .populate('supplierId', 'name phone')
      .lean();

    res.json({ success: true, purchase: fresh });
  } catch (error) {
    console.error('Inventory update purchase error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/** Pay toward supplier purchase outstanding. */
router.post('/purchases/:id/pay', adminPanelOnly, [
  body('amount').isFloat({ min: 0.01 }).withMessage('Payment amount is required'),
  body('paymentMethod').optional().isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('paymentCashAmount').optional().isFloat({ min: 0 }),
  body('paymentOnlineAmount').optional().isFloat({ min: 0 })
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const filter = applyBranchScope({ businessId: req.businessId, _id: req.params.id }, req);
    const purchase = await Purchase.findOne(filter);
    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }

    const due = roundMoney(Number(purchase.outstandingAmount) || 0);
    if (due <= 0.009) {
      return res.status(400).json({ success: false, message: 'Nothing outstanding on this purchase' });
    }

    let cash = roundMoney(Number(req.body.paymentCashAmount) || 0);
    let online = roundMoney(Number(req.body.paymentOnlineAmount) || 0);
    let amount = roundMoney(Number(req.body.amount) || 0);
    const method = String(req.body.paymentMethod || 'CASH').toUpperCase();

    if (cash + online < 0.009 && amount > 0) {
      if (method === 'ONLINE') online = amount;
      else cash = amount;
    }
    const payNow = roundMoney(cash + online);
    if (payNow <= 0.009) {
      return res.status(400).json({ success: false, message: 'Enter a payment amount' });
    }
    if (payNow > due + 0.009) {
      return res.status(400).json({
        success: false,
        message: `Payment exceeds outstanding (${due})`
      });
    }

    purchase.paymentCashAmount = roundMoney((Number(purchase.paymentCashAmount) || 0) + cash);
    purchase.paymentOnlineAmount = roundMoney((Number(purchase.paymentOnlineAmount) || 0) + online);
    purchase.outstandingAmount = roundMoney(Math.max(0, due - payNow));
    if (purchase.outstandingAmount <= 0.009) {
      purchase.outstandingAmount = 0;
      purchase.paymentStatus = 'PAID';
    } else {
      purchase.paymentStatus = 'PARTIAL';
      purchase.settlementMode = 'CREDIT';
    }
    if (purchase.paymentCashAmount > 0.009 && purchase.paymentOnlineAmount > 0.009) {
      purchase.paymentMethod = 'SPLIT';
    } else if (purchase.paymentOnlineAmount > 0.009) {
      purchase.paymentMethod = 'ONLINE';
    } else {
      purchase.paymentMethod = 'CASH';
    }
    await purchase.save();

    try {
      await syncMoneyBookFromPurchase(purchase, {
        createdBy: req.user._id,
        skipBalanceCheck: true,
        rebuildBalances: true
      });
    } catch (syncErr) {
      console.error('Purchase pay cash/bank sync error:', syncErr?.message || syncErr);
    }

    res.json({ success: true, purchase });
  } catch (error) {
    console.error('Inventory purchase pay error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// ─── Reports ────────────────────────────────────────────────────────────────

router.get('/reports/opening-closing', async (req, res) => {
  try {
    const tz = await businessTz(req.businessId);
    const { startUtc, endUtc } = parseBusinessDateRange(
      tz,
      req.query.range || 'custom',
      req.query.from,
      req.query.to
    );
    if (!startUtc || !endUtc) {
      return res.status(400).json({
        success: false,
        message: 'Provide a date range (from / to)'
      });
    }

    const openingAsOf = new Date(startUtc.getTime() - 1);
    const closingAsOf = new Date(endUtc.getTime() - 1);

    const [opening, closing] = await Promise.all([
      stockSnapshotAsOf(req.businessId, openingAsOf),
      stockSnapshotAsOf(req.businessId, closingAsOf)
    ]);

    const openMap = new Map(opening.map((r) => [String(r.serviceId), r]));
    const rows = closing.map((c) => {
      const o = openMap.get(String(c.serviceId)) || {
        quantity: 0,
        value: 0,
        avgCost: 0
      };
      return {
        serviceId: c.serviceId,
        name: c.name,
        sku: c.sku,
        unit: c.unit,
        openingQty: o.quantity,
        openingValue: o.value,
        closingQty: c.quantity,
        closingValue: c.value,
        avgCost: c.avgCost,
        sellPrice: c.sellPrice
      };
    });

    // Include products that only appear in opening
    for (const o of opening) {
      if (!rows.some((r) => String(r.serviceId) === String(o.serviceId))) {
        rows.push({
          serviceId: o.serviceId,
          name: o.name,
          sku: o.sku,
          unit: o.unit,
          openingQty: o.quantity,
          openingValue: o.value,
          closingQty: 0,
          closingValue: 0,
          avgCost: o.avgCost,
          sellPrice: o.sellPrice
        });
      }
    }

    res.json({
      success: true,
      period: { start: startUtc, end: endUtc },
      rows,
      totals: {
        openingValue: roundMoney(rows.reduce((s, r) => s + r.openingValue, 0)),
        closingValue: roundMoney(rows.reduce((s, r) => s + r.closingValue, 0))
      }
    });
  } catch (error) {
    console.error('Opening-closing report error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/reports/movement', async (req, res) => {
  try {
    const tz = await businessTz(req.businessId);
    const { startUtc, endUtc } = parseBusinessDateRange(
      tz,
      req.query.range || 'monthly',
      req.query.from,
      req.query.to
    );
    const filter = applyBranchScope({ businessId: req.businessId }, req);
    if (startUtc && endUtc) {
      filter.movementDate = { $gte: startUtc, $lt: endUtc };
    }
    if (req.query.serviceId) filter.serviceId = req.query.serviceId;
    if (req.query.type) filter.type = String(req.query.type).toUpperCase();

    const movements = await StockLedger.find(filter)
      .populate('serviceId', 'name sku unit')
      .sort({ movementDate: -1, createdAt: -1 })
      .limit(1000)
      .lean();

    res.json({ success: true, movements });
  } catch (error) {
    console.error('Movement report error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/reports/product-profit', async (req, res) => {
  try {
    const tz = await businessTz(req.businessId);
    const { startUtc, endUtc } = parseBusinessDateRange(
      tz,
      req.query.range || 'monthly',
      req.query.from,
      req.query.to
    );
    if (!startUtc || !endUtc) {
      return res.status(400).json({ success: false, message: 'Provide a date range' });
    }

    const bid = new mongoose.Types.ObjectId(String(req.businessId));
    const cogsAgg = await StockLedger.aggregate([
      {
        $match: {
          businessId: bid,
          type: 'SALE',
          movementDate: { $gte: startUtc, $lt: endUtc }
        }
      },
      {
        $group: {
          _id: '$serviceId',
          qtySold: { $sum: { $abs: '$qtyDelta' } },
          cogs: { $sum: { $abs: '$valueDelta' } }
        }
      }
    ]);

    // Sales revenue from job invoice items is harder; approximate via Job directBill + mixed
    // using Invoice items linked to product serviceIds in period.
    const Invoice = (await import('../models/Invoice.model.js')).default;
    const salesAgg = await Invoice.aggregate([
      {
        $match: {
          businessId: bid,
          saleConfirmedAt: { $gte: startUtc, $lt: endUtc }
        }
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.serviceId',
          qtySold: { $sum: { $ifNull: ['$items.quantity', 1] } },
          salesValue: {
            $sum: {
              $multiply: [
                { $ifNull: ['$items.servicePrice', 0] },
                { $ifNull: ['$items.quantity', 1] }
              ]
            }
          }
        }
      }
    ]);

    const cogsMap = new Map(cogsAgg.map((r) => [String(r._id), r]));
    const salesMap = new Map(salesAgg.map((r) => [String(r._id), r]));
    const ids = new Set([...cogsMap.keys(), ...salesMap.keys()]);

    const products = await Service.find({
      businessId: req.businessId,
      _id: { $in: [...ids].filter((id) => mongoose.Types.ObjectId.isValid(id)) }
    })
      .select('name sku unit price avgCost isVariable skipWorkProcess')
      .lean();

    const productRows = products
      .filter((p) => p.isVariable && p.skipWorkProcess)
      .map((p) => {
        const id = String(p._id);
        const c = cogsMap.get(id) || { qtySold: 0, cogs: 0 };
        const s = salesMap.get(id) || { qtySold: 0, salesValue: 0 };
        const qty = roundQty(c.qtySold || s.qtySold || 0);
        const salesValue = roundMoney(s.salesValue || 0);
        const cogs = roundMoney(c.cogs || 0);
        const grossProfit = roundMoney(salesValue - cogs);
        return {
          serviceId: p._id,
          name: p.name,
          sku: p.sku || '',
          unit: p.unit || 'pcs',
          qtySold: qty,
          salesValue,
          cogs,
          grossProfit,
          marginPct: salesValue > 0.009 ? roundMoney((grossProfit / salesValue) * 100) : null
        };
      });

    res.json({
      success: true,
      period: { start: startUtc, end: endUtc },
      rows: productRows,
      totals: {
        salesValue: roundMoney(productRows.reduce((s, r) => s + r.salesValue, 0)),
        cogs: roundMoney(productRows.reduce((s, r) => s + r.cogs, 0)),
        grossProfit: roundMoney(productRows.reduce((s, r) => s + r.grossProfit, 0))
      }
    });
  } catch (error) {
    console.error('Product profit report error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Phase 5: reorder suggestions, returns, transfers ───────────────────────

router.get('/reorder-suggestions', async (req, res) => {
  try {
    const products = await Service.find(productFilter(req.businessId, req))
      .select('name sku unit price avgCost stockQuantity lowStockThreshold trackInventory isActive')
      .sort({ name: 1 })
      .lean();

    const suggestions = products
      .filter((p) => shouldTrackInventory(p) && p.isActive !== false)
      .map((p) => {
        const qty = Number(p.stockQuantity) || 0;
        const threshold = Number.isFinite(Number(p.lowStockThreshold))
          ? Number(p.lowStockThreshold)
          : 5;
        const suggestedQty = Math.max(0, Math.ceil(threshold * 2 - qty));
        return {
          serviceId: p._id,
          name: p.name,
          sku: p.sku || '',
          unit: p.unit || 'pcs',
          stockQuantity: qty,
          lowStockThreshold: threshold,
          avgCost: Number(p.avgCost) || 0,
          sellPrice: Number(p.price) || 0,
          status: qty <= 0 ? 'out' : qty <= threshold ? 'low' : 'ok',
          suggestedOrderQty: suggestedQty,
          estimatedCost: roundMoney(suggestedQty * (Number(p.avgCost) || 0))
        };
      })
      .filter((r) => r.status === 'out' || r.status === 'low')
      .sort((a, b) => a.stockQuantity - b.stockQuantity);

    res.json({
      success: true,
      suggestions,
      count: suggestions.length
    });
  } catch (error) {
    console.error('Reorder suggestions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/** Customer sale return → stock back in (ledger RETURN). */
router.post('/returns', adminPanelOnly, [
  body('serviceId').notEmpty().withMessage('Product is required'),
  body('quantity').isFloat({ min: 0.001 }).withMessage('Quantity must be positive'),
  body('notes').optional().trim().isString(),
  body('unitCost').optional().isFloat({ min: 0 }),
  body('jobId').optional().isString(),
  body('invoiceId').optional().isString()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const filter = productFilter(req.businessId, req);
    filter._id = req.body.serviceId;
    const product = await Service.findOne(filter).lean();
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    if (!shouldTrackInventory(product)) {
      return res.status(400).json({ success: false, message: 'Inventory is not tracked for this product' });
    }

    const qty = roundQty(Number(req.body.quantity));
    const result = await postStockMovement({
      businessId: req.businessId,
      branchId: req.branchId || product.branchId || null,
      serviceId: product._id,
      type: 'RETURN',
      qtyDelta: qty,
      unitCost: req.body.unitCost != null ? Number(req.body.unitCost) : null,
      refType: req.body.invoiceId || req.body.jobId ? 'RETURN' : 'MANUAL',
      refId: req.body.invoiceId || req.body.jobId || null,
      notes: req.body.notes || 'Sale return',
      createdBy: req.user._id
    });

    res.status(201).json({
      success: true,
      product: result.service,
      ledger: result.entry
    });
  } catch (error) {
    console.error('Inventory return error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * Move stock between two product catalog rows (e.g. same SKU at another branch).
 * Posts TRANSFER_OUT on source and TRANSFER_IN on destination.
 */
router.post('/transfers', adminPanelOnly, [
  body('fromServiceId').notEmpty().withMessage('Source product is required'),
  body('toServiceId').notEmpty().withMessage('Destination product is required'),
  body('quantity').isFloat({ min: 0.001 }).withMessage('Quantity must be positive'),
  body('notes').optional().trim().isString()
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const fromId = String(req.body.fromServiceId);
    const toId = String(req.body.toServiceId);
    if (fromId === toId) {
      return res.status(400).json({ success: false, message: 'Source and destination must differ' });
    }

    const from = await Service.findOne({ ...productFilter(req.businessId, req), _id: fromId }).lean();
    const to = await Service.findOne({
      businessId: req.businessId,
      _id: toId,
      isVariable: true,
      skipWorkProcess: true
    }).lean();

    if (!from || !to) {
      return res.status(404).json({ success: false, message: 'Source or destination product not found' });
    }
    if (!shouldTrackInventory(from) || !shouldTrackInventory(to)) {
      return res.status(400).json({ success: false, message: 'Both products must track inventory' });
    }

    const qty = roundQty(Number(req.body.quantity));
    const notes = req.body.notes || `Transfer to ${to.name}`;
    const transferGroupId = new mongoose.Types.ObjectId();

    let outResult;
    try {
      outResult = await postStockMovement({
        businessId: req.businessId,
        branchId: from.branchId || req.branchId || null,
        serviceId: from._id,
        type: 'TRANSFER_OUT',
        qtyDelta: -qty,
        unitCost: null,
        refType: 'TRANSFER',
        refId: transferGroupId,
        notes,
        createdBy: req.user._id
      });

      await postStockMovement({
        businessId: req.businessId,
        branchId: to.branchId || null,
        serviceId: to._id,
        type: 'TRANSFER_IN',
        qtyDelta: qty,
        unitCost: outResult.unitCost,
        refType: 'TRANSFER',
        refId: transferGroupId,
        notes: req.body.notes || `Transfer from ${from.name}`,
        createdBy: req.user._id
      });
    } catch (err) {
      if (outResult) {
        try {
          await postStockMovement({
            businessId: req.businessId,
            serviceId: from._id,
            type: 'ADJUST',
            qtyDelta: qty,
            unitCost: outResult.unitCost,
            refType: 'TRANSFER',
            refId: transferGroupId,
            notes: 'Transfer rollback',
            createdBy: req.user._id
          });
        } catch {
          /* best effort */
        }
      }
      throw err;
    }

    const [fromFresh, toFresh] = await Promise.all([
      Service.findById(from._id).lean(),
      Service.findById(to._id).lean()
    ]);

    res.status(201).json({
      success: true,
      transferId: transferGroupId,
      from: fromFresh,
      to: toFresh
    });
  } catch (error) {
    console.error('Inventory transfer error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

export default router;
