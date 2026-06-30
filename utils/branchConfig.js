import PlatformSettings from '../models/PlatformSettings.model.js';

const DEFAULTS = {
  branchAnnualFee: 2000,
  branchValidityDays: 365,
  maxBranchesPerBusiness: 10,
  includedBranchesPerShop: 1
};

let cached = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

export async function getBranchPlatformConfig() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;

  const platform = await PlatformSettings.findOne({}).lean();
  cached = {
    branchAnnualFee: Number(platform?.branchAnnualFee) || DEFAULTS.branchAnnualFee,
    branchValidityDays: Number(platform?.branchValidityDays) || DEFAULTS.branchValidityDays,
    maxBranchesPerBusiness: Number(platform?.maxBranchesPerBusiness) || DEFAULTS.maxBranchesPerBusiness,
    includedBranchesPerShop: Number(platform?.includedBranchesPerShop) || DEFAULTS.includedBranchesPerShop
  };
  cachedAt = now;
  return cached;
}

export function normalizeBranchCode(raw) {
  const code = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  if (!code) {
    const err = new Error('Branch code is required (letters and numbers only)');
    err.status = 400;
    throw err;
  }
  return code;
}

export function suggestBranchCode(name) {
  const parts = String(name || '')
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'BR1';
  if (parts.length === 1) return parts[0].replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'BR1';
  return parts.map((p) => p[0]).join('').slice(0, 8);
}
