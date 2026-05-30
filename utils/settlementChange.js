/**
 * Apply approved settlement date/time changes to job delivery and invoice timestamps.
 */
export async function applySettlementDateChange({ job, invoice, proposedDeliveredAt, proposedInvoiceAt, session }) {
  const deliveredAt = new Date(proposedDeliveredAt);
  const invoiceAt = new Date(proposedInvoiceAt);
  if (Number.isNaN(deliveredAt.getTime()) || Number.isNaN(invoiceAt.getTime())) {
    throw new Error('Invalid settlement date/time');
  }

  const statusHistory = (job.statusHistory || []).map((entry) => {
    const plain = entry.toObject ? entry.toObject() : { ...entry };
    if (plain.status === 'DELIVERED') {
      return { ...plain, changedAt: deliveredAt };
    }
    return plain;
  });

  job.actualDelivery = deliveredAt;
  job.updatedAt = deliveredAt;
  job.statusHistory = statusHistory;
  await job.save(session ? { session } : undefined);

  await invoice.constructor.collection.updateOne(
    { _id: invoice._id },
    {
      $set: {
        createdAt: invoiceAt,
        paymentReceivedAt: invoiceAt,
        updatedAt: invoiceAt
      }
    },
    session ? { session } : undefined
  );

  return { deliveredAt, invoiceAt };
}
