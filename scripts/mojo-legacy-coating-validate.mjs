/**
 * Dry-run validation for the Mojo legacy coating package import.
 * Parses the source sheet, reports data problems, and prints what would be created.
 * Reads only — never writes.
 *
 *   node scripts/mojo-legacy-coating-validate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const source = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'data', 'mojo-legacy-coating-packages.json'), 'utf8')
);

/** Sheet dates are M/D/YYYY. */
export function parseSheetDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, month, day, year] = m;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

export function parseTermYears(term) {
  const m = String(term || '').trim().match(/^(\d+)\s*YEAR/i);
  return m ? Number(m[1]) : null;
}

const WORD_NUMBERS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6 };

/**
 * "3 SERVICE"                        -> { service: 3 }
 * "2 SIX MONTH SERVICE ONE RECOAT"   -> { service: 2, recoat: 1, sixMonthly: true }
 * "2 RECOAT AND 2 SERVICE"           -> { service: 2, recoat: 2 }
 * "3 SERVICE 2 MAINTANANCE"          -> { service: 3, maintenance: 2 }
 * "2 YEAR RECOAT"                    -> { recoat: 1 }  (single recoat at the 2-year mark)
 */
export function parseMaintenanceWork(rawText) {
  const text = String(rawText || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const counts = { service: 0, recoat: 0, maintenance: 0 };
  const sixMonthly = /SIX MONTH/.test(text);
  const warnings = [];

  // "2 YEAR RECOAT" / "3 YEAR RECOAT" — the number is the year mark, not a quantity.
  if (/^\d+\s*YEAR\s+RECOAT$/.test(text)) {
    counts.recoat = 1;
    warnings.push('"N YEAR RECOAT" read as 1 recoat due at the N-year mark');
    return { ...counts, sixMonthly, warnings, text };
  }

  // Strip the "SIX MONTH(LY)" interval qualifier first, otherwise its SIX is read as a quantity.
  const tokens = text.replace(/\bSIX MONTHS?(LY)?\b/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  const num = (token) => (/^\d+$/.test(token) ? Number(token) : WORD_NUMBERS[token] || null);
  let pending = null;

  for (const token of tokens) {
    const asNumber = num(token);
    if (asNumber != null) {
      pending = asNumber;
      continue;
    }
    if (/^SERVICES?$/.test(token)) {
      counts.service += pending ?? 1;
      pending = null;
    } else if (/^RECOATS?$/.test(token)) {
      counts.recoat += pending ?? 1;
      pending = null;
    } else if (/^MAINT[AE]?[IN]*N[AE]NCE$/.test(token)) {
      counts.maintenance += pending ?? 1;
      pending = null;
    }
  }

  // "2 SIX MONTH 2 RECOAT" — a dangling leading count with no noun means services.
  if (counts.service === 0 && counts.recoat > 0 && sixMonthly) {
    const lead = num(tokens[0]);
    if (lead) {
      counts.service = lead;
      warnings.push('"N SIX MONTH ... RECOAT" read as N six-monthly services plus the recoats');
    }
  }

  if (counts.service + counts.recoat + counts.maintenance === 0) {
    warnings.push('could not parse any visit entitlement');
  }
  return { ...counts, sixMonthly, warnings, text };
}

/** Visit due dates: six-monthly when the sheet says so, else spread evenly across the term. */
export function buildVisitSchedule(startDate, expiryDate, parsed) {
  const total = parsed.service + parsed.recoat + parsed.maintenance;
  if (total <= 0) return [];
  const start = new Date(startDate);
  const spanMonths = Math.max(
    1,
    Math.round((new Date(expiryDate) - start) / (1000 * 60 * 60 * 24 * 30.4375))
  );
  const stepMonths = parsed.sixMonthly ? 6 : Math.max(1, Math.round(spanMonths / total));

  const kinds = [
    ...Array(parsed.service).fill('service'),
    ...Array(parsed.maintenance).fill('maintenance'),
    ...Array(parsed.recoat).fill('recoat')
  ];
  return kinds.map((kind, index) => {
    const due = new Date(start);
    due.setUTCMonth(due.getUTCMonth() + stepMonths * (index + 1));
    return { kind, dueDate: due > new Date(expiryDate) ? new Date(expiryDate) : due };
  });
}

export function normalizeIndianPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return { phone: null, issue: 'missing' };
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (local.length !== 10) return { phone: null, issue: `unusable length (${digits.length} digits)` };
  if (digits.length !== 10 && digits.length !== 12) {
    return { phone: `+91${local}`, issue: `${digits.length} digits — trimmed to last 10` };
  }
  return { phone: `+91${local}`, issue: null };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 60000 });
  const db = mongoose.connection.db;
  const user = await db.collection('users').findOne({ email: new RegExp(`^${source.businessEmail}$`, 'i') });
  if (!user) throw new Error(`No user for ${source.businessEmail}`);
  const businessId = user.businessId;

  const customers = await db.collection('customers').find({ businessId }).project({ name: 1, phone: 1, whatsappNumber: 1, branchId: 1 }).toArray();
  const cars = await db.collection('cars').find({ businessId }).project({ carNumber: 1, customerId: 1 }).toArray();
  const byPhone = new Map();
  for (const c of customers) {
    for (const p of [c.phone, c.whatsappNumber].filter(Boolean)) byPhone.set(String(p).replace(/\D/g, '').slice(-10), c);
  }
  const byPlate = new Map(cars.map((c) => [String(c.carNumber || '').toUpperCase().replace(/\s/g, ''), c]));

  const problems = { missingPhone: [], oddPhone: [], missingName: [], missingVehicle: [], badExpiry: [], termMismatch: [], parseWarn: [], existingCustomer: [], existingCar: [], duplicateRows: [] };
  const seen = new Map();
  let totalVisits = 0;
  const kindTotals = { service: 0, recoat: 0, maintenance: 0 };
  const templateKeys = new Set();

  for (const row of source.rows) {
    const start = parseSheetDate(row.issueDate);
    const expiry = parseSheetDate(row.expiryDate);
    const years = parseTermYears(row.term);
    const parsed = parseMaintenanceWork(row.maintenanceWork);
    const visits = parsed.service + parsed.recoat + parsed.maintenance;
    totalVisits += visits;
    kindTotals.service += parsed.service;
    kindTotals.recoat += parsed.recoat;
    kindTotals.maintenance += parsed.maintenance;
    templateKeys.add(`${row.coating} / ${row.carCategory} / ${years} YEAR`);

    const label = `row ${row.row} ${row.ownerName || '(no name)'} ${row.vehicleNo || '(no vehicle)'} ${row.coating} ${row.term}`;

    if (!row.ownerName) problems.missingName.push(label);
    if (!row.vehicleNo) problems.missingVehicle.push(label);
    if (parsed.warnings.length) problems.parseWarn.push(`${label} :: "${row.maintenanceWork}" -> ${JSON.stringify({ service: parsed.service, recoat: parsed.recoat, maintenance: parsed.maintenance })} (${parsed.warnings.join('; ')})`);

    const { phone, issue } = normalizeIndianPhone(row.phone);
    if (!phone) problems.missingPhone.push(`${label} :: ${issue}`);
    else if (issue) problems.oddPhone.push(`${label} :: "${row.phone}" -> ${phone} (${issue})`);

    if (phone) {
      const key = phone.slice(-10);
      const existing = byPhone.get(key);
      if (existing) problems.existingCustomer.push(`${label} :: matches existing customer "${existing.name}" (${existing.phone})`);
      const prior = seen.get(key);
      if (prior) problems.duplicateRows.push(`row ${row.row} shares phone with row ${prior} (${phone})`);
      else seen.set(key, row.row);
    }

    if (row.vehicleNo) {
      const plate = row.vehicleNo.toUpperCase().replace(/\s/g, '');
      if (byPlate.has(plate)) problems.existingCar.push(`${label} :: plate already in Cars`);
    }

    if (!expiry || expiry <= start) problems.badExpiry.push(`${label} :: issue ${row.issueDate} -> expiry ${row.expiryDate}`);
    else if (years) {
      const actualYears = (expiry - start) / (365.25 * 24 * 3600 * 1000);
      if (Math.abs(actualYears - years) > 0.2) {
        problems.termMismatch.push(`${label} :: sheet says ${years}Y, dates span ${actualYears.toFixed(2)}Y (${row.issueDate} -> ${row.expiryDate})`);
      }
    }
  }

  const now = new Date();
  const expiredCount = source.rows.filter((r) => {
    const e = parseSheetDate(r.expiryDate);
    return e && e < now;
  }).length;

  console.log(`\n=== Mojo legacy coating import — dry run (${source.rows.length} rows) ===`);
  console.log(`businessId ............ ${businessId}`);
  console.log(`total visit entitlements: ${totalVisits}  ${JSON.stringify(kindTotals)}`);
  console.log(`already past expiry ....: ${expiredCount} of ${source.rows.length}`);
  console.log(`distinct package templates needed: ${templateKeys.size}`);
  for (const k of [...templateKeys].sort()) console.log(`   - ${k}`);

  for (const [key, list] of Object.entries(problems)) {
    console.log(`\n--- ${key} (${list.length}) ---`);
    for (const line of list) console.log(`   ${line}`);
  }

  await mongoose.disconnect();
}

if (process.argv[1] && process.argv[1].endsWith('mojo-legacy-coating-validate.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
