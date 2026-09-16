/**
 * Import Care Point Aug 2026 sheet expenses for carepointtkr@gmail.com.
 *
 * Category → expense type (typos merged: Salary/salary, Shop Rent, Maintenance).
 * Blank category → Other.
 * Expense column → notes.
 * Paid in full as CASH (sheet has no payment mode).
 * Cash & Bank is left untouched when that module is off.
 *
 *   node scripts/import-carepoint-historical-expenses.mjs
 *   node scripts/import-carepoint-historical-expenses.mjs --apply
 *   node scripts/import-carepoint-historical-expenses.mjs --rollback --confirm
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import Expense from '../models/Expense.model.js';
import ExpenseType from '../models/ExpenseType.model.js';
import User from '../models/User.model.js';
import Branch from '../models/Branch.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import { parseBusinessCalendarDate } from '../utils/calendarDate.js';
import { resolveExpensePaymentFields } from '../utils/expensePayment.js';
import { roundMoney } from '../utils/invoicePayment.js';
import { invalidateDashboardForBusiness } from '../utils/dashboardFinancialSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const EMAIL = 'carepointtkr@gmail.com';
const IMPORT_REF = 'CP-EXP-2026H2';
const IMPORT_TAG = `[${IMPORT_REF}]`;
const TZ = 'Asia/Kolkata';
const DATA_FILE = path.resolve(__dirname, 'data', 'carepoint-historical-expenses-2026.tsv');

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
};

const TYPE_ALIASES = {
  diesel: 'Diesel',
  'shop expense': 'Shop Expense',
  'salary+': 'Salary+',
  salary: 'Salary',
  maintenance: 'Maintenance',
  maintanance: 'Maintenance',
  chemicals: 'Chemicals',
  'shop rent': 'Shop Rent'
};

function parseArgs(argv) {
  const args = new Set(argv);
  const getValue = (name) => {
    const idx = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (idx === -1) return undefined;
    if (argv[idx].includes('=')) return argv[idx].split('=').slice(1).join('=');
    return argv[idx + 1];
  };
  return {
    apply: args.has('--apply') || (args.has('--confirm') && args.has('--execute')),
    rollback: args.has('--rollback'),
    confirm: args.has('--confirm') || args.has('--yes'),
    email: getValue('--email') || EMAIL,
    file: getValue('--file') || DATA_FILE
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSheetDate(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) throw new Error(`Bad date: ${raw}`);
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) throw new Error(`Bad month: ${raw}`);
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

function titleCase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeTypeName(raw) {
  const t = String(raw || '').trim();
  if (!t) return 'Other';
  const key = t.toLowerCase().replace(/\s+/g, ' ');
  return TYPE_ALIASES[key] || titleCase(t);
}

function parseTsv(content) {
  const rows = [];
  for (const [i, line] of String(content || '').split(/\r?\n/).entries()) {
    if (!line || !line.trim()) continue;
    if (i === 0 && /^date\b/i.test(line)) continue;
    const cols = line.split('\t');
    while (cols.length < 4) cols.push('');
    const [dateRaw, categoryRaw, expenseRaw, amountRaw] = cols;
    rows.push({
      row: rows.length + 1,
      dateRaw: String(dateRaw || '').trim(),
      categoryRaw: String(categoryRaw || '').trim(),
      expenseRaw: String(expenseRaw || '').trim(),
      amountRaw: String(amountRaw || '').trim()
    });
  }
  return rows;
}

async function connect() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 60000 });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = parseTsv(fs.readFileSync(opts.file, 'utf8'));
  if (!rows.length) throw new Error(`No rows in ${opts.file}`);

  await connect();
  const report = {
    importRef: IMPORT_REF,
    email: opts.email,
    dryRun: !opts.apply,
    sheetRows: rows.length,
    skipped: [],
    created: { types: 0, expenses: 0 },
    reusedTypes: [],
    newTypes: [],
    totals: { sheetAmount: 0 },
    byType: {},
    errors: []
  };

  try {
    const owner = await User.findOne({ email: new RegExp(`^${escapeRegex(opts.email)}$`, 'i') }).lean();
    if (!owner?.businessId) throw new Error(`No user found for ${opts.email}`);
    const businessId = owner.businessId;
    const branch = await Branch.findOne({ businessId, isDefault: true, status: 'ACTIVE' }).lean();
    if (!branch) throw new Error('Default branch not found');
    const settings = await BusinessSettings.findOne({ businessId }).select('cashAndBankEnabled timezone').lean();
    const timezone = settings?.timezone || TZ;

    if (opts.rollback) {
      const tagged = await Expense.find({ businessId, notes: new RegExp(escapeRegex(IMPORT_TAG)) }).select('_id').lean();
      if (!opts.confirm) {
        console.log(JSON.stringify({ dryRun: true, wouldDeleteExpenses: tagged.length }, null, 2));
        console.log('\nPass --rollback --confirm to delete imported expenses only (types are kept).');
        return;
      }
      const del = await Expense.deleteMany({ _id: { $in: tagged.map((e) => e._id) } });
      invalidateDashboardForBusiness(businessId);
      console.log(JSON.stringify({ deletedExpenses: del.deletedCount }, null, 2));
      return;
    }

    const existingTypes = await ExpenseType.find({ businessId }).lean();
    const typeByName = new Map(
      existingTypes.map((t) => [String(t.expenseName || '').trim().toLowerCase(), t])
    );
    const tagged = await Expense.find({ businessId, notes: new RegExp(escapeRegex(IMPORT_TAG)) })
      .select('notes')
      .lean();
    const importedRows = new Set();
    for (const exp of tagged) {
      const m = String(exp.notes || '').match(/\[CP-EXP-2026H2\] row (\d+)\b/);
      if (m) importedRows.add(Number(m[1]));
    }

    async function getType(name) {
      const key = name.toLowerCase();
      if (typeByName.has(key)) {
        const existing = typeByName.get(key);
        if (!report.reusedTypes.includes(existing.expenseName) && !report.newTypes.includes(name)) {
          report.reusedTypes.push(existing.expenseName);
        }
        return existing;
      }
      report.created.types += 1;
      report.newTypes.push(name);
      if (!opts.apply) {
        const stub = { _id: `NEW:${name}`, expenseName: name };
        typeByName.set(key, stub);
        return stub;
      }
      const created = await ExpenseType.create({ businessId, expenseName: name });
      typeByName.set(key, created);
      return created;
    }

    for (const row of rows) {
      try {
        const isoDate = parseSheetDate(row.dateRaw);
        const amount = roundMoney(row.amountRaw);
        if (!(amount > 0)) throw new Error(`Bad amount: ${row.amountRaw}`);
        report.totals.sheetAmount = roundMoney(report.totals.sheetAmount + amount);

        if (importedRows.has(row.row)) {
          report.skipped.push({ row: row.row, reason: 'already imported' });
          continue;
        }

        const typeName = normalizeTypeName(row.categoryRaw);
        const type = await getType(typeName);
        const noteLabel = row.expenseRaw || 'NIL';
        const notes = `${noteLabel} | ${IMPORT_TAG} row ${row.row}`;
        const payment = resolveExpensePaymentFields(amount, { paymentMethod: 'CASH' });
        const expenseDate = parseBusinessCalendarDate(isoDate, timezone);

        report.byType[typeName] = report.byType[typeName] || { count: 0, amount: 0 };
        report.byType[typeName].count += 1;
        report.byType[typeName].amount = roundMoney(report.byType[typeName].amount + amount);

        if (!opts.apply) {
          report.created.expenses += 1;
          continue;
        }

        const exp = await Expense.create({
          businessId,
          branchId: branch._id,
          expenseTypeId: type._id,
          amount,
          notes,
          expenseDate,
          createdBy: owner._id,
          ...payment
        });
        await Expense.collection.updateOne(
          { _id: exp._id },
          { $set: { createdAt: expenseDate, updatedAt: expenseDate } }
        );
        report.created.expenses += 1;
      } catch (err) {
        report.errors.push({ row: row.row, message: err.message || String(err) });
      }
    }

    if (opts.apply) invalidateDashboardForBusiness(businessId);
    report.cashAndBankEnabled = !!settings?.cashAndBankEnabled;
    report.businessId = String(businessId);

    const outPath = path.resolve(
      __dirname,
      'data',
      `carepoint-historical-expenses-import-${opts.apply ? 'apply' : 'dry-run'}.json`
    );
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      dryRun: !opts.apply,
      sheetRows: report.sheetRows,
      skipped: report.skipped.length,
      errors: report.errors.length,
      created: report.created,
      newTypes: report.newTypes,
      reusedTypes: report.reusedTypes,
      totals: report.totals,
      byType: report.byType,
      report: outPath
    }, null, 2));
    if (report.errors.length) {
      console.log('\nErrors:');
      for (const e of report.errors.slice(0, 20)) console.log(`  row ${e.row}: ${e.message}`);
    }
    if (!opts.apply) console.log('\nDry run. Pass --apply to create expenses.');
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
