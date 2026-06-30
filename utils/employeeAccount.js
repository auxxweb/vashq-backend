import User from '../models/User.model.js';

function parseEmployeeCodeNumber(code) {
  const m = /^EMP(\d+)$/i.exec(String(code || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export async function generateEmployeeCode(businessId) {
  const users = await User.find({
    businessId,
    employeeCode: { $exists: true, $ne: '' }
  })
    .select('employeeCode')
    .lean();

  let max = 0;
  for (const u of users) {
    const n = parseEmployeeCodeNumber(u.employeeCode);
    if (n != null && n > max) max = n;
  }

  return `EMP${String(max + 1).padStart(3, '0')}`;
}

function isDuplicateEmployeeCodeError(err) {
  return err?.code === 11000 && /employeeCode/i.test(String(err?.message || ''));
}
export function randomEmployeePassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < length; i += 1) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

export async function createEmployeeAccount(businessId, {
  name,
  email,
  password,
  phone,
  address,
  branchId,
  role = 'EMPLOYEE'
}) {
  let plainPassword = password;
  if (!plainPassword) plainPassword = randomEmployeePassword(10);

  const existing = await User.findOne({ email });
  if (existing) {
    const err = new Error('Email already in use');
    err.status = 400;
    throw err;
  }

  const employeeCode = await generateEmployeeCode(businessId);
  let user;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = attempt === 0 ? employeeCode : await generateEmployeeCode(businessId);
    try {
      user = await User.create({
        name,
        email,
        password: plainPassword,
        role,
        businessId,
        branchId: branchId || undefined,
        phone: phone || '',
        address: address || '',
        employeeCode: code
      });
      break;
    } catch (err) {
      if (isDuplicateEmployeeCodeError(err) && attempt < 4) continue;
      throw err;
    }
  }
  if (!user) {
    const err = new Error('Could not assign employee code');
    err.status = 500;
    throw err;
  }
  return { user, temporaryPassword: plainPassword };
}
