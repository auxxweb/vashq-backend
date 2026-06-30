import mongoose from 'mongoose';
import Invoice from '../models/Invoice.model.js';

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function bizOid(businessId) {
  return new mongoose.Types.ObjectId(String(businessId));
}

function branchClause(branchId) {
  return branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};
}

function notCreditClause() {
  return {
    $or: [
      { settlementMode: { $ne: 'CREDIT' } },
      { settlementMode: null },
      { settlementMode: { $exists: false } }
    ]
  };
}

function deliveredWashJobLookup(startUtc, endUtc) {
  return {
    from: 'jobs',
    let: { jid: '$jobId' },
    pipeline: [
      {
        $match: {
          $expr: { $eq: ['$_id', '$$jid'] },
          directBill: { $ne: true },
          status: 'DELIVERED',
          $or: [
            { actualDelivery: { $gte: startUtc, $lt: endUtc } },
            { actualDelivery: { $exists: false }, updatedAt: { $gte: startUtc, $lt: endUtc } }
          ]
        }
      },
      { $limit: 1 }
    ],
    as: 'job'
  };
}

function productSaleJobLookup(createdRange) {
  return {
    from: 'jobs',
    let: { jid: '$jobId' },
    pipeline: [
      {
        $match: {
          $expr: { $eq: ['$_id', '$$jid'] },
          directBill: true,
          createdAt: createdRange
        }
      },
      { $limit: 1 }
    ],
    as: 'job'
  };
}

/**
 * Mutually exclusive sales buckets for a dashboard period:
 * job (wash) + product + package + credit (pay-later confirmed in period).
 */
export async function getPeriodSalesBreakdown(businessId, startUtc, endUtc, branchId = null) {
  const businessObjectId = bizOid(businessId);
  const branch = branchClause(branchId);
  const createdRange = { $gte: startUtc, $lt: endUtc };
  const creditConfirmedRange = { $gte: startUtc, $lt: endUtc };

  const baseMatch = { businessId: businessObjectId, ...branch };

  const [jobAgg, productAgg, packageAgg, creditAgg] = await Promise.all([
    Invoice.aggregate([
      { $match: { ...baseMatch, ...notCreditClause() } },
      { $lookup: deliveredWashJobLookup(startUtc, endUtc) },
      { $match: { job: { $ne: [] } } },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } }
    ]),
    Invoice.aggregate([
      { $match: { ...baseMatch, ...notCreditClause() } },
      { $lookup: productSaleJobLookup(createdRange) },
      { $match: { job: { $ne: [] } } },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } }
    ]),
    Invoice.aggregate([
      {
        $match: {
          ...baseMatch,
          saleType: 'PACKAGE',
          createdAt: createdRange,
          ...notCreditClause()
        }
      },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } }
    ]),
    Invoice.aggregate([
      {
        $match: {
          ...baseMatch,
          settlementMode: 'CREDIT',
          saleConfirmedAt: creditConfirmedRange
        }
      },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } }
    ])
  ]);

  const jobSalesRevenue = roundMoney(jobAgg[0]?.total ?? 0);
  const productSalesRevenue = roundMoney(productAgg[0]?.total ?? 0);
  const packageSalesRevenue = roundMoney(packageAgg[0]?.total ?? 0);
  const creditSalesRevenue = roundMoney(creditAgg[0]?.total ?? 0);
  const totalSalesRevenue = roundMoney(
    jobSalesRevenue + productSalesRevenue + packageSalesRevenue + creditSalesRevenue
  );

  return {
    jobSalesRevenue,
    productSalesRevenue,
    packageSalesRevenue,
    creditSalesRevenue,
    totalSalesRevenue
  };
}

function productSaleJobLookupAny() {
  return {
    from: 'jobs',
    let: { jid: '$jobId' },
    pipeline: [
      {
        $match: {
          $expr: { $eq: ['$_id', '$$jid'] },
          directBill: true
        }
      },
      { $limit: 1 }
    ],
    as: 'job'
  };
}

function washJobInvoiceLookup() {
  return {
    from: 'jobs',
    let: { jid: '$jobId' },
    pipeline: [
      {
        $match: {
          $expr: { $eq: ['$_id', '$$jid'] },
          directBill: { $ne: true }
        }
      },
      { $limit: 1 }
    ],
    as: 'job'
  };
}

function collectedAmountExpression() {
  return {
    $let: {
      vars: {
        pc: { $ifNull: ['$paymentCashAmount', 0] },
        po: { $ifNull: ['$paymentOnlineAmount', 0] },
        stored: {
          $add: [
            { $ifNull: ['$paymentCashAmount', 0] },
            { $ifNull: ['$paymentOnlineAmount', 0] }
          ]
        },
        effAdv: {
          $min: [{ $ifNull: ['$advancePayment', 0] }, { $ifNull: ['$finalAmount', 0] }]
        }
      },
      in: {
        $cond: [
          { $gt: ['$$stored', 0.01] },
          '$$stored',
          {
            $max: [
              0,
              { $subtract: [{ $ifNull: ['$finalAmount', 0] }, '$$effAdv'] }
            ]
          }
        ]
      }
    }
  };
}

/**
 * Amount actually received in period (non-credit): wash jobs + products + packages.
 */
export async function getPeriodSalesReceivedBreakdown(businessId, startUtc, endUtc, branchId = null) {
  const businessObjectId = bizOid(businessId);
  const branch = branchClause(branchId);
  const receivedRange = { $gte: startUtc, $lt: endUtc };
  const baseMatch = {
    businessId: businessObjectId,
    ...branch,
    paymentStatus: 'RECEIVED',
    paymentReceivedAt: receivedRange,
    ...notCreditClause()
  };

  const [jobAgg, productAgg, packageAgg] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          ...baseMatch,
          jobId: { $exists: true, $ne: null }
        }
      },
      { $lookup: washJobInvoiceLookup() },
      { $match: { job: { $ne: [] } } },
      { $group: { _id: null, total: { $sum: collectedAmountExpression() } } }
    ]),
    Invoice.aggregate([
      { $match: baseMatch },
      { $lookup: productSaleJobLookupAny() },
      { $match: { job: { $ne: [] } } },
      { $group: { _id: null, total: { $sum: collectedAmountExpression() } } }
    ]),
    Invoice.aggregate([
      {
        $match: {
          ...baseMatch,
          saleType: 'PACKAGE'
        }
      },
      { $group: { _id: null, total: { $sum: collectedAmountExpression() } } }
    ])
  ]);

  const jobSalesReceived = roundMoney(jobAgg[0]?.total ?? 0);
  const productSalesReceived = roundMoney(productAgg[0]?.total ?? 0);
  const packageSalesReceived = roundMoney(packageAgg[0]?.total ?? 0);
  const totalSalesReceived = roundMoney(
    jobSalesReceived + productSalesReceived + packageSalesReceived
  );

  return {
    jobSalesReceived,
    productSalesReceived,
    packageSalesReceived,
    totalSalesReceived
  };
}
