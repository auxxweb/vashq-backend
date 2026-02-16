import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate, authorize } from '../middleware/auth.middleware.js';
import Business from '../models/Business.model.js';
import User from '../models/User.model.js';
import Job from '../models/Job.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import SupportTicket from '../models/SupportTicket.model.js';
import HelpArticle from '../models/HelpArticle.model.js';
import Tutorial from '../models/Tutorial.model.js';
import PlatformSettings from '../models/PlatformSettings.model.js';
import SubscriptionPlan from '../models/SubscriptionPlan.model.js';
import ShopSubscription from '../models/ShopSubscription.model.js';
import PlanUpgradeRequest from '../models/PlanUpgradeRequest.model.js';
import bcrypt from 'bcryptjs';

const router = express.Router();

// All routes require authentication and SUPER_ADMIN role
router.use(authenticate);
router.use(authorize('SUPER_ADMIN'));

// ==================== DASHBOARD ====================

// @route   GET /api/super-admin/dashboard
// @desc    Get dashboard statistics
// @access  Private (Super Admin)
router.get('/dashboard', async (req, res) => {
  try {
    const totalBusinesses = await Business.countDocuments();
    const activeBusinesses = await Business.countDocuments({ status: 'ACTIVE' });

    const activePlans = await ShopSubscription.countDocuments({ status: 'ACTIVE' });
    const expiredPlans = await ShopSubscription.countDocuments({ status: 'EXPIRED' });

    const monthlyRevenue = 0;
    const yearlyRevenue = 0;
    const revenueTrend = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      revenueTrend.push({
        month: date.toLocaleString('default', { month: 'short' }),
        revenue: 0
      });
    }

    // Business onboarding trend
    const onboardingTrend = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      
      const count = await Business.countDocuments({
        createdAt: { $gte: startOfMonth, $lte: endOfMonth }
      });
      
      onboardingTrend.push({
        month: date.toLocaleString('default', { month: 'short' }),
        count
      });
    }

    res.json({
      success: true,
      stats: {
        totalBusinesses,
        activeBusinesses,
        activePlans,
        expiredPlans,
        monthlyRevenue,
        yearlyRevenue
      },
      revenueTrend,
      onboardingTrend
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== BUSINESS MANAGEMENT ====================

// @route   GET /api/super-admin/businesses
// @desc    Get all businesses (search, filter by status, pagination)
// @access  Private (Super Admin)
router.get('/businesses', async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const query = {};
    if (status && status !== 'ALL') query.status = status;
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { businessName: { $regex: term, $options: 'i' } },
        { ownerName: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } }
      ];
    }
    const total = await Business.countDocuments(query);
    const businesses = await Business.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();

    const businessesWithStats = await Promise.all(
      businesses.map(async (business) => {
        const jobsCount = await Job.countDocuments({ businessId: business._id });
        const customersCount = await Customer.countDocuments({ businessId: business._id });
        const subscription = await ShopSubscription.findOne({ shopId: business._id })
          .populate('planId', 'name validityDays')
          .lean();
        return {
          ...business,
          stats: { jobs: jobsCount, customers: customersCount },
          plan: subscription ? { planId: subscription.planId } : null
        };
      })
    );

    res.json({
      success: true,
      businesses: businessesWithStats,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) || 0 }
    });
  } catch (error) {
    console.error('Get businesses error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/super-admin/businesses/:id
// @desc    Get single business
// @access  Private (Super Admin)
router.get('/businesses/:id', async (req, res) => {
  try {
    const business = await Business.findById(req.params.id);
    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }

    const subscription = await ShopSubscription.findOne({ shopId: business._id })
      .populate('planId', 'name validityDays');
    const plan = subscription ? { planId: subscription.planId } : null;

    res.json({
      success: true,
      business: {
        ...business.toObject(),
        plan
      }
    });
  } catch (error) {
    console.error('Get business error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/super-admin/businesses
// @desc    Create new business with onboarding workflow
// @access  Private (Super Admin)
router.post('/businesses', [
  body('businessName').notEmpty().trim(),
  body('ownerName').notEmpty().trim(),
  body('phone').notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('whatsappNumber').notEmpty(),
  body('address').notEmpty(),
  body('workingHoursStart').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('workingHoursEnd').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('carHandlingCapacity').isIn(['SINGLE', 'MULTIPLE']),
  body('adminEmail').optional().isEmail().normalizeEmail(),
  body('adminPassword').optional().isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const {
      businessName,
      ownerName,
      phone,
      email,
      whatsappNumber,
      address,
      location,
      workingHoursStart,
      workingHoursEnd,
      carHandlingCapacity,
      maxConcurrentJobs,
      defaultLanguage,
      adminEmail,
      adminPassword
    } = req.body;

    // Check if business email already exists
    const existingBusiness = await Business.findOne({ email });
    if (existingBusiness) {
      return res.status(400).json({
        success: false,
        message: 'Business with this email already exists'
      });
    }

    // Use adminEmail if provided, otherwise use business email
    const adminEmailToUse = adminEmail || email;
    
    // Check if admin user already exists
    const existingUser = await User.findOne({ email: adminEmailToUse });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Admin user with this email already exists'
      });
    }

    // Generate default password if not provided
    const passwordToUse = adminPassword || (Math.random().toString(36).slice(-8) + 'A1!');

    // Currency comes from platform settings only (single source of truth)
    const platform = await PlatformSettings.findOne({}).lean();
    const currency = platform?.defaultCurrency || 'USD';

    // Create business
    const business = await Business.create({
      businessName,
      ownerName,
      phone,
      email,
      whatsappNumber,
      address,
      location,
      workingHoursStart,
      workingHoursEnd,
      carHandlingCapacity,
      maxConcurrentJobs: carHandlingCapacity === 'MULTIPLE' ? (maxConcurrentJobs || 3) : 1,
      defaultCurrency: currency,
      defaultLanguage: defaultLanguage || 'en'
    });

    // Create admin user (password will be hashed by pre-save hook)
    const adminUser = await User.create({
      email: adminEmailToUse,
      password: passwordToUse,
      role: 'CAR_WASH_ADMIN',
      businessId: business._id,
      status: 'ACTIVE'
    });

    // Create default settings (currency from platform)
    await BusinessSettings.create({
      businessId: business._id,
      language: defaultLanguage || 'en',
      currency
    });

    // Subscription is assigned when shop admin first visits My Plan (ensureDefaultSubscriptionPlan + default plan)

    res.status(201).json({
      success: true,
      business,
      adminUser: {
        email: adminEmailToUse,
        password: passwordToUse
      }
    });
  } catch (error) {
    console.error('Create business error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/super-admin/businesses/:id
// @desc    Update business (currency is set only via Super Admin Settings and applies platform-wide)
// @access  Private (Super Admin)
router.put('/businesses/:id', async (req, res) => {
  try {
    const allowed = ['businessName', 'ownerName', 'phone', 'email', 'whatsappNumber', 'address', 'location', 'workingHoursStart', 'workingHoursEnd', 'carHandlingCapacity', 'maxConcurrentJobs', 'defaultLanguage', 'logo', 'googleReviewLink', 'status'];
    const update = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    });
    const business = await Business.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    );

    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }

    res.json({
      success: true,
      business
    });
  } catch (error) {
    console.error('Update business error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/super-admin/businesses/:id
// @desc    Delete business and related data
// @access  Private (Super Admin)
router.delete('/businesses/:id', async (req, res) => {
  try {
    const businessId = req.params.id;
    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }
    await Job.deleteMany({ businessId });
    await Customer.deleteMany({ businessId });
    await Car.deleteMany({ businessId });
    await Service.deleteMany({ businessId });
    await SupportTicket.deleteMany({ businessId });
    await User.deleteMany({ businessId });
    await ShopSubscription.deleteMany({ shopId: businessId });
    await PlanUpgradeRequest.deleteMany({ shopId: businessId });
    await BusinessSettings.deleteMany({ businessId });
    await Business.findByIdAndDelete(businessId);
    res.json({
      success: true,
      message: 'Business deleted successfully'
    });
  } catch (error) {
    console.error('Delete business error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/super-admin/businesses/:id/reset-password
// @desc    Reset business admin password
// @access  Private (Super Admin)
router.post('/businesses/:id/reset-password', async (req, res) => {
  try {
    const business = await Business.findById(req.params.id);
    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }

    const adminUser = await User.findOne({ businessId: business._id, role: 'CAR_WASH_ADMIN' });
    if (!adminUser) {
      return res.status(404).json({
        success: false,
        message: 'Admin user not found'
      });
    }

    const newPassword = req.body.password || Math.random().toString(36).slice(-8) + 'A1!';
    adminUser.password = newPassword; // Will be hashed by pre-save hook
    await adminUser.save();

    res.json({
      success: true,
      message: 'Password reset successfully',
      newPassword: req.body.password ? undefined : newPassword
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/super-admin/businesses/:id/suspend
// @desc    Suspend or activate business
// @access  Private (Super Admin)
router.post('/businesses/:id/suspend', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const business = await Business.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }

    res.json({
      success: true,
      business
    });
  } catch (error) {
    console.error('Suspend business error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== SUBSCRIPTION PLANS ====================

// @route   POST /api/super-admin/subscription-plans
// @desc    Create subscription plan
// @access  Private (Super Admin)
router.post('/subscription-plans', [
  body('name').notEmpty().trim(),
  body('validityDays').isInt({ min: 1 }),
  body('price').optional().isFloat({ min: 0 }),
  body('description').optional().trim(),
  body('features').optional().isArray(),
  body('isActive').optional().isBoolean(),
  body('isFreeTrial').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const plan = await SubscriptionPlan.create(req.body);
    res.status(201).json({ success: true, plan });
  } catch (error) {
    console.error('Create subscription plan error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/super-admin/subscription-plans
// @desc    List all subscription plans (search, filter by isActive, pagination)
// @access  Private (Super Admin)
router.get('/subscription-plans', async (req, res) => {
  try {
    const { search, isActive, page = 1, limit = 20 } = req.query;
    const query = {};
    if (isActive !== undefined && isActive !== '' && isActive !== 'ALL') {
      query.isActive = isActive === 'true';
    }
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } }
      ];
    }
    const total = await SubscriptionPlan.countDocuments(query);
    const plans = await SubscriptionPlan.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();
    res.json({
      success: true,
      plans,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) || 0 }
    });
  } catch (error) {
    console.error('Get subscription plans error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PUT /api/super-admin/subscription-plans/:id
// @desc    Update subscription plan
// @access  Private (Super Admin)
router.put('/subscription-plans/:id', [
  body('name').optional().notEmpty().trim(),
  body('validityDays').optional().isInt({ min: 1 }),
  body('price').optional().isFloat({ min: 0 }),
  body('description').optional().trim(),
  body('features').optional().isArray(),
  body('isActive').optional().isBoolean(),
  body('isFreeTrial').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const plan = await SubscriptionPlan.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }
    res.json({ success: true, plan });
  } catch (error) {
    console.error('Update subscription plan error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PATCH /api/super-admin/subscription-plans/:id/status
// @desc    Activate or deactivate plan
// @access  Private (Super Admin)
router.patch('/subscription-plans/:id/status', async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isActive (boolean) required' });
    }
    const plan = await SubscriptionPlan.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true }
    );
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }
    res.json({ success: true, plan });
  } catch (error) {
    console.error('Toggle plan status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   DELETE /api/super-admin/subscription-plans/:id
// @desc    Delete subscription plan (inactive plans only)
// @access  Private (Super Admin)
router.delete('/subscription-plans/:id', async (req, res) => {
  try {
    const plan = await SubscriptionPlan.findById(req.params.id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }
    if (plan.isActive) {
      return res.status(400).json({ success: false, message: 'Deactivate the plan before deleting' });
    }
    await SubscriptionPlan.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Plan deleted' });
  } catch (error) {
    console.error('Delete subscription plan error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== UPGRADE REQUESTS ====================

// @route   GET /api/super-admin/upgrade-requests
// @desc    List all upgrade requests
// @access  Private (Super Admin)
router.get('/upgrade-requests', async (req, res) => {
  try {
    const requests = await PlanUpgradeRequest.find()
      .sort({ createdAt: -1 })
      .populate('shopId', 'businessName ownerName')
      .populate('currentPlanId', 'name validityDays')
      .populate('requestedPlanId', 'name validityDays features');
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Get upgrade requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PATCH /api/super-admin/upgrade-requests/:id/approve
// @desc    Approve upgrade request
// @access  Private (Super Admin)
router.patch('/upgrade-requests/:id/approve', async (req, res) => {
  try {
    const request = await PlanUpgradeRequest.findById(req.params.id)
      .populate('requestedPlanId')
      .populate('currentPlanId');
    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    if (request.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: 'Request already processed' });
    }
    const plan = request.requestedPlanId;
    if (!plan) {
      return res.status(400).json({ success: false, message: 'Requested plan not found' });
    }
    const currentPlan = request.currentPlanId;
    if (currentPlan && (currentPlan.isFreeTrial || (currentPlan.name && /free tier/i.test(currentPlan.name)))) {
      await Business.updateOne({ _id: request.shopId }, { freeTrialUsed: true });
    }
    const startDate = new Date();
    const expiryDate = new Date(startDate);
    expiryDate.setDate(expiryDate.getDate() + plan.validityDays);

    await ShopSubscription.findOneAndUpdate(
      { shopId: request.shopId },
      {
        planId: request.requestedPlanId._id,
        startDate,
        expiryDate,
        status: 'ACTIVE'
      },
      { upsert: true, new: true }
    );

    request.status = 'APPROVED';
    request.actionedAt = new Date();
    await request.save();

    res.json({ success: true, request, message: 'Upgrade approved' });
  } catch (error) {
    console.error('Approve upgrade error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PATCH /api/super-admin/upgrade-requests/:id/reject
// @desc    Reject upgrade request
// @access  Private (Super Admin)
router.patch('/upgrade-requests/:id/reject', async (req, res) => {
  try {
    const request = await PlanUpgradeRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    if (request.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: 'Request already processed' });
    }
    request.status = 'REJECTED';
    request.actionedAt = new Date();
    await request.save();
    res.json({ success: true, request, message: 'Upgrade rejected' });
  } catch (error) {
    console.error('Reject upgrade error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== SUPPORT MANAGEMENT ====================

// @route   GET /api/super-admin/support/help-articles
// @desc    Get all help articles
// @access  Private (Super Admin)
router.get('/support/help-articles', async (req, res) => {
  try {
    const articles = await HelpArticle.find().sort({ order: 1, createdAt: -1 });
    res.json({
      success: true,
      articles
    });
  } catch (error) {
    console.error('Get help articles error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/super-admin/support/help-articles
// @desc    Create help article
// @access  Private (Super Admin)
router.post('/support/help-articles', [
  body('title').notEmpty().trim(),
  body('content').notEmpty(),
  body('category').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const article = await HelpArticle.create(req.body);
    res.status(201).json({
      success: true,
      article
    });
  } catch (error) {
    console.error('Create help article error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/super-admin/support/help-articles/:id
// @desc    Update help article
// @access  Private (Super Admin)
router.put('/support/help-articles/:id', [
  body('title').optional().trim(),
  body('content').optional(),
  body('category').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const article = await HelpArticle.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!article) {
      return res.status(404).json({
        success: false,
        message: 'Help article not found'
      });
    }

    res.json({
      success: true,
      article
    });
  } catch (error) {
    console.error('Update help article error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/super-admin/support/help-articles/:id
// @desc    Delete help article
// @access  Private (Super Admin)
router.delete('/support/help-articles/:id', async (req, res) => {
  try {
    const article = await HelpArticle.findByIdAndDelete(req.params.id);
    if (!article) {
      return res.status(404).json({
        success: false,
        message: 'Help article not found'
      });
    }
    res.json({
      success: true,
      message: 'Help article deleted'
    });
  } catch (error) {
    console.error('Delete help article error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/super-admin/support/tutorials
// @desc    Get all tutorials
// @access  Private (Super Admin)
router.get('/support/tutorials', async (req, res) => {
  try {
    const tutorials = await Tutorial.find().sort({ order: 1, createdAt: -1 });
    res.json({
      success: true,
      tutorials
    });
  } catch (error) {
    console.error('Get tutorials error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/super-admin/support/tutorials
// @desc    Create tutorial
// @access  Private (Super Admin)
router.post('/support/tutorials', [
  body('title').notEmpty().trim(),
  body('description').notEmpty(),
  body('youtubeLink').optional().isURL()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const tutorial = await Tutorial.create(req.body);
    res.status(201).json({
      success: true,
      tutorial
    });
  } catch (error) {
    console.error('Create tutorial error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/super-admin/support/tutorials/:id
// @desc    Update tutorial
// @access  Private (Super Admin)
router.put('/support/tutorials/:id', [
  body('title').optional().trim(),
  body('description').optional(),
  body('youtubeLink').optional().isURL()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const tutorial = await Tutorial.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!tutorial) {
      return res.status(404).json({
        success: false,
        message: 'Tutorial not found'
      });
    }

    res.json({
      success: true,
      tutorial
    });
  } catch (error) {
    console.error('Update tutorial error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/super-admin/support/tutorials/:id
// @desc    Delete tutorial
// @access  Private (Super Admin)
router.delete('/support/tutorials/:id', async (req, res) => {
  try {
    const tutorial = await Tutorial.findByIdAndDelete(req.params.id);
    if (!tutorial) {
      return res.status(404).json({
        success: false,
        message: 'Tutorial not found'
      });
    }
    res.json({
      success: true,
      message: 'Tutorial deleted'
    });
  } catch (error) {
    console.error('Delete tutorial error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/super-admin/support/tickets
// @desc    Get all support tickets
// @access  Private (Super Admin)
router.get('/support/tickets', async (req, res) => {
  try {
    const tickets = await SupportTicket.find()
      .populate('businessId', 'businessName')
      .populate('createdBy', 'email')
      .populate('replies.repliedBy', 'email')
      .sort({ createdAt: -1 });
    res.json({
      success: true,
      tickets
    });
  } catch (error) {
    console.error('Get tickets error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/super-admin/support/tickets/:id/reply
// @desc    Reply to support ticket
// @access  Private (Super Admin)
router.post('/support/tickets/:id/reply', [
  body('message').notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    ticket.replies.push({
      message: req.body.message,
      repliedBy: req.user._id,
      isInternal: false,
      repliedAt: new Date()
    });

    if (ticket.status === 'OPEN') {
      ticket.status = 'IN_PROGRESS';
    }

    await ticket.save();

    res.json({
      success: true,
      ticket
    });
  } catch (error) {
    console.error('Reply ticket error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/super-admin/support/tickets/:id/status
// @desc    Update ticket status
// @access  Private (Super Admin)
router.patch('/support/tickets/:id/status', [
  body('status').isIn(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id,
      {
        status: req.body.status,
        resolvedAt: req.body.status === 'RESOLVED' ? new Date() : null
      },
      { new: true }
    );

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    res.json({
      success: true,
      ticket
    });
  } catch (error) {
    console.error('Update ticket status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== SETTINGS ====================

// @route   GET /api/super-admin/settings
// @desc    Get platform settings
// @access  Private (Super Admin)
router.get('/settings', async (req, res) => {
  try {
    let settings = await PlatformSettings.findOne({});
    if (!settings) {
      settings = await PlatformSettings.create({
        platformName: process.env.PLATFORM_NAME || 'Vashq',
        supportEmail: process.env.SUPPORT_EMAIL || '',
        supportPhone: process.env.SUPPORT_PHONE || '',
        defaultCurrency: process.env.DEFAULT_CURRENCY || 'USD',
        defaultLanguage: process.env.DEFAULT_LANGUAGE || 'en'
      });
    }
    const settingsObj = settings.toObject ? settings.toObject() : settings;
    res.json({
      success: true,
      settings: settingsObj
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/super-admin/settings
// @desc    Update platform settings
// @access  Private (Super Admin)
router.put('/settings', [
  body('platformName').optional().trim(),
  body('supportEmail').optional().trim(),
  body('supportPhone').optional().trim(),
  body('defaultCurrency').optional().isString(),
  body('defaultLanguage').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const updateFields = {};
    if (req.body.platformName !== undefined) updateFields.platformName = req.body.platformName;
    if (req.body.supportEmail !== undefined) updateFields.supportEmail = req.body.supportEmail;
    if (req.body.supportPhone !== undefined) updateFields.supportPhone = req.body.supportPhone;
    if (req.body.defaultCurrency !== undefined) updateFields.defaultCurrency = req.body.defaultCurrency;
    if (req.body.defaultLanguage !== undefined) updateFields.defaultLanguage = req.body.defaultLanguage;

    let settings = await PlatformSettings.findOne({});
    if (!settings) {
      settings = await PlatformSettings.create({
        platformName: 'Vashq',
        supportEmail: '',
        supportPhone: '',
        defaultCurrency: 'USD',
        defaultLanguage: 'en',
        ...updateFields
      });
    } else {
      settings = await PlatformSettings.findOneAndUpdate(
        { _id: settings._id },
        { $set: updateFields },
        { new: true }
      );
    }
    // When platform defaultCurrency changes, propagate to entire project
    if (req.body.defaultCurrency !== undefined) {
      const newCurrency = settings.defaultCurrency || req.body.defaultCurrency;
      await BusinessSettings.updateMany({}, { $set: { currency: newCurrency } });
      await Business.updateMany({}, { $set: { defaultCurrency: newCurrency } });
    }
    const settingsObj = settings.toObject ? settings.toObject() : settings;
    res.json({
      success: true,
      settings: settingsObj
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

export default router;
