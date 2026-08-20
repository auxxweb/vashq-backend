import Invoice from '../models/Invoice.model.js';
import Job from '../models/Job.model.js';
import Customer from '../models/Customer.model.js';
import PaymentCollection from '../models/PaymentCollection.model.js';
import { computeLoyaltyEarnedForJobServices } from './directBillJob.js';
import { appendCreditLedgerEvent } from '../services/credit/creditLedgerService.js';
import { invalidateDashboardForBusiness } from './dashboardFinancialSync.js';

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Business-owner action: reopen a closed invoice so checkout/close can run again.
 * - Cash/full paid: clear RECEIVED
 * - Credit closed: clear saleConfirmedAt / credit mode
 * Does not restore product stock. Blocks if later collections exist.
 */
export async function reopenInvoiceAsUnpaid({
  businessId,
  invoiceId,
  user
}) {
  const invoice = await Invoice.findOne({ _id: invoiceId, businessId });
  if (!invoice) {
    const err = new Error('Invoice not found');
    err.status = 404;
    throw err;
  }

  const isFullyPaid = invoice.paymentStatus === 'RECEIVED';
  const isCreditClosed =
    invoice.settlementMode === 'CREDIT' && !!invoice.saleConfirmedAt;

  if (!isFullyPaid && !isCreditClosed) {
    const err = new Error('Invoice is already open for payment');
    err.status = 400;
    throw err;
  }

  const laterCollected = round2(Number(invoice.amountCollectedLater) || 0);
  if (laterCollected > 0.02) {
    const err = new Error(
      'Cannot mark unpaid: payments were collected after closing. Reverse those collections first.'
    );
    err.status = 400;
    throw err;
  }

  const laterCollection = await PaymentCollection.findOne({
    businessId,
    'allocations.invoiceId': invoice._id
  })
    .select('_id collectionNumber')
    .lean();
  if (laterCollection) {
    const err = new Error(
      'Cannot mark unpaid: this invoice has payment collection records. Reverse those collections first.'
    );
    err.status = 400;
    throw err;
  }

  // Reverse loyalty that was applied at close (so re-close can apply cleanly)
  const customerId = invoice.customerId;
  if (customerId) {
    const customer = await Customer.findOne({ _id: customerId, businessId })
      .select('loyaltyPointsBalance');
    if (customer) {
      let balance = Number(customer.loyaltyPointsBalance || 0);
      let changed = false;

      if (invoice.loyaltyRedeemAppliedAt) {
        const redeemPts = Math.max(0, Math.floor(Number(invoice.loyaltyRedeemedPoints) || 0));
        if (redeemPts > 0) {
          balance += redeemPts;
          changed = true;
        }
        invoice.loyaltyRedeemAppliedAt = null;
      }

      if (invoice.loyaltyEarnAppliedAt) {
        let earned = 0;
        if (invoice.jobId) {
          const job = await Job.findOne({ _id: invoice.jobId, businessId })
            .select('services')
            .lean();
          if (job?.services?.length) {
            earned = await computeLoyaltyEarnedForJobServices(businessId, job.services);
          }
        }
        if (earned > 0) {
          balance = Math.max(0, balance - earned);
          changed = true;
        }
        invoice.loyaltyEarnAppliedAt = null;
      }

      if (changed) {
        customer.loyaltyPointsBalance = balance;
        await customer.save();
      }
    } else {
      invoice.loyaltyRedeemAppliedAt = null;
      invoice.loyaltyEarnAppliedAt = null;
    }
  } else {
    invoice.loyaltyRedeemAppliedAt = null;
    invoice.loyaltyEarnAppliedAt = null;
  }

  // Credit ledger cancellation (if this was a credit sale)
  if (isCreditClosed && invoice.customerId) {
    const cancelAmount = Math.max(
      round2(Number(invoice.outstandingAmount) || 0),
      round2(
        Math.max(
          0,
          (Number(invoice.finalAmount) || 0) -
            (Number(invoice.advancePayment) || 0) -
            (Number(invoice.amountCollectedAtCheckout) || 0)
        )
      )
    );
    await appendCreditLedgerEvent({
      businessId,
      customerId: invoice.customerId,
      invoiceId: invoice._id,
      eventType: 'CANCELLATION',
      amount: cancelAmount,
      notes: 'Invoice marked unpaid / reopened for payment',
      createdBy: user?._id,
      metadata: { reason: 'MARK_UNPAID' }
    });
  }

  invoice.paymentStatus = 'PENDING';
  invoice.paymentReceivedAt = null;
  invoice.paymentCashAmount = 0;
  invoice.paymentOnlineAmount = 0;
  invoice.amountCollectedAtCheckout = 0;
  invoice.amountCollectedLater = 0;
  invoice.outstandingAmount = 0;

  if (isCreditClosed || invoice.settlementMode === 'CREDIT') {
    invoice.settlementMode = 'FULL';
    invoice.saleConfirmedAt = null;
    invoice.creditDueDate = null;
  }

  await invoice.save();

  // Job: keep work done, but payment pending again
  if (invoice.jobId) {
    await Job.findOneAndUpdate(
      { _id: invoice.jobId, businessId },
      {
        $set: { status: 'COMPLETED' },
        $unset: { actualDelivery: 1 }
      }
    );
  }

  invalidateDashboardForBusiness(businessId);

  const refreshed = await Invoice.findById(invoice._id).populate('jobId').lean();
  return {
    invoice: refreshed || invoice,
    message: 'Invoice marked unpaid — you can close payment again'
  };
}
