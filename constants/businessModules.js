/** Super-admin togglable modules per business. */
export const BUSINESS_MODULE_KEYS = [
  'bookings',
  'packages',
  'variableServices',
  'accounting',
  'aiInsights',
  'branches',
  'printer',
  'credit'
];

export const BUSINESS_MODULE_LABELS = {
  bookings: 'Online booking',
  packages: 'Packages',
  variableServices: 'Variable services',
  accounting: 'Accounting (Trial balance & P&L)',
  aiInsights: 'AI insights',
  branches: 'Multi-branch',
  printer: 'Bluetooth printer',
  credit: 'Credit & pay later (amount due)'
};

export const DEFAULT_ENABLED_MODULES = Object.freeze(
  BUSINESS_MODULE_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {})
);

export function normalizeEnabledModules(raw) {
  const out = { ...DEFAULT_ENABLED_MODULES };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of BUSINESS_MODULE_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return out;
}
