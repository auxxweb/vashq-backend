import Job from '../../models/Job.model.js';
import { applyLoyaltySettlementForJob } from '../../utils/directBillJob.js';
import {
  isCreditSettlementMode,
  normalizeCreditCheckoutPayment,
  parseCreditDueDate
} from '../../utils/creditPayment.js';
import {
  getCheckoutTotal,
  isFullyPaid,
  syncInvoiceOutstanding
} from './outstandingService.js';
import { appendCreditLedgerEvent } from './creditLedgerService.js';
import { sendPushNotification } from '../notificationService.js';
import User from '../../models/User.model.js';
import { invalidateDashboardForBusiness } from '../../utils/dashboardFinancialSync.js';

async function earnLoyaltyForJob(businessId, job, invoice, { earnPoints = true } = {}) {
  if (!job?.customerId) return;
  await applyLoyaltySettlementForJob(businessId, job.customerId, job.services, invoice, { earnPoints });
}

async function notifyJobClosed(user, businessId, invoice, jobId) {
  try {
    const ownerId = user.role === 'CAR_WASH_ADMIN'
      ? user._id
      : (await User.findOne({ businessId, role: 'CAR_WASH_ADMIN', status: 'ACTIVE' }).select('_id').lean())?._id;
    if (ownerId) {
      await sendPushNotification({
        businessOwnerId: ownerId,
        title: 'Booking completed',
        body: invoice.settlementMode === 'CREDIT' && !isFullyPaid(invoice)
          ? 'Booking closed with amount due.'
          : 'Invoice marked paid. Booking closed.',
        data: { type: 'job_closed', bookingId: jobId, url: `/admin/invoices/${invoice._id}` }
      });
    }
  } catch (e) {
    console.error('Push job_closed (credit):', e);
  }
}

/**
 * Apply credit close fields to an invoice document (does not save).
 */
export function applyCreditCloseToInvoice(invoice, body = {}) {
  if (invoice.settlementMode === 'CREDIT' && invoice.saleConfirmedAt) {
    const err = new Error('Credit sale already recorded for this invoice');
    err.status = 409;
    throw err;
  }

  normalizeCreditCheckoutPayment(invoice, body);

  invoice.settlementMode = 'CREDIT';
  invoice.saleConfirmedAt = new Date();
  invoice.creditDueDate = parseCreditDueDate(body.creditDueDate);
  invoice.amountCollectedLater = Number(invoice.amountCollectedLater) || 0;

  syncInvoiceOutstanding(invoice);

  return invoice;
}

export async function closeJobOnCredit({ invoice, job, businessId, user, body }) {
  if (!invoice.customerId && !job?.customerId) {
    const err = new Error('Credit sales require a registered customer');
    err.status = 400;
    throw err;
  }
  if (!invoice.customerId && job?.customerId) {
    invoice.customerId = job.customerId;
  }

  applyCreditCloseToInvoice(invoice, body);
  await invoice.save();
  invalidateDashboardForBusiness(businessId);

  await Job.findOneAndUpdate(
    { _id: invoice.jobId, businessId },
    { $set: { status: 'DELIVERED', actualDelivery: new Date() } }
  );

  await appendCreditLedgerEvent({
    businessId,
    customerId: invoice.customerId,
    invoiceId: invoice._id,
    eventType: 'CREDIT_CREATED',
    amount: invoice.outstandingAmount,
    metadata: {
      invoiceNumber: invoice.invoiceNumber,
      finalAmount: invoice.finalAmount,
      collectedAtCheckout: getCheckoutTotal(invoice),
      outstandingAmount: invoice.outstandingAmount,
      creditDueDate: invoice.creditDueDate || null
    },
    createdBy: user._id
  });

  const fullyPaid = isFullyPaid(invoice);
  await earnLoyaltyForJob(businessId, job, invoice, { earnPoints: fullyPaid });

  notifyJobClosed(user, businessId, invoice, invoice.jobId).catch(() => {});

  return {
    invoice,
    message: isFullyPaid(invoice) ? 'Job closed and fully paid' : 'Job closed with amount due'
  };
}

export async function closePackageOnCredit({ invoice, businessId, user, body, customerId }) {
  if (!invoice.customerId && customerId) {
    invoice.customerId = customerId;
  }
  if (!invoice.customerId) {
    const err = new Error('Credit sales require a registered customer');
    err.status = 400;
    throw err;
  }

  applyCreditCloseToInvoice(invoice, body);
  await invoice.save();
  invalidateDashboardForBusiness(businessId);

  await appendCreditLedgerEvent({
    businessId,
    customerId: invoice.customerId,
    invoiceId: invoice._id,
    eventType: 'CREDIT_CREATED',
    amount: invoice.outstandingAmount,
    metadata: {
      invoiceNumber: invoice.invoiceNumber,
      finalAmount: invoice.finalAmount,
      collectedAtCheckout: getCheckoutTotal(invoice),
      outstandingAmount: invoice.outstandingAmount,
      creditDueDate: invoice.creditDueDate || null,
      saleType: 'PACKAGE'
    },
    createdBy: user._id
  });

  return {
    invoice,
    message: isFullyPaid(invoice) ? 'Package marked paid' : 'Package sale recorded with amount due'
  };
}

export { isCreditSettlementMode };
