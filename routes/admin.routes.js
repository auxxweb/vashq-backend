import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate, authorize } from '../middleware/auth.middleware.js';
import Customer from '../models/Customer.model.js';
import Car from '../models/Car.model.js';
import Service from '../models/Service.model.js';
import Job from '../models/Job.model.js';
import WhatsAppTemplate from '../models/WhatsAppTemplate.model.js';
import WhatsAppMessage from '../models/WhatsAppMessage.model.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import Notification from '../models/Notification.model.js';
import { generateTokenNumber, calculateETA, canAcceptNewJob, isValidStatusTransition } from '../utils/job.utils.js';
import { sendWhatsAppMessage, formatTemplate } from '../utils/whatsapp.utils.js';
import Business from '../models/Business.model.js';
import SubscriptionPlan from '../models/SubscriptionPlan.model.js';
import ShopSubscription from '../models/ShopSubscription.model.js';
import PlanUpgradeRequest from '../models/PlanUpgradeRequest.model.js';
import HelpArticle from '../models/HelpArticle.model.js';
import Tutorial from '../models/Tutorial.model.js';
import SupportTicket from '../models/SupportTicket.model.js';
import PlatformSettings from '../models/PlatformSettings.model.js';

const router = express.Router();

// All routes require authentication and CAR_WASH_ADMIN role
router.use(authenticate);
router.use(authorize('CAR_WASH_ADMIN'));

// Middleware to ensure user has businessId
const requireBusiness = (req, res, next) => {
  if (!req.user.businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business not assigned'
    });
  }
  req.businessId = req.user.businessId;
  next();
};

router.use(requireBusiness);

// ==================== DASHBOARD ====================

// @route   GET /api/admin/dashboard
// @desc    Get dashboard statistics
// @access  Private (Car Wash Admin)
router.get('/dashboard', async (req, res) => {
  try {
    const businessId = req.businessId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Today's jobs
    const todayJobs = await Job.countDocuments({
      businessId,
      createdAt: { $gte: today, $lt: tomorrow }
    });

    // Jobs in progress
    const inProgress = await Job.countDocuments({
      businessId,
      status: { $nin: ['COMPLETED', 'DELIVERED', 'CANCELLED'] }
    });

    // Average completion time (from completed jobs)
    const completedJobs = await Job.find({
      businessId,
      status: 'COMPLETED',
      actualDelivery: { $exists: true }
    }).select('createdAt actualDelivery');

    let avgCompletionTime = 0;
    if (completedJobs.length > 0) {
      const totalTime = completedJobs.reduce((sum, job) => {
        const diff = job.actualDelivery - job.createdAt;
        return sum + (diff / (1000 * 60)); // Convert to minutes
      }, 0);
      avgCompletionTime = Math.round(totalTime / completedJobs.length);
    }

    // Today's revenue
    const todayJobsList = await Job.find({
      businessId,
      createdAt: { $gte: today, $lt: tomorrow },
      status: { $in: ['COMPLETED', 'DELIVERED'] }
    });
    const todayRevenue = todayJobsList.reduce((sum, job) => sum + job.totalPrice, 0);

    // Monthly revenue
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthlyJobs = await Job.find({
      businessId,
      createdAt: { $gte: startOfMonth },
      status: { $in: ['COMPLETED', 'DELIVERED'] }
    });
    const monthlyRevenue = monthlyJobs.reduce((sum, job) => sum + job.totalPrice, 0);

    // Pending deliveries
    const pendingDeliveries = await Job.countDocuments({
      businessId,
      status: 'COMPLETED'
    });

    // Chart: Jobs per day (last 7 days)
    const jobsTrend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      const count = await Job.countDocuments({
        businessId,
        createdAt: { $gte: d, $lt: next }
      });
      jobsTrend.push({
        date: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        jobs: count
      });
    }

    // Chart: Revenue per day (last 7 days)
    const revenueTrend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      const dayJobs = await Job.find({
        businessId,
        createdAt: { $gte: d, $lt: next },
        status: { $in: ['COMPLETED', 'DELIVERED'] }
      }).select('totalPrice');
      const revenue = dayJobs.reduce((sum, job) => sum + (job.totalPrice || 0), 0);
      revenueTrend.push({
        date: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        revenue: Math.round(revenue * 100) / 100
      });
    }

    res.json({
      success: true,
      stats: {
        todayJobs,
        inProgress,
        avgCompletionTime,
        todayRevenue,
        monthlyRevenue,
        pendingDeliveries
      },
      jobsTrend,
      revenueTrend
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== CUSTOMER MANAGEMENT ====================

// @route   GET /api/admin/customers
// @desc    Get customers (search, pagination)
// @access  Private (Car Wash Admin)
router.get('/customers', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const query = { businessId: req.businessId };
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: term, $options: 'i' } },
        { phone: { $regex: term, $options: 'i' } },
        { whatsappNumber: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } }
      ];
    }

    const total = await Customer.countDocuments(query);
    const customers = await Customer.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();

    const customersWithStats = await Promise.all(
      customers.map(async (customer) => {
        const carsCount = await Car.countDocuments({ customerId: customer._id });
        const jobsCount = await Job.countDocuments({ customerId: customer._id });
        return {
          ...customer,
          stats: { cars: carsCount, jobs: jobsCount }
        };
      })
    );

    res.json({
      success: true,
      customers: customersWithStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)) || 0
      }
    });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/admin/customers
// @desc    Create new customer
// @access  Private (Car Wash Admin)
router.post('/customers', [
  body('name').notEmpty().trim(),
  body('phone').notEmpty(),
  body('whatsappNumber').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const customer = await Customer.create({
      ...req.body,
      businessId: req.businessId
    });

    res.status(201).json({
      success: true,
      customer
    });
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/admin/customers/:id
// @desc    Update customer
// @access  Private (Car Wash Admin)
router.put('/customers/:id', [
  body('name').optional().notEmpty().trim(),
  body('phone').optional().notEmpty(),
  body('whatsappNumber').optional().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }
    res.json({
      success: true,
      customer
    });
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/admin/customers/:id
// @desc    Delete customer
// @access  Private (Car Wash Admin)
router.delete('/customers/:id', async (req, res) => {
  try {
    const customer = await Customer.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    res.json({
      success: true,
      message: 'Customer deleted successfully'
    });
  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== CAR MANAGEMENT ====================

// @route   GET /api/admin/cars
// @desc    Get all cars (search, filter by customerId, pagination)
// @access  Private (Car Wash Admin)
router.get('/cars', async (req, res) => {
  try {
    const { customerId, search, page = 1, limit = 20 } = req.query;
    const query = { businessId: req.businessId };
    if (customerId) query.customerId = customerId;
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const customerIds = await Customer.find({ businessId: req.businessId, name: { $regex: term, $options: 'i' } }).distinct('_id');
      query.$or = [
        { carNumber: { $regex: term, $options: 'i' } },
        { brand: { $regex: term, $options: 'i' } },
        { model: { $regex: term, $options: 'i' } },
        { color: { $regex: term, $options: 'i' } },
        { customerId: { $in: customerIds } }
      ];
    }
    const total = await Car.countDocuments(query);
    const cars = await Car.find(query)
      .populate('customerId', 'name phone')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();
    res.json({
      success: true,
      cars,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) || 0 }
    });
  } catch (error) {
    console.error('Get cars error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/admin/cars
// @desc    Create new car
// @access  Private (Car Wash Admin)
router.post('/cars', [
  body('customerId').notEmpty(),
  body('carNumber').notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    // Verify customer belongs to business
    const customer = await Customer.findOne({
      _id: req.body.customerId,
      businessId: req.businessId
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    const car = await Car.create({
      ...req.body,
      businessId: req.businessId
    });

    res.status(201).json({
      success: true,
      car
    });
  } catch (error) {
    console.error('Create car error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/admin/cars/:id
// @desc    Update car
// @access  Private (Car Wash Admin)
router.put('/cars/:id', [
  body('carNumber').optional().notEmpty().trim(),
  body('customerId').optional().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    if (req.body.customerId) {
      const customer = await Customer.findOne({
        _id: req.body.customerId,
        businessId: req.businessId
      });
      if (!customer) {
        return res.status(404).json({
          success: false,
          message: 'Customer not found'
        });
      }
    }
    const car = await Car.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!car) {
      return res.status(404).json({
        success: false,
        message: 'Car not found'
      });
    }
    res.json({
      success: true,
      car
    });
  } catch (error) {
    console.error('Update car error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/admin/cars/:id
// @desc    Delete car
// @access  Private (Car Wash Admin)
router.delete('/cars/:id', async (req, res) => {
  try {
    const car = await Car.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId
    });

    if (!car) {
      return res.status(404).json({
        success: false,
        message: 'Car not found'
      });
    }

    res.json({
      success: true,
      message: 'Car deleted successfully'
    });
  } catch (error) {
    console.error('Delete car error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== SERVICE MANAGEMENT ====================

// @route   GET /api/admin/services
// @desc    Get all services (search, pagination)
// @access  Private (Car Wash Admin)
router.get('/services', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const query = { businessId: req.businessId };
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } }
      ];
    }
    const total = await Service.countDocuments(query);
    const services = await Service.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();
    res.json({
      success: true,
      services,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) || 0 }
    });
  } catch (error) {
    console.error('Get services error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/admin/services
// @desc    Create new service
// @access  Private (Car Wash Admin)
router.post('/services', [
  body('name').notEmpty().trim(),
  body('price').isFloat({ min: 0 }),
  body('minTime').isInt({ min: 1 }),
  body('maxTime').isInt({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const service = await Service.create({
      ...req.body,
      businessId: req.businessId
    });

    res.status(201).json({
      success: true,
      service
    });
  } catch (error) {
    console.error('Create service error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/admin/services/:id
// @desc    Update service
// @access  Private (Car Wash Admin)
router.put('/services/:id', [
  body('name').optional().notEmpty().trim(),
  body('price').optional().isFloat({ min: 0 }),
  body('minTime').optional().isInt({ min: 1 }),
  body('maxTime').optional().isInt({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const service = await Service.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }
    res.json({
      success: true,
      service
    });
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/admin/services/:id
// @desc    Delete service
// @access  Private (Car Wash Admin)
router.delete('/services/:id', async (req, res) => {
  try {
    const service = await Service.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId
    });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    res.json({
      success: true,
      message: 'Service deleted successfully'
    });
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== JOB MANAGEMENT ====================

// @route   GET /api/admin/jobs/:id
// @desc    Get single job
// @access  Private (Car Wash Admin)
router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await Job.findOne({
      _id: req.params.id,
      businessId: req.businessId
    })
      .populate('customerId', 'name phone whatsappNumber')
      .populate('carId', 'carNumber brand model color')
      .populate('services.serviceId', 'name');

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    res.json({
      success: true,
      job
    });
  } catch (error) {
    console.error('Get job error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/admin/jobs
// @desc    Get all jobs (search, filter by status, pagination)
// @access  Private (Car Wash Admin)
router.get('/jobs', async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const query = { businessId: req.businessId };
    if (status && status !== 'ALL') {
      query.status = status;
    }
    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const businessCustomerIds = await Customer.find({ businessId: req.businessId }).distinct('_id');
      const customerIds = await Customer.find({
        businessId: req.businessId,
        $or: [
          { name: { $regex: term, $options: 'i' } },
          { phone: { $regex: term, $options: 'i' } }
        ]
      }).distinct('_id');
      const carIds = await Car.find({
        customerId: { $in: businessCustomerIds },
        carNumber: { $regex: term, $options: 'i' }
      }).distinct('_id');
      query.$or = [
        { tokenNumber: { $regex: term, $options: 'i' } },
        { customerId: { $in: customerIds } },
        { carId: { $in: carIds } }
      ];
    }

    const jobs = await Job.find(query)
      .populate('customerId', 'name phone whatsappNumber')
      .populate('carId', 'carNumber brand model color')
      .populate('services.serviceId', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Job.countDocuments(query);

    res.json({
      success: true,
      jobs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/admin/jobs
// @desc    Create new job
// @access  Private (Car Wash Admin)
router.post('/jobs', [
  body('customerId').notEmpty(),
  body('carId').notEmpty(),
  body('serviceIds').isArray({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { customerId, carId, serviceIds, beforeImages, notes } = req.body;

    // Check capacity
    const capacityCheck = await canAcceptNewJob(req.businessId);
    if (!capacityCheck.canAccept) {
      return res.status(400).json({
        success: false,
        message: capacityCheck.reason
      });
    }

    // Verify customer and car belong to business
    const customer = await Customer.findOne({
      _id: customerId,
      businessId: req.businessId
    });

    const car = await Car.findOne({
      _id: carId,
      businessId: req.businessId,
      customerId: customerId
    });

    if (!customer || !car) {
      return res.status(404).json({
        success: false,
        message: 'Customer or car not found'
      });
    }

    // Fetch services
    const services = await Service.find({
      _id: { $in: serviceIds },
      businessId: req.businessId,
      isActive: true
    });

    if (services.length !== serviceIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more services not found'
      });
    }

    // Calculate total price and ETA
    const totalPrice = services.reduce((sum, s) => sum + s.price, 0);
    const estimatedDelivery = calculateETA(services);

    // Create job with retry logic for duplicate token numbers
    let job;
    let attempts = 0;
    const maxAttempts = 5;
    
    while (attempts < maxAttempts) {
      try {
        // Generate token number
        const tokenNumber = await generateTokenNumber(req.businessId);

        // Create job
        job = await Job.create({
          businessId: req.businessId,
          customerId,
          carId,
          tokenNumber,
          totalPrice,
          estimatedDelivery,
          beforeImages: beforeImages || [],
          notes,
          services: services.map(s => ({
            serviceId: s._id,
            price: s.price
          })),
          statusHistory: [{
            status: 'RECEIVED',
            changedAt: new Date()
          }]
        });
        
        // Success - break out of retry loop
        break;
      } catch (createError) {
        // Check if it's a duplicate key error (code 11000)
        if (createError.code === 11000 && attempts < maxAttempts - 1) {
          attempts++;
          // Wait a small random amount to avoid simultaneous retries
          await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
          continue; // Retry with new token
        }
        // If not a duplicate key error or max attempts reached, throw
        throw createError;
      }
    }
    
    if (!job) {
      throw new Error('Failed to create job after multiple attempts');
    }

    // Populate for response
    await job.populate('customerId', 'name phone whatsappNumber');
    await job.populate('carId', 'carNumber brand model color');
    await job.populate('services.serviceId', 'name');

    // Send WhatsApp notification
    try {
      const template = await WhatsAppTemplate.findOne({
        $or: [
          { businessId: req.businessId, name: 'Job Received', isActive: true },
          { isGlobal: true, name: 'Job Received', isActive: true }
        ]
      });

      if (template) {
        const message = formatTemplate(template.template, {
          customerName: customer.name,
          carNumber: car.carNumber,
          tokenNumber: job.tokenNumber,
          estimatedTime: estimatedDelivery.toLocaleTimeString()
        });

        const whatsappResult = await sendWhatsAppMessage(
          customer.whatsappNumber,
          message,
          template._id
        );

        await WhatsAppMessage.create({
          businessId: req.businessId,
          jobId: job._id,
          templateId: template._id,
          recipient: customer.whatsappNumber,
          message,
          status: whatsappResult.success ? 'SENT' : 'FAILED',
          sentAt: whatsappResult.success ? new Date() : null
        });
      }
    } catch (whatsappError) {
      console.error('WhatsApp send error:', whatsappError);
      // Don't fail job creation if WhatsApp fails
    }

    res.status(201).json({
      success: true,
      job
    });
  } catch (error) {
    console.error('Create job error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/admin/jobs/:id/status
// @desc    Update job status
// @access  Private (Car Wash Admin)
router.patch('/jobs/:id/status', [
  body('status').isIn(['RECEIVED', 'IN_PROGRESS', 'WASHING', 'DRYING', 'COMPLETED', 'DELIVERED', 'CANCELLED']),
  body('notes').optional().isString(),
  body('afterImages').optional().isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { status, notes, afterImages } = req.body;

    const job = await Job.findOne({
      _id: req.params.id,
      businessId: req.businessId
    }).populate('customerId', 'name whatsappNumber').populate('carId', 'carNumber');

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    // Validate status transition
    if (!isValidStatusTransition(job.status, status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status transition'
      });
    }

    // Update job
    job.status = status;
    if (afterImages) job.afterImages = afterImages;
    if (status === 'DELIVERED') job.actualDelivery = new Date();
    
    job.statusHistory.push({
      status,
      notes,
      changedAt: new Date()
    });

    await job.save();

    // Send WhatsApp notification
    try {
      const template = await WhatsAppTemplate.findOne({
        $or: [
          { businessId: req.businessId, name: `Job ${status}`, isActive: true },
          { isGlobal: true, name: `Job ${status}`, isActive: true }
        ]
      });

      if (template) {
        const message = formatTemplate(template.template, {
          customerName: job.customerId.name,
          carNumber: job.carId.carNumber,
          tokenNumber: job.tokenNumber,
          status,
          totalPrice: job.totalPrice.toString()
        });

        await sendWhatsAppMessage(
          job.customerId.whatsappNumber,
          message,
          template._id
        );

        await WhatsAppMessage.create({
          businessId: req.businessId,
          jobId: job._id,
          templateId: template._id,
          recipient: job.customerId.whatsappNumber,
          message,
          status: 'SENT',
          sentAt: new Date()
        });
      }
    } catch (whatsappError) {
      console.error('WhatsApp send error:', whatsappError);
    }

    await job.populate('customerId', 'name phone whatsappNumber');
    await job.populate('carId', 'carNumber brand model color');
    await job.populate('services.serviceId', 'name');

    res.json({
      success: true,
      job
    });
  } catch (error) {
    console.error('Update job status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== NOTIFICATIONS ====================

// @route   GET /api/admin/notifications
// @desc    Get all notifications for business
// @access  Private (Car Wash Admin)
router.get('/notifications', async (req, res) => {
  try {
    const notifications = await Notification.find({ businessId: req.businessId })
      .sort({ createdAt: -1 })
      .limit(100);

    const unreadCount = await Notification.countDocuments({
      businessId: req.businessId,
      isRead: false
    });

    res.json({
      success: true,
      notifications,
      unreadCount
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/admin/notifications/:id/read
// @desc    Mark notification as read
// @access  Private (Car Wash Admin)
router.patch('/notifications/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      notification
    });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/admin/notifications/read-all
// @desc    Mark all notifications as read
// @access  Private (Car Wash Admin)
router.patch('/notifications/read-all', async (req, res) => {
  try {
    await Notification.updateMany(
      { businessId: req.businessId, isRead: false },
      { isRead: true }
    );

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== BUSINESS MANAGEMENT ====================

// @route   GET /api/admin/business
// @desc    Get business information
// @access  Private (Car Wash Admin)
router.get('/business', async (req, res) => {
  try {
    const business = await Business.findById(req.businessId);
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
    console.error('Get business error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/admin/business
// @desc    Update business information
// @access  Private (Car Wash Admin)
router.put('/business', [
  body('businessName').optional().trim(),
  body('ownerName').optional().trim(),
  body('email').optional().isEmail(),
  body('phone').optional(),
  body('whatsappNumber').optional(),
  body('address').optional(),
  body('location').optional(),
  body('workingHoursStart').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('workingHoursEnd').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('carHandlingCapacity').optional().isIn(['SINGLE', 'MULTIPLE']),
  body('maxConcurrentJobs').optional().isInt({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const business = await Business.findByIdAndUpdate(
      req.businessId,
      req.body,
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

// ==================== SETTINGS ====================

const DEFAULT_WHATSAPP_TEMPLATES = {
  received: 'Hello {{name}}, your vehicle {{vehicleNumber}} has been received. Token: {{token}}',
  inProgress: 'Your car {{vehicleNumber}} is now in progress.',
  washing: 'Your car {{vehicleNumber}} is currently being washed.',
  drying: 'Your car {{vehicleNumber}} is being dried.',
  completed: '✅ Your car wash for {{vehicleNumber}} is completed.',
  delivered: '🚗 Thank you! Your vehicle {{vehicleNumber}} has been delivered.'
};

// @route   GET /api/admin/settings
// @desc    Get business settings
// @access  Private (Car Wash Admin)
router.get('/settings', async (req, res) => {
  try {
    let settings = await BusinessSettings.findOne({ businessId: req.businessId });

    if (!settings) {
      settings = await BusinessSettings.create({
        businessId: req.businessId,
        workingHours: { start: '09:00', end: '18:00' },
        capacity: 5,
        currency: 'USD',
        timezone: 'UTC',
        autoSendWhatsApp: true,
        notificationPreferences: {
          jobCreated: true,
          jobCompleted: true,
          jobDelivered: true,
          planExpiry: true
        },
        whatsappTemplates: DEFAULT_WHATSAPP_TEMPLATES
      });
    }
    const settingsObj = settings.toObject ? settings.toObject() : settings;
    if (!settingsObj.whatsappTemplates || typeof settingsObj.whatsappTemplates !== 'object') {
      settingsObj.whatsappTemplates = { ...DEFAULT_WHATSAPP_TEMPLATES };
    } else {
      settingsObj.whatsappTemplates = { ...DEFAULT_WHATSAPP_TEMPLATES, ...settingsObj.whatsappTemplates };
    }
    // Currency is set only by super admin; always return platform default currency
    const platform = await PlatformSettings.findOne({}).lean();
    if (platform?.defaultCurrency) {
      settingsObj.currency = platform.defaultCurrency;
    }
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

// @route   PUT /api/admin/settings
// @desc    Update business settings
// @access  Private (Car Wash Admin)
router.put('/settings', [
  body('capacity').optional().isInt({ min: 1 }),
  body('timezone').optional().isString(),
  body('autoSendWhatsApp').optional(),
  body('workingHours').optional(),
  body('notificationPreferences').optional(),
  body('shopWhatsappNumber').optional().trim().isString(),
  body('googleReviewLink').optional().trim().isString(),
  body('whatsappTemplates').optional().isObject(),
  body('whatsappTemplates.received').optional().isString(),
  body('whatsappTemplates.inProgress').optional().isString(),
  body('whatsappTemplates.washing').optional().isString(),
  body('whatsappTemplates.drying').optional().isString(),
  body('whatsappTemplates.completed').optional().isString(),
  body('whatsappTemplates.delivered').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const updateFields = {};
    if (req.body.capacity !== undefined) updateFields.capacity = req.body.capacity;
    if (req.body.timezone !== undefined) updateFields.timezone = req.body.timezone;
    if (req.body.autoSendWhatsApp !== undefined) updateFields.autoSendWhatsApp = req.body.autoSendWhatsApp;
    if (req.body.workingHours !== undefined) updateFields.workingHours = req.body.workingHours;
    if (req.body.notificationPreferences !== undefined) updateFields.notificationPreferences = req.body.notificationPreferences;
    if (req.body.shopWhatsappNumber !== undefined) updateFields.shopWhatsappNumber = req.body.shopWhatsappNumber?.trim() || null;
    if (req.body.googleReviewLink !== undefined) updateFields.googleReviewLink = req.body.googleReviewLink?.trim() || null;
    if (req.body.whatsappTemplates !== undefined) updateFields.whatsappTemplates = req.body.whatsappTemplates;

    let settings = await BusinessSettings.findOne({ businessId: req.businessId });
    if (!settings) {
      settings = await BusinessSettings.create({
        businessId: req.businessId,
        workingHours: { start: '09:00', end: '18:00' },
        capacity: 5,
        currency: 'USD',
        timezone: 'UTC',
        autoSendWhatsApp: true,
        notificationPreferences: {
          jobCreated: true,
          jobCompleted: true,
          jobDelivered: true,
          planExpiry: true
        },
        ...updateFields
      });
    } else {
      settings = await BusinessSettings.findOneAndUpdate(
        { businessId: req.businessId },
        { $set: updateFields },
        { new: true }
      );
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

// ==================== MANUAL SUBSCRIPTION ====================

// Ensure at least one active SubscriptionPlan exists (default "Free Tier")
// so Car Wash Admin "My Plan" shows plans even if Super Admin only added plans in "Plans & Pricing".
async function ensureDefaultSubscriptionPlan() {
  const count = await SubscriptionPlan.countDocuments();
  if (count > 0) return;
  await SubscriptionPlan.create({
    name: 'Free Tier',
    description: 'Default free plan for new shops',
    validityDays: 14,
    features: ['Basic access'],
    isActive: true,
    isFreeTrial: true
  });
}

// @route   GET /api/admin/my-subscription
// @desc    Get current shop subscription
// @access  Private (Car Wash Admin)
router.get('/my-subscription', async (req, res) => {
  try {
    await ensureDefaultSubscriptionPlan();
    let subscription = await ShopSubscription.findOne({ shopId: req.businessId })
      .populate('planId', 'name description validityDays features isActive isFreeTrial price');
    if (!subscription) {
      const business = await Business.findById(req.businessId).select('freeTrialUsed').lean();
      const skipFreeTrial = business?.freeTrialUsed === true;
      const defaultPlanQuery = { isActive: true };
      if (skipFreeTrial) defaultPlanQuery.isFreeTrial = { $ne: true };
      const defaultPlan = await SubscriptionPlan.findOne(defaultPlanQuery).sort({ validityDays: 1 });
      if (!defaultPlan) {
        return res.json({
          success: true,
          subscription: null,
          message: skipFreeTrial ? 'No paid plans available. Contact admin.' : 'No plans available. Contact admin.'
        });
      }
      const startDate = new Date();
      const expiryDate = new Date(startDate);
      expiryDate.setDate(expiryDate.getDate() + defaultPlan.validityDays);
      subscription = await ShopSubscription.create({
        shopId: req.businessId,
        planId: defaultPlan._id,
        startDate,
        expiryDate,
        status: 'ACTIVE'
      });
      await subscription.populate('planId', 'name description validityDays features isActive isFreeTrial price');
    }
    const subObj = subscription.toObject ? subscription.toObject() : subscription;
    if (subObj.expiryDate && new Date(subObj.expiryDate) < new Date() && subObj.status === 'ACTIVE') {
      await ShopSubscription.updateOne(
        { _id: subscription._id },
        { status: 'EXPIRED' }
      );
      subObj.status = 'EXPIRED';
    }
    const business = await Business.findById(req.businessId).select('freeTrialUsed').lean();
    const freeTrialUsed = business?.freeTrialUsed === true;
    const hasPendingUpgrade = await PlanUpgradeRequest.exists({ shopId: req.businessId, status: 'PENDING' });
    const canRequestUpgrade = !freeTrialUsed && !hasPendingUpgrade;
    res.json({ success: true, subscription: subObj, canRequestUpgrade });
  } catch (error) {
    console.error('Get my-subscription error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/available-plans
// @desc    List active subscription plans (for upgrade request). Free tier is excluded when free trial is used or when shop has requested a higher plan (pending upgrade).
// @access  Private (Car Wash Admin)
router.get('/available-plans', async (req, res) => {
  try {
    await ensureDefaultSubscriptionPlan();
    const business = await Business.findById(req.businessId).select('freeTrialUsed').lean();
    const freeTrialUsed = business?.freeTrialUsed === true;
    const hasPendingUpgrade = await PlanUpgradeRequest.exists({ shopId: req.businessId, status: 'PENDING' });
    const hideFreeTier = freeTrialUsed || hasPendingUpgrade;
    const query = { isActive: true };
    if (hideFreeTier) query.isFreeTrial = { $ne: true };
    const plans = await SubscriptionPlan.find(query).sort({ validityDays: 1 });
    res.json({ success: true, plans });
  } catch (error) {
    console.error('Get available plans error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/upgrade-requests
// @desc    Get current shop's upgrade requests (to show pending status)
// @access  Private (Car Wash Admin)
router.get('/upgrade-requests', async (req, res) => {
  try {
    const requests = await PlanUpgradeRequest.find({ shopId: req.businessId })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('currentPlanId', 'name')
      .populate('requestedPlanId', 'name validityDays');
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Get upgrade requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/admin/upgrade-request
// @desc    Submit plan upgrade request
// @access  Private (Car Wash Admin)
router.post('/upgrade-request', [
  body('requestedPlanId').notEmpty(),
  body('message').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const subscription = await ShopSubscription.findOne({ shopId: req.businessId })
      .populate('planId', 'name');
    if (!subscription) {
      return res.status(400).json({ success: false, message: 'No active subscription found' });
    }
    const pending = await PlanUpgradeRequest.findOne({
      shopId: req.businessId,
      status: 'PENDING'
    });
    if (pending) {
      return res.status(400).json({
        success: false,
        message: 'You already have a pending upgrade request. Wait for admin approval.'
      });
    }
    const requestedPlan = await SubscriptionPlan.findById(req.body.requestedPlanId);
    if (!requestedPlan || !requestedPlan.isActive) {
      return res.status(400).json({ success: false, message: 'Invalid or inactive plan' });
    }
    const business = await Business.findById(req.businessId).select('freeTrialUsed').lean();
    const isFreeTrialPlan = requestedPlan.isFreeTrial === true || (requestedPlan.name && /free tier/i.test(requestedPlan.name));
    if (business?.freeTrialUsed && isFreeTrialPlan) {
      return res.status(400).json({ success: false, message: 'Free trial is no longer available for your account.' });
    }
    const request = await PlanUpgradeRequest.create({
      shopId: req.businessId,
      currentPlanId: subscription.planId._id,
      requestedPlanId: req.body.requestedPlanId,
      message: req.body.message || undefined,
      status: 'PENDING'
    });
    await request.populate('currentPlanId', 'name');
    await request.populate('requestedPlanId', 'name validityDays features');
    res.status(201).json({ success: true, request });
  } catch (error) {
    console.error('Create upgrade request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== HELP & SUPPORT (Car Wash Admin) ====================

// @route   GET /api/admin/support/help-articles
// @desc    Get published help articles (with optional search and category filter)
// @access  Private (Car Wash Admin)
router.get('/support/help-articles', async (req, res) => {
  try {
    const { search = '', category = '' } = req.query;
    const query = { isPublished: true };
    if (category && category.trim()) query.category = new RegExp(category.trim(), 'i');
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { title: searchRegex },
        { content: searchRegex }
      ];
    }
    const articles = await HelpArticle.find(query).sort({ order: 1, createdAt: -1 });
    res.json({ success: true, articles });
  } catch (error) {
    console.error('Get help articles error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/support/tutorials
// @desc    Get published tutorials (with optional search)
// @access  Private (Car Wash Admin)
router.get('/support/tutorials', async (req, res) => {
  try {
    const { search = '' } = req.query;
    const query = { isPublished: true };
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { title: searchRegex },
        { description: searchRegex }
      ];
    }
    const tutorials = await Tutorial.find(query).sort({ order: 1, createdAt: -1 });
    res.json({ success: true, tutorials });
  } catch (error) {
    console.error('Get tutorials error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/support/tickets
// @desc    Get support tickets for current business
// @access  Private (Car Wash Admin)
router.get('/support/tickets', async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ businessId: req.businessId })
      .populate('replies.repliedBy', 'email')
      .sort({ createdAt: -1 });
    res.json({ success: true, tickets });
  } catch (error) {
    console.error('Get tickets error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/admin/support/tickets/:id
// @desc    Get single ticket (own business only)
// @access  Private (Car Wash Admin)
router.get('/support/tickets/:id', async (req, res) => {
  try {
    const ticket = await SupportTicket.findOne({
      _id: req.params.id,
      businessId: req.businessId
    }).populate('replies.repliedBy', 'email');
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    res.json({ success: true, ticket });
  } catch (error) {
    console.error('Get ticket error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/admin/support/tickets
// @desc    Create support ticket
// @access  Private (Car Wash Admin)
router.post('/support/tickets', [
  body('subject').notEmpty().trim(),
  body('description').notEmpty().trim(),
  body('priority').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const ticket = await SupportTicket.create({
      businessId: req.businessId,
      subject: req.body.subject,
      description: req.body.description,
      priority: req.body.priority || 'MEDIUM',
      createdBy: req.user._id,
      status: 'OPEN'
    });
    res.status(201).json({ success: true, ticket });
  } catch (error) {
    console.error('Create ticket error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
