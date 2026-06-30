import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveBranchContext } from '../middleware/branchContext.middleware.js';
import { requireBusinessModule } from '../middleware/businessModules.middleware.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import { adminPanelOnly } from '../middleware/adminPanel.middleware.js';
import {
  createTemplate,
  updateTemplate,
  softDeleteTemplate,
  listTemplates,
  purchasePackage,
  getCustomerPackages,
  listCustomerPackages,
  completeVisit,
  scheduleVisit,
  closeCustomerPackage,
  closePackageSale,
  listVisits,
  listScheduledVisits,
  getCustomerPackageDetail,
} from '../controllers/packages.controller.js';

const router = express.Router();

// Auth + business context (same pattern as admin routes)
router.use(authenticate);
router.use((req, res, next) => {
  if (!req.user?.businessId) {
    return res.status(403).json({ success: false, message: 'Business not assigned' });
  }
  req.businessId = req.user.businessId;
  next();
});
router.use(resolveBranchContext);
router.use(requireBusinessModule('packages'));
router.use(enforceActiveSubscription());

// Template CRUD (admin only)
router.get('/templates', listTemplates);
router.post('/template', adminPanelOnly, [
  body('name').notEmpty().trim(),
  body('price').isFloat({ min: 0 }),
  body('totalVisits').isInt({ min: 1 }),
  body('validityDays').isInt({ min: 1 }),
  body('servicesIncluded').optional().isArray(),
  body('description').optional().isString()
], (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
}, createTemplate);

router.put('/template/:id', adminPanelOnly, [
  body('name').optional().trim(),
  body('price').optional().isFloat({ min: 0 }),
  body('totalVisits').optional().isInt({ min: 1 }),
  body('validityDays').optional().isInt({ min: 1 }),
  body('servicesIncluded').optional().isArray(),
  body('description').optional().isString(),
  body('isActive').optional().isBoolean()
], (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
}, updateTemplate);

router.delete('/template/:id', adminPanelOnly, softDeleteTemplate);

// Purchase (admin only)
router.post('/purchase', adminPanelOnly, [
  body('templateId').notEmpty().isMongoId(),
  body('customerId').notEmpty().isMongoId(),
  body('carId').optional({ checkFalsy: true }).isMongoId()
], (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
}, purchasePackage);

// Customer packages
router.get('/customer/:customerId', getCustomerPackages);
router.get('/customer-packages', listCustomerPackages); // filters: status, remaining=true
router.get('/customer-package/:id', getCustomerPackageDetail);
router.put('/customer/:id/close', adminPanelOnly, closeCustomerPackage);
router.patch('/customer-package/:id/close-sale', adminPanelOnly, closePackageSale);

// Visits — employees may complete/schedule operational visits
router.get('/visits/:customerPackageId', listVisits);
router.get('/scheduled-visits', listScheduledVisits); // query: days=30, includeOverdue=true
router.post('/visit/schedule', [
  body('customerPackageId').notEmpty().isMongoId(),
  body('date').notEmpty(),
  body('servicesUsed').isArray({ min: 1 }),
  body('servicesUsed.*.serviceId').notEmpty().isMongoId(),
  body('servicesUsed.*.quantity').optional(),
  body('assignedTo').optional({ checkFalsy: true }).isMongoId(),
  body('createWithoutImages').optional().toBoolean(),
  body('beforeImages').optional().isArray(),
  body('afterImages').optional().isArray(),
  body('notes').optional().isString()
], (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
}, scheduleVisit);
router.post('/visit/complete', [
  body('customerPackageId').notEmpty().isMongoId(),
  body('bookingId').optional().isMongoId(),
  body('servicesUsed').isArray({ min: 1 }),
  body('servicesUsed.*.serviceId').notEmpty().isMongoId(),
  body('servicesUsed.*.quantity').optional(),
  body('assignedTo').optional({ checkFalsy: true }).isMongoId(),
  body('createWithoutImages').optional().toBoolean(),
  body('beforeImages').optional().isArray(),
  body('afterImages').optional().isArray(),
  body('notes').optional().isString()
], (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
}, completeVisit);

export default router;
