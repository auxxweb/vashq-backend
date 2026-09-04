/**
 * Fresh-start purge for one business: delete operational/transactional records
 * before a cutoff date, while keeping catalog + branch setup needed to run the app.
 *
 * KEEP: Business, BusinessSettings, Branch*, Users, Services/Categories/SubCategories,
 * PackageTemplate, ExpenseType, OtherRevenueType, CashMovementType, MoneyAccount,
 * Supplier, WhatsAppTemplate, LeadSource/LeadStatus, subscriptions.
 *
 * DELETE (createdAt < cutoff): Jobs, Invoices, Expenses, OtherRevenue,
 * Bookings, Leads, Collections, Credit events, Money ledger, Cash day sessions,
 * Attendance, AI insights, Audit logs, Notifications, Push logs, WhatsApp messages,
 * Purchases, Stock ledger, Settlement requests, Owner tasks, OTP, Packages sold/visits,
 * Estimates, Support tickets (business-scoped).
 *
 * NEVER deletes: Customers, Cars (customer-related data is retained).
 *
 * Usage:
 *   node scripts/purge-mojo-fresh-start.mjs --dry-run
 *   node scripts/purge-mojo-fresh-start.mjs --confirm --execute
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';

import Job from '../models/Job.model.js';
import Invoice from '../models/Invoice.model.js';
import Expense from '../models/Expense.model.js';
import OtherRevenue from '../models/OtherRevenue.model.js';
import Booking from '../models/Booking.model.js';
import BookingSlot from '../models/BookingSlot.model.js';
import Estimate from '../models/Estimate.model.js';
import Lead from '../models/Lead.model.js';
import PaymentCollection from '../models/PaymentCollection.model.js';
import CreditLedgerEvent from '../models/CreditLedgerEvent.model.js';
import MoneyLedger from '../models/MoneyLedger.model.js';
import CashDaySession from '../models/CashDaySession.model.js';
import AttendanceDay from '../models/AttendanceDay.model.js';
import AttendanceCorrectionRequest from '../models/AttendanceCorrectionRequest.model.js';
import AiInsight from '../models/AiInsight.model.js';
import AuditLog from '../models/AuditLog.model.js';
import Notification from '../models/Notification.model.js';
import PushNotificationLog from '../models/PushNotificationLog.model.js';
import WhatsAppMessage from '../models/WhatsAppMessage.model.js';
import Purchase from '../models/Purchase.model.js';
import StockLedger from '../models/StockLedger.model.js';
import SettlementChangeRequest from '../models/SettlementChangeRequest.model.js';
import OwnerTask from '../models/OwnerTask.model.js';
import OtpToken from '../models/OtpToken.model.js';
import CustomerPackage from '../models/CustomerPackage.model.js';
import PackageVisit from '../models/PackageVisit.model.js';
import SupportTicket from '../models/SupportTicket.model.js';
import NumberSequence from '../models/NumberSequence.model.js';
import Business from '../models/Business.model.js';
import User from '../models/User.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DEFAULT_EMAIL = 'mojoautocafe@gmail.com';
const DEFAULT_TZ = 'Asia/Kolkata';

const PURGE_MODELS = [
  ['jobs', Job],
  ['invoices', Invoice],
  ['expenses', Expense],
  ['otherRevenues', OtherRevenue],
  // Customers & Cars are intentionally NOT purged — keep CRM history for a fresh ops start.
  ['bookings', Booking],
  ['bookingSlots', BookingSlot],
  ['estimates', Estimate],
  ['leads', Lead],
  ['paymentCollections', PaymentCollection],
  ['creditLedgerEvents', CreditLedgerEvent],
  ['moneyLedgers', MoneyLedger],
  ['cashDaySessions', CashDaySession],
  ['attendanceDays', AttendanceDay],
  ['attendanceCorrectionRequests', AttendanceCorrectionRequest],
  ['aiInsights', AiInsight],
  ['auditLogs', AuditLog],
  ['notifications', Notification],
  ['pushNotificationLogs', PushNotificationLog],
  ['whatsappMessages', WhatsAppMessage],
  ['purchases', Purchase],
  ['stockLedgers', StockLedger],
  ['settlementChangeRequests', SettlementChangeRequest],
  ['ownerTasks', OwnerTask],
  ['otpTokens', OtpToken],
  ['customerPackages', CustomerPackage],
  ['packageVisits', PackageVisit],
  ['supportTickets', SupportTicket]
];

function parseArgs(argv) {
  const args = new Set(argv);
  const getValue = (name) => {
    const idx = argv.findIndex((a) => a === name);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  const dryRun =
    args.has('--dry-run') ||
    args.has('--dryrun') ||
    args.has('--preview') ||
    (!args.has('--execute') && !args.has('--confirm') && !args.has('--no-dry-run'));

  const confirmDelete =
    args.has('--confirm') || args.has('--yes') || args.has('--i-understand');

  return {
    email: getValue('--email') || DEFAULT_EMAIL,
    businessId: getValue('--businessId') || getValue('--business-id'),
    cutoffIso: getValue('--cutoff'),
    timezone: getValue('--tz') || DEFAULT_TZ,
    dryRun,
    confirmDelete,
    resetSequences: args.has('--reset-sequences') || args.has('--execute')
  };
}

function startOfTodayUtc(timezone) {
  return DateTime.now().setZone(timezone).startOf('day').toUTC().toJSDate();
}

async function resolveBusiness({ email, businessId }) {
  if (businessId) {
    if (!mongoose.isValidObjectId(businessId)) throw new Error(`Invalid businessId: ${businessId}`);
    const business = await Business.findById(businessId).lean();
    if (!business) throw new Error(`Business not found: ${businessId}`);
    return business;
  }

  const owner = await User.findOne({
    email: String(email).trim().toLowerCase(),
    role: { $in: ['CAR_WASH_ADMIN', 'BUSINESS_OWNER', 'ADMIN', 'OWNER'] }
  })
    .select('email name role businessId')
    .lean();

  if (!owner?.businessId) {
    // Fallback: any user with that email
    const any = await User.findOne({ email: String(email).trim().toLowerCase() })
      .select('email name role businessId')
      .lean();
    if (!any?.businessId) throw new Error(`No user/business found for email: ${email}`);
    const business = await Business.findById(any.businessId).lean();
    if (!business) throw new Error(`Business missing for user ${email}`);
    return business;
  }

  const business = await Business.findById(owner.businessId).lean();
  if (!business) throw new Error(`Business missing for ${email}`);
  return business;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI required');

  await mongoose.connect(uri);

  try {
    const business = await resolveBusiness(opts);
    const businessId = business._id;
    const cutoff = opts.cutoffIso
      ? new Date(opts.cutoffIso)
      : startOfTodayUtc(opts.timezone);

    if (Number.isNaN(cutoff.valueOf())) throw new Error(`Invalid cutoff: ${opts.cutoffIso}`);

    const shouldDelete = opts.confirmDelete && !opts.dryRun;

    function filterForModel(key) {
      if (key === 'expenses') {
        return {
          businessId,
          $or: [
            { expenseDate: { $lt: cutoff } },
            { expenseDate: null, createdAt: { $lt: cutoff } },
            { expenseDate: { $exists: false }, createdAt: { $lt: cutoff } }
          ]
        };
      }
      if (key === 'otherRevenues') {
        return {
          businessId,
          $or: [
            { revenueDate: { $lt: cutoff } },
            { revenueDate: null, createdAt: { $lt: cutoff } },
            { revenueDate: { $exists: false }, createdAt: { $lt: cutoff } }
          ]
        };
      }
      if (key === 'moneyLedgers') {
        return {
          businessId,
          $or: [
            { entryDate: { $lt: cutoff } },
            { entryDate: null, createdAt: { $lt: cutoff } },
            { entryDate: { $exists: false }, createdAt: { $lt: cutoff } }
          ]
        };
      }
      return {
        businessId,
        createdAt: { $lt: cutoff }
      };
    }

    console.log('=== Business fresh-start purge ===');
    console.log('Business:', business.businessName, String(businessId));
    console.log('Owner on record:', business.ownerName || '—', business.email || '—');
    console.log('Cutoff (exclusive, keep from this instant):', cutoff.toISOString());
    console.log('Timezone used for “today”:', opts.timezone);
    console.log('Mode:', shouldDelete ? 'DELETE' : 'DRY_RUN');
    console.log('Customers/Cars: KEPT');
    console.log('');

    const counts = {};
    for (const [key, Model] of PURGE_MODELS) {
      counts[key] = await Model.countDocuments(filterForModel(key));
    }

    console.log('Records matching filter (before cutoff):');
    let total = 0;
    for (const [key, n] of Object.entries(counts)) {
      if (n > 0) console.log(`  ${key}: ${n}`);
      total += n;
    }
    console.log(`  TOTAL: ${total}`);

    // Also report kept catalog sizes
    const kept = {
      customers: await mongoose.connection.db.collection('customers').countDocuments({ businessId }),
      cars: await mongoose.connection.db.collection('cars').countDocuments({ businessId }),
      services: await mongoose.connection.db.collection('services').countDocuments({ businessId }),
      serviceCategories: await mongoose.connection.db.collection('servicecategories').countDocuments({ businessId }),
      branches: await mongoose.connection.db.collection('branches').countDocuments({ businessId }),
      users: await mongoose.connection.db.collection('users').countDocuments({ businessId }),
      packageTemplates: await mongoose.connection.db.collection('packagetemplates').countDocuments({ businessId }),
      expenseTypes: await mongoose.connection.db.collection('expensetypes').countDocuments({ businessId }),
      moneyAccounts: await mongoose.connection.db.collection('moneyaccounts').countDocuments({ businessId })
    };
    console.log('\nKept (not deleted):');
    for (const [k, n] of Object.entries(kept)) console.log(`  ${k}: ${n}`);

    if (!shouldDelete) {
      console.log('\nNo deletions. Re-run with: --confirm --execute --email <email> --cutoff <ISO>');
      return;
    }

    console.log('\nDeleting…');
    const deleted = {};
    for (const [key, Model] of PURGE_MODELS) {
      const res = await Model.deleteMany(filterForModel(key));
      deleted[key] = res.deletedCount ?? 0;
      if (deleted[key] > 0) console.log(`  deleted ${key}: ${deleted[key]}`);
    }

    if (opts.resetSequences) {
      const seqRes = await NumberSequence.deleteMany({ businessId });
      console.log(`  reset number sequences: ${seqRes.deletedCount ?? 0}`);
    }

    console.log('\nDone. Fresh start from cutoff onward.');
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Purge failed:', err);
  process.exit(1);
});
