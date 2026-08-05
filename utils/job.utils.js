import Job from '../models/Job.model.js';
import Business from '../models/Business.model.js';
import {
  buildScopeKey,
  formatSequentialNumber,
  loadNumberingSettings,
  nextSequenceValue
} from './numbering.utils.js';

/**
 * Generate a random alphanumeric string
 */
const generateRandomString = (length = 6) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding confusing chars (0, O, I, 1)
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

/** Legacy / default system token: YYYYMMDD-RANDOM6 (UTC date for backward compatibility). */
async function generateSystemTokenNumber(businessId, branchId = null) {
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');

  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const randomSuffix = generateRandomString(6);
    const tokenNumber = `${dateStr}-${randomSuffix}`;

    const existsQuery = { businessId, tokenNumber };
    if (branchId) existsQuery.branchId = branchId;
    const exists = await Job.findOne(existsQuery).select('_id').lean();

    if (!exists) {
      return tokenNumber;
    }

    attempts++;
  }

  const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
  const randomSuffix = generateRandomString(4);
  return `${dateStr}-${timestamp}${randomSuffix}`;
}

async function generateCustomTokenNumber(businessId, branchId, numbering) {
  const cfg = numbering.jobTokenSettings;
  const timezone = numbering.timezone;
  const scopeKey = buildScopeKey(cfg.sequenceScope, timezone);
  let attempts = 0;
  const maxAttempts = 8;

  while (attempts < maxAttempts) {
    const seq = await nextSequenceValue({
      businessId,
      branchId: branchId || null,
      kind: 'JOB_TOKEN',
      scopeKey
    });
    const tokenNumber = formatSequentialNumber(cfg, seq, timezone);
    if (!tokenNumber) {
      attempts++;
      continue;
    }

    const existsQuery = { businessId, tokenNumber };
    if (branchId) existsQuery.branchId = branchId;
    const exists = await Job.findOne(existsQuery).select('_id').lean();
    if (!exists) return tokenNumber;
    attempts++;
  }

  throw new Error('Unable to allocate unique custom job token');
}

/**
 * Generate unique token number for a job.
 * Default: YYYYMMDD-RANDOM6.
 * When customJobTokenEnabled: sequential format from BusinessSettings.
 */
export const generateTokenNumber = async (businessId, branchId = null) => {
  try {
    const numbering = await loadNumberingSettings(businessId);
    if (numbering.customJobTokenEnabled) {
      try {
        return await generateCustomTokenNumber(businessId, branchId, numbering);
      } catch (err) {
        console.warn('Custom job token failed, falling back to system token:', err?.message || err);
      }
    }
  } catch (err) {
    console.warn('Load job token settings failed, using system token:', err?.message || err);
  }
  return generateSystemTokenNumber(businessId, branchId);
};

/**
 * Calculate estimated delivery time based on services (compound: sum of all service times).
 * Uses maxTime when set, else minTime, else 60 min default per service.
 */
export const calculateETA = (services) => {
  // Products (skip work process) do not add bay time
  const workServices = (services || []).filter(
    (s) => !(s?.isVariable && s?.skipWorkProcess)
  );

  if (!workServices.length) {
    const eta = new Date();
    eta.setMinutes(eta.getMinutes() + 60); // Default 1 hour
    return eta;
  }

  const totalMinutes = workServices.reduce((sum, service) => {
    const t = service.maxTime ?? service.minTime ?? 60;
    return sum + (Number(t) || 0);
  }, 0);

  const eta = new Date();
  eta.setMinutes(eta.getMinutes() + totalMinutes);
  return eta;
};

/**
 * Check if business can accept new job based on capacity
 */
export const canAcceptNewJob = async (businessId, branchId = null) => {
  const business = await Business.findById(businessId);
  
  if (!business) {
    return { canAccept: false, reason: 'Business not found' };
  }

  const { getEffectiveMaxConcurrentJobs } = await import('../services/branchService.js');
  let maxConcurrent = getEffectiveMaxConcurrentJobs(business);
  
  const activeJobsQuery = {
    businessId,
    status: { $nin: ['COMPLETED', 'DELIVERED', 'CANCELLED'] }
  };
  if (branchId) activeJobsQuery.branchId = branchId;

  const activeJobsCount = await Job.countDocuments(activeJobsQuery);
  
  if (activeJobsCount >= maxConcurrent) {
    return {
      canAccept: false,
      reason: maxConcurrent === 1
        ? 'Another job is already in progress at this branch'
        : `Maximum capacity of ${maxConcurrent} jobs reached at this branch`
    };
  }
  
  return { canAccept: true };
};

/**
 * Get next valid status in the workflow
 */
export const getNextStatus = (currentStatus) => {
  const statusFlow = {
    RECEIVED: 'WORK_STARTED',
    WORK_STARTED: 'COMPLETED',
    COMPLETED: 'DELIVERED',
    DELIVERED: null,
    CANCELLED: null
  };

  return statusFlow[currentStatus] || null;
};

/**
 * Check if status transition is valid
 */
export const isValidStatusTransition = (currentStatus, newStatus) => {
  // Cancel is allowed only before work starts
  if (newStatus === 'CANCELLED') {
    return currentStatus === 'RECEIVED';
  }

  // Can't go backwards (except to cancel)
  const statusOrder = [
    'RECEIVED',
    'WORK_STARTED',
    'COMPLETED',
    'DELIVERED'
  ];

  const currentIndex = statusOrder.indexOf(currentStatus);
  const newIndex = statusOrder.indexOf(newStatus);

  if (currentIndex === -1 || newIndex === -1) {
    return false;
  }

  // Allow moving forward or staying in same status
  return newIndex >= currentIndex;
};
