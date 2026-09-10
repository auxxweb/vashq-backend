/**
 * Split shared placeholder plates (TEMP / TEMP-1 / TEMP2 / …) into one vehicle
 * per unique customer (by customerId + last-10 mobile), then rename uniquely.
 *
 * Jobs keep the customer they already have; they are re-pointed to that
 * customer's own TEMP-n car. Invoice vehicleNumber is updated to match.
 *
 * Default is dry-run. Tracking JSON is always written so later prompts can
 * inspect / roll back.
 *
 *   node scripts/split-temp-vehicles.mjs --email magicrabbitautohub@gmail.com
 *   node scripts/split-temp-vehicles.mjs --email magicrabbitautohub@gmail.com --apply
 *   node scripts/split-temp-vehicles.mjs --businessId 6a698664d6861f0f2bccc01b --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const APPLY = process.argv.includes('--apply');
const EMAIL = arg('--email', 'magicrabbitautohub@gmail.com');
const BUSINESS_ID_ARG = arg('--businessId');
const DATA_DIR = path.resolve(__dirname, 'data');

const PLACEHOLDER_RE = /^TEMP(?:[-_\s]*\d+)?$/i;

function last10(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.slice(-10);
}

function oid(id) {
  return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 60000 });
  const db = mongoose.connection.db;

  let businessId;
  let ownerEmail = EMAIL;
  if (BUSINESS_ID_ARG) {
    businessId = oid(BUSINESS_ID_ARG);
    const owner = await db.collection('users').findOne({
      businessId,
      role: 'CAR_WASH_ADMIN'
    }, { projection: { email: 1 } });
    ownerEmail = owner?.email || EMAIL;
  } else {
    const user = await db.collection('users').findOne({
      email: new RegExp(`^${String(EMAIL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
    });
    if (!user?.businessId) throw new Error(`User not found: ${EMAIL}`);
    businessId = user.businessId;
    ownerEmail = user.email;
  }

  const biz = await db.collection('businesses').findOne({ _id: businessId });
  const carsCol = db.collection('cars');
  const jobsCol = db.collection('jobs');
  const invoicesCol = db.collection('invoices');
  const customersCol = db.collection('customers');
  const bookingsCol = db.collection('bookings');

  const sourceCars = await carsCol.find({
    businessId,
    carNumber: PLACEHOLDER_RE
  }).sort({ createdAt: 1, _id: 1 }).toArray();

  const report = {
    ranAt: new Date().toISOString(),
    apply: APPLY,
    businessId: String(businessId),
    businessName: biz?.businessName || null,
    ownerEmail,
    placeholderPattern: String(PLACEHOLDER_RE),
    sourceCars: sourceCars.map(snapshotCar),
    splits: [],
    unlinkedOwners: [],
    createdCars: [],
    jobRepoints: [],
    invoiceUpdates: [],
    bookingUpdates: [],
    renames: [],
    unresolved: [],
    summary: {}
  };

  const createdNow = []; // { car, fromCarId, customerId }

  for (const car of sourceCars) {
    const jobs = await jobsCol.find({ businessId, carId: car._id }).sort({ createdAt: 1, _id: 1 }).toArray();
    const jobsByCustomer = new Map();
    for (const job of jobs) {
      const key = String(job.customerId);
      if (!jobsByCustomer.has(key)) jobsByCustomer.set(key, []);
      jobsByCustomer.get(key).push(job);
    }

    const listedOwnerIds = [...new Set(
      [...(car.customerIds || []), car.customerId]
        .filter(Boolean)
        .map((id) => String(id))
    )];

    const primaryId = car.customerId ? String(car.customerId) : null;
    const keeperId = (primaryId && jobsByCustomer.has(primaryId))
      ? primaryId
      : (jobs[0] ? String(jobs[0].customerId) : primaryId);

    const extraOwnerIds = listedOwnerIds.filter((id) => id !== keeperId && !jobsByCustomer.has(id));
    if (extraOwnerIds.length) {
      const owners = await customersCol.find({ _id: { $in: extraOwnerIds.map(oid) } })
        .project({ name: 1, phone: 1 }).toArray();
      report.unlinkedOwners.push({
        fromCarId: String(car._id),
        fromPlate: car.carNumber,
        owners: extraOwnerIds.map((id) => {
          const o = owners.find((x) => String(x._id) === id);
          return { customerId: id, name: o?.name || null, phone: o?.phone || null, last10: last10(o?.phone), reason: 'listed as co-owner but no jobs on this TEMP car' };
        })
      });
    }

    const otherCustomerIds = [...jobsByCustomer.keys()].filter((id) => id !== keeperId);
    if (otherCustomerIds.length === 0 && extraOwnerIds.length === 0) {
      continue;
    }

    const splitEntry = {
      sourceCarId: String(car._id),
      sourcePlate: car.carNumber,
      keeperCustomerId: keeperId,
      keptJobTokens: (jobsByCustomer.get(keeperId) || []).map((j) => j.tokenNumber),
      spawned: []
    };

    for (const customerId of otherCustomerIds) {
      const custJobs = jobsByCustomer.get(customerId);
      const customer = await customersCol.findOne({ _id: oid(customerId) });
      const newCarDoc = {
        businessId: car.businessId,
        branchId: car.branchId || customer?.branchId || null,
        customerId: oid(customerId),
        customerIds: [oid(customerId)],
        carNumber: 'TEMP', // renamed uniquely in the second pass
        brand: '',
        model: '',
        color: '',
        notes: `Split from shared ${car.carNumber} (${String(car._id)}) on ${new Date().toISOString().slice(0, 10)}`,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      let newId;
      if (APPLY) {
        const inserted = await carsCol.insertOne(newCarDoc);
        newId = inserted.insertedId;
        await jobsCol.updateMany(
          { _id: { $in: custJobs.map((j) => j._id) } },
          { $set: { carId: newId } }
        );
      } else {
        newId = new mongoose.Types.ObjectId();
      }

      createdNow.push({ _id: newId, ...newCarDoc, fromCarId: car._id });
      report.createdCars.push({
        newCarId: String(newId),
        fromCarId: String(car._id),
        customerId,
        customerName: customer?.name || null,
        customerPhone: customer?.phone || null,
        last10: last10(customer?.phone),
        jobTokens: custJobs.map((j) => j.tokenNumber),
        jobIds: custJobs.map((j) => String(j._id))
      });
      for (const job of custJobs) {
        report.jobRepoints.push({
          jobId: String(job._id),
          tokenNumber: job.tokenNumber,
          customerId,
          customerName: customer?.name || null,
          customerPhone: customer?.phone || null,
          fromCarId: String(car._id),
          toCarId: String(newId)
        });
      }
      splitEntry.spawned.push({
        newCarId: String(newId),
        customerId,
        customerName: customer?.name || null,
        customerPhone: customer?.phone || null,
        jobTokens: custJobs.map((j) => j.tokenNumber)
      });
    }

    if (keeperId || extraOwnerIds.length) {
      const keeperOid = keeperId ? oid(keeperId) : car.customerId;
      if (APPLY) {
        await carsCol.updateOne(
          { _id: car._id },
          {
            $set: {
              customerId: keeperOid,
              customerIds: keeperOid ? [keeperOid] : [],
              updatedAt: new Date()
            }
          }
        );
      }
    }

    report.splits.push(splitEntry);
  }

  // Reload placeholder cars after splits (includes newly created TEMP rows)
  const afterSplitCars = APPLY
    ? await carsCol.find({ businessId, carNumber: PLACEHOLDER_RE }).sort({ createdAt: 1, _id: 1 }).toArray()
    : [...sourceCars, ...createdNow].sort((a, b) => {
      const ta = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
      return ta !== 0 ? ta : String(a._id).localeCompare(String(b._id));
    });

  const usedPlates = new Set(
    (await carsCol.find({
      businessId,
      carNumber: { $not: PLACEHOLDER_RE }
    }).project({ carNumber: 1 }).toArray())
      .map((c) => String(c.carNumber || '').trim().toUpperCase())
  );

  function nextPlate(index) {
    // TEMP, TEMP-1, TEMP-2, …
    const candidate = index === 0 ? 'TEMP' : `TEMP-${index}`;
    if (usedPlates.has(candidate)) return nextPlate(index + 1);
    return candidate;
  }

  let plateIndex = 0;
  for (const car of afterSplitCars) {
    const plate = nextPlate(plateIndex);
    plateIndex += 1;
    usedPlates.add(plate);
    const oldPlate = String(car.carNumber || '').trim().toUpperCase();
    if (oldPlate !== plate) {
      report.renames.push({
        carId: String(car._id),
        from: car.carNumber,
        to: plate,
        customerId: car.customerId ? String(car.customerId) : null
      });
      if (APPLY) {
        await carsCol.updateOne({ _id: car._id }, { $set: { carNumber: plate, updatedAt: new Date() } });
      }
    } else {
      report.renames.push({
        carId: String(car._id),
        from: car.carNumber,
        to: plate,
        unchanged: true,
        customerId: car.customerId ? String(car.customerId) : null
      });
    }
    car.carNumber = plate;
  }

  const plateByCarId = new Map(afterSplitCars.map((c) => [String(c._id), c.carNumber]));

  // Invoices for jobs on these cars
  const allTrackedCarIds = afterSplitCars.map((c) => c._id);
  const trackedJobs = APPLY
    ? await jobsCol.find({ businessId, carId: { $in: allTrackedCarIds } }).toArray()
    : [
        ...(await jobsCol.find({ businessId, carId: { $in: sourceCars.map((c) => c._id) } }).toArray())
          .map((j) => {
            const rp = report.jobRepoints.find((r) => r.jobId === String(j._id));
            return rp ? { ...j, carId: oid(rp.toCarId) } : j;
          })
      ];

  const jobIds = trackedJobs.map((j) => j._id);
  const invoices = jobIds.length
    ? await invoicesCol.find({ businessId, jobId: { $in: jobIds } }).toArray()
    : [];

  for (const inv of invoices) {
    const job = trackedJobs.find((j) => String(j._id) === String(inv.jobId));
    const nextPlateVal = job ? plateByCarId.get(String(job.carId)) : null;
    if (!nextPlateVal) continue;
    if (String(inv.vehicleNumber || '').trim().toUpperCase() === nextPlateVal) continue;
    report.invoiceUpdates.push({
      invoiceId: String(inv._id),
      invoiceNumber: inv.invoiceNumber,
      jobId: String(inv.jobId),
      from: inv.vehicleNumber || null,
      to: nextPlateVal
    });
    if (APPLY) {
      await invoicesCol.updateOne(
        { _id: inv._id },
        { $set: { vehicleNumber: nextPlateVal } }
      );
    }
  }

  // Bookings whose stored plate is TEMP but car already has a real number (or renamed TEMP-n)
  const tempBookings = await bookingsCol.find({
    businessId,
    vehicleNumber: PLACEHOLDER_RE
  }).toArray();
  for (const b of tempBookings) {
    let plate = null;
    if (b.carId) {
      const live = await carsCol.findOne({ _id: b.carId });
      const pending = afterSplitCars.find((c) => String(c._id) === String(b.carId));
      plate = pending?.carNumber || live?.carNumber || null;
    }
    if (!plate || String(b.vehicleNumber || '').trim().toUpperCase() === String(plate).toUpperCase()) continue;
    report.bookingUpdates.push({
      bookingId: String(b._id),
      customerName: b.customerName || null,
      customerPhone: b.customerPhone || null,
      from: b.vehicleNumber,
      to: plate
    });
    if (APPLY) {
      await bookingsCol.updateOne({ _id: b._id }, { $set: { vehicleNumber: plate } });
    }
  }

  // Orphan invoice: vehicleNumber TEMP, job's car missing
  const strayInvoices = await invoicesCol.find({
    businessId,
    vehicleNumber: PLACEHOLDER_RE,
    ...(jobIds.length ? { jobId: { $nin: jobIds } } : {})
  }).toArray();
  for (const inv of strayInvoices) {
    const job = inv.jobId ? await jobsCol.findOne({ _id: inv.jobId }) : null;
    const car = job?.carId ? await carsCol.findOne({ _id: job.carId }) : null;
    const customer = job?.customerId ? await customersCol.findOne({ _id: job.customerId }) : null;
    report.unresolved.push({
      type: 'invoice_temp_plate_job_car_missing_or_not_split',
      invoiceNumber: inv.invoiceNumber,
      invoiceId: String(inv._id),
      jobId: inv.jobId ? String(inv.jobId) : null,
      tokenNumber: job?.tokenNumber || null,
      jobCarExists: !!car,
      jobCarNumber: car?.carNumber || null,
      customerExists: !!customer,
      customerName: customer?.name || inv.customerName || null,
      customerPhone: customer?.phone || inv.customerPhone || null,
      note: 'Left unchanged. Customer and/or car record is gone; needs a later prompt if you want this rebuilt.'
    });
  }

  // Final assignment table for later prompts
  const finalCars = APPLY
    ? await carsCol.find({ businessId, carNumber: PLACEHOLDER_RE }).sort({ createdAt: 1, _id: 1 }).toArray()
    : afterSplitCars;

  const assignment = [];
  for (const car of finalCars) {
    const customer = car.customerId ? await customersCol.findOne({ _id: car.customerId }) : null;
    const jobs = APPLY
      ? await jobsCol.find({ businessId, carId: car._id }).sort({ createdAt: 1 }).toArray()
      : trackedJobs.filter((j) => String(j.carId) === String(car._id));
    assignment.push({
      carId: String(car._id),
      plate: car.carNumber,
      brand: car.brand || '',
      model: car.model || '',
      color: car.color || '',
      customerId: car.customerId ? String(car.customerId) : null,
      customerName: customer?.name || null,
      customerPhone: customer?.phone || null,
      last10: last10(customer?.phone),
      customerMissing: !customer,
      jobCount: jobs.length,
      jobTokens: jobs.map((j) => j.tokenNumber)
    });
  }
  report.assignment = assignment;
  report.summary = {
    sourceTempCars: sourceCars.length,
    splits: report.splits.length,
    carsCreated: report.createdCars.length,
    jobsRepointed: report.jobRepoints.length,
    invoicesUpdated: report.invoiceUpdates.length,
    bookingsUpdated: report.bookingUpdates.length,
    uniquePlatesAfter: assignment.length,
    unresolved: report.unresolved.length,
    apply: APPLY
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tag = APPLY ? 'apply' : 'dry-run';
  const file = path.join(DATA_DIR, `magicrabbit-temp-vehicle-split.${tag}.${stamp()}.json`);
  const latest = path.join(DATA_DIR, `magicrabbit-temp-vehicle-split.${tag}.json`);
  const json = JSON.stringify(report, null, 2);
  fs.writeFileSync(file, json);
  fs.writeFileSync(latest, json);

  const csvLines = [
    ['plate', 'carId', 'customerName', 'customerPhone', 'last10', 'jobCount', 'jobTokens', 'customerMissing'].join(','),
    ...assignment.map((a) => [
      a.plate,
      a.carId,
      csv(a.customerName),
      csv(a.customerPhone),
      a.last10,
      a.jobCount,
      csv((a.jobTokens || []).join(' ')),
      a.customerMissing
    ].join(','))
  ];
  const csvFile = path.join(DATA_DIR, `magicrabbit-temp-vehicle-split.${tag}.csv`);
  fs.writeFileSync(csvFile, csvLines.join('\n') + '\n');

  console.log(JSON.stringify(report.summary, null, 2));
  console.log('\nAssignment:');
  for (const a of assignment) {
    console.log(`  ${a.plate.padEnd(8)} ${a.customerName || '(missing customer)'} ${a.customerPhone || ''} jobs=${a.jobCount} ${(a.jobTokens || []).join(',')}`);
  }
  console.log('\nWrote', file);
  console.log('Wrote', latest);
  console.log('Wrote', csvFile);
  if (!APPLY) console.log('\nDry run only. Re-run with --apply to write to MongoDB.');

  await mongoose.disconnect();
}

function snapshotCar(c) {
  return {
    carId: String(c._id),
    carNumber: c.carNumber,
    brand: c.brand || '',
    model: c.model || '',
    color: c.color || '',
    customerId: c.customerId ? String(c.customerId) : null,
    customerIds: (c.customerIds || []).map((id) => String(id)),
    createdAt: c.createdAt
  };
}

function csv(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
