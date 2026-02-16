import Job from '../models/Job.model.js';
import Business from '../models/Business.model.js';

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

/**
 * Generate unique random token number for a job
 * Format: YYYYMMDD-RANDOM6 (e.g., 20260208-A3K9M2)
 * 100% random to eliminate duplicate key issues
 */
export const generateTokenNumber = async (businessId) => {
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');
  
  // Generate random token with retry logic for extremely rare collisions
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    // Generate random 6-character alphanumeric suffix
    const randomSuffix = generateRandomString(6);
    const tokenNumber = `${dateStr}-${randomSuffix}`;
    
    // Check if this token already exists for this business
    const exists = await Job.findOne({ businessId, tokenNumber });
    
    if (!exists) {
      return tokenNumber;
    }
    
    // If collision (extremely rare), try again
    attempts++;
  }
  
  // Fallback: use timestamp + random if somehow all attempts failed
  const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
  const randomSuffix = generateRandomString(4);
  return `${dateStr}-${timestamp}${randomSuffix}`;
};

/**
 * Calculate estimated delivery time based on services
 */
export const calculateETA = (services) => {
  if (!services || services.length === 0) {
    const eta = new Date();
    eta.setMinutes(eta.getMinutes() + 60); // Default 1 hour
    return eta;
  }
  
  const totalMaxTime = services.reduce((sum, service) => {
    return sum + (service.maxTime || 0);
  }, 0);
  
  const eta = new Date();
  eta.setMinutes(eta.getMinutes() + totalMaxTime);
  return eta;
};

/**
 * Check if business can accept new job based on capacity
 */
export const canAcceptNewJob = async (businessId) => {
  const business = await Business.findById(businessId);
  
  if (!business) {
    return { canAccept: false, reason: 'Business not found' };
  }
  
  // Count active jobs (not completed, delivered, or cancelled)
  const activeJobsCount = await Job.countDocuments({
    businessId,
    status: { $nin: ['COMPLETED', 'DELIVERED', 'CANCELLED'] }
  });
  
  if (business.carHandlingCapacity === 'SINGLE') {
    if (activeJobsCount >= 1) {
      return { canAccept: false, reason: 'Another job is already in progress' };
    }
  } else {
    if (activeJobsCount >= business.maxConcurrentJobs) {
      return {
        canAccept: false,
        reason: `Maximum capacity of ${business.maxConcurrentJobs} jobs reached`
      };
    }
  }
  
  return { canAccept: true };
};

/**
 * Get next valid status in the workflow
 */
export const getNextStatus = (currentStatus) => {
  const statusFlow = {
    RECEIVED: 'IN_PROGRESS',
    IN_PROGRESS: 'WASHING',
    WASHING: 'DRYING',
    DRYING: 'COMPLETED',
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
  // Can always cancel
  if (newStatus === 'CANCELLED') {
    return currentStatus !== 'DELIVERED' && currentStatus !== 'CANCELLED';
  }
  
  // Can't go backwards (except to cancel)
  const statusOrder = [
    'RECEIVED',
    'IN_PROGRESS',
    'WASHING',
    'DRYING',
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
