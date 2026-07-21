/**
 * Bulk import customers for a business from a TSV file (name<TAB>phone).
 *
 * Usage:
 *   node backend/scripts/import-customers.mjs --email=cochinwashclub@gmail.com
 *   node backend/scripts/import-customers.mjs --email=cochinwashclub@gmail.com --dry-run
 *   node backend/scripts/import-customers.mjs --email=cochinwashclub@gmail.com --file=path/to/customers.tsv
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import Business from '../models/Business.model.js';
import User from '../models/User.model.js';
import Customer from '../models/Customer.model.js';
import { ensureDefaultBranchForBusiness } from '../services/branchService.js';
import { normalizePhone, findCustomerByPhone } from '../utils/customer.utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dryRun = process.argv.includes('--dry-run');
const emailArg = process.argv.find((a) => a.startsWith('--email='));
const fileArg = process.argv.find((a) => a.startsWith('--file='));
const email = emailArg ? emailArg.split('=')[1]?.trim().toLowerCase() : '';
const filePath = fileArg
  ? path.resolve(fileArg.split('=').slice(1).join('='))
  : path.join(__dirname, 'data', 'cochinwashclub-customers.tsv');

function parseTsv(content) {
  const rows = [];
  const seenPhones = new Set();
  const duplicateInFile = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const tabIdx = trimmed.lastIndexOf('\t');
    let name;
    let phoneRaw;
    if (tabIdx >= 0) {
      name = trimmed.slice(0, tabIdx).trim();
      phoneRaw = trimmed.slice(tabIdx + 1).trim();
    } else {
      const match = trimmed.match(/^(.+?)\s+(91\d{10}|\d{10,13})$/);
      if (!match) {
        console.warn(`  skip unparseable line: ${trimmed}`);
        continue;
      }
      name = match[1].trim();
      phoneRaw = match[2].trim();
    }

    const phone = normalizePhone(phoneRaw.replace(/\s/g, ''));
    if (!phone || phone.length < 10) {
      console.warn(`  skip invalid phone for "${name}": ${phoneRaw}`);
      continue;
    }

    if (seenPhones.has(phone)) {
      duplicateInFile.push({ name, phone });
      continue;
    }
    seenPhones.add(phone);
    rows.push({ name: name || phone, phone });
  }

  return { rows, duplicateInFile };
}

async function resolveBusiness(email) {
  const user = await User.findOne({ email }).select('businessId').lean();
  if (user?.businessId) {
    const biz = await Business.findById(user.businessId).select('_id businessName email').lean();
    if (biz) return biz;
  }
  return Business.findOne({ email }).select('_id businessName email').lean();
}

async function main() {
  if (!email) throw new Error('--email= required');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI or MONGODB_URI required');

  const content = fs.readFileSync(filePath, 'utf8');
  const { rows, duplicateInFile } = parseTsv(content);

  await mongoose.connect(uri);
  console.log(`Connected${dryRun ? ' (dry run)' : ''}`);
  console.log(`File: ${filePath}`);
  console.log(`Parsed ${rows.length} unique customers (${duplicateInFile.length} duplicate phones in file skipped)`);

  const business = await resolveBusiness(email);
  if (!business) {
    console.error(`Business not found for email: ${email}`);
    process.exit(1);
  }
  console.log(`Business: ${business.businessName} (${business._id})`);

  const defaultBranch = await ensureDefaultBranchForBusiness(business._id);
  const branchId = defaultBranch?._id || null;
  console.log(`Branch: ${defaultBranch?.name || 'default'} (${branchId})`);

  let created = 0;
  let skippedExisting = 0;
  let failed = 0;

  for (const { name, phone } of rows) {
    try {
      const existing = await findCustomerByPhone(business._id, phone, branchId);
      if (existing) {
        skippedExisting += 1;
        continue;
      }

      if (dryRun) {
        created += 1;
        continue;
      }

      await Customer.create({
        businessId: business._id,
        branchId,
        name,
        phone,
        whatsappNumber: phone
      });
      created += 1;
    } catch (err) {
      failed += 1;
      if (/already exists/i.test(err.message)) {
        skippedExisting += 1;
        failed -= 1;
      } else {
        console.warn(`  failed "${name}" ${phone}: ${err.message}`);
      }
    }
  }

  console.log(`Done. created=${created} skipped_existing=${skippedExisting} failed=${failed}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
