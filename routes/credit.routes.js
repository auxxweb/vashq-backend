import express from 'express';
import mongoose from 'mongoose';
import { body, validationResult } from 'express-validator';
import Invoice from '../models/Invoice.model.js';
import PaymentCollection from '../models/PaymentCollection.model.js';
import CreditLedgerEvent from '../models/CreditLedgerEvent.model.js';
import Customer from '../models/Customer.model.js';
import { recordCollection, sumCustomerOutstanding } from '../services/credit/collectionService.js';
import {
  computeOutstanding,
  deriveCollectionDisplayStatus,
  getTotalCollected
} from '../services/credit/outstandingService.js';

const router = express.Router();

const EPS = 0.02;

// POST /api/admin/credit/collections
router.post('/collections', [
  body('customerId').notEmpty(),
  body('amount').isFloat({ min: 0.01 }),
  body('paymentMethod').isIn(['CASH', 'ONLINE', 'SPLIT']),
  body('paymentCashAmount').optional().isFloat({ min: 0 }),
  body('paymentOnlineAmount').optional().isFloat({ min: 0 }),
  body('allocationMode').optional().isIn(['FIFO', 'MANUAL']),
  body('preferInvoiceId').optional().trim(),
  body('manualAllocations').optional().isArray(),
  body('notes').optional().trim(),
  body('idempotencyKey').optional().trim(),
  body('collectionDate').optional().isISO8601()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const result = await recordCollection({
      businessId: req.businessId,
      customerId: req.body.customerId,
      amount: Number(req.body.amount),
      paymentMethod: req.body.paymentMethod,
      paymentCashAmount: req.body.paymentCashAmount,
      paymentOnlineAmount: req.body.paymentOnlineAmount,
      allocationMode: req.body.allocationMode || 'FIFO',
      manualAllocations: req.body.manualAllocations,
      preferInvoiceId: req.body.preferInvoiceId,
      notes: req.body.notes,
      collectedBy: req.user._id,
      idempotencyKey: req.body.idempotencyKey,
      collectionDate: req.body.collectionDate
    });

    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      duplicate: result.duplicate,
      data: result.collection
    });
  } catch (error) {
    console.error('Record collection error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// GET /api/admin/credit/customers/:id/summary
router.get('/customers/:id/summary', async (req, res) => {
  try {
    const customerId = req.params.id;
    if (!mongoose.isValidObjectId(customerId)) {
      return res.status(400).json({ success: false, message: 'Invalid customer id' });
    }

    const customer = await Customer.findOne({ _id: customerId, businessId: req.businessId })
      .select('name phone')
      .lean();
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const invoices = await Invoice.find({
      businessId: req.businessId,
      customerId,
      settlementMode: 'CREDIT',
      saleConfirmedAt: { $ne: null }
    }).select('finalAmount outstandingAmount amountCollectedAtCheckout amountCollectedLater paymentCashAmount paymentOnlineAmount advancePayment finalAmount settlementMode saleConfirmedAt paymentStatus').lean();

    let totalSales = 0;
    let totalCollections = 0;
    for (const inv of invoices) {
      totalSales += Number(inv.finalAmount) || 0;
      totalCollections += getTotalCollected(inv);
    }

    const totalOutstanding = sumCustomerOutstanding(invoices);

    res.json({
      success: true,
      data: {
        customer,
        totalSales: Math.round(totalSales * 100) / 100,
        totalCollections: Math.round(totalCollections * 100) / 100,
        totalOutstanding,
        openInvoiceCount: invoices.filter((inv) => computeOutstanding(inv) > EPS).length
      }
    });
  } catch (error) {
    console.error('Customer credit summary error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/credit/customers/:id/invoices
router.get('/customers/:id/invoices', async (req, res) => {
  try {
    const customerId = req.params.id;
    if (!mongoose.isValidObjectId(customerId)) {
      return res.status(400).json({ success: false, message: 'Invalid customer id' });
    }

    const openOnly = req.query.openOnly !== 'false';
    const query = {
      businessId: req.businessId,
      customerId,
      settlementMode: 'CREDIT',
      saleConfirmedAt: { $ne: null }
    };
    if (openOnly) {
      query.outstandingAmount = { $gt: EPS };
    }

    const invoices = await Invoice.find(query)
      .select('invoiceNumber createdAt saleConfirmedAt finalAmount outstandingAmount paymentStatus settlementMode advancePayment paymentCashAmount paymentOnlineAmount amountCollectedLater creditDueDate')
      .sort({ saleConfirmedAt: 1, createdAt: 1 })
      .lean();

    const data = invoices.map((inv) => ({
      ...inv,
      paidAmount: getTotalCollected(inv),
      collectionStatus: deriveCollectionDisplayStatus(inv)
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Customer credit invoices error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/credit/customers/:id/collections
router.get('/customers/:id/collections', async (req, res) => {
  try {
    const customerId = req.params.id;
    if (!mongoose.isValidObjectId(customerId)) {
      return res.status(400).json({ success: false, message: 'Invalid customer id' });
    }

    const collections = await PaymentCollection.find({
      businessId: req.businessId,
      customerId
    })
      .sort({ collectionDate: -1, createdAt: -1 })
      .limit(Math.min(200, parseInt(req.query.limit, 10) || 50))
      .lean();

    res.json({ success: true, data: collections });
  } catch (error) {
    console.error('Customer collections history error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/credit/customers/:id/ledger
router.get('/customers/:id/ledger', async (req, res) => {
  try {
    const customerId = req.params.id;
    if (!mongoose.isValidObjectId(customerId)) {
      return res.status(400).json({ success: false, message: 'Invalid customer id' });
    }

    const events = await CreditLedgerEvent.find({
      businessId: req.businessId,
      customerId
    })
      .sort({ createdAt: -1 })
      .limit(Math.min(500, parseInt(req.query.limit, 10) || 100))
      .lean();

    res.json({ success: true, data: events });
  } catch (error) {
    console.error('Customer credit ledger error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
