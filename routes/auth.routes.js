import express from 'express';
import { body, validationResult } from 'express-validator';
import User from '../models/User.model.js';
import Branch from '../models/Branch.model.js';
import OtpToken from '../models/OtpToken.model.js';
import { generateToken } from '../utils/jwt.utils.js';
import { generateOTP, getOTPExpiry } from '../utils/otp.utils.js';
import { sendOTPEmail } from '../utils/email.utils.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { isBranchOperational } from '../services/branchService.js';
import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';
import { invalidateUserAuthCache } from '../utils/authCache.js';
import { isAdminPanelRole } from '../utils/adminRoles.js';

async function assertBranchesModuleForBusiness(businessId) {
  const modules = await getBusinessModules(businessId);
  return isModuleEnabled(modules, 'branches');
}

const router = express.Router();

// @route   POST /api/auth/register
// @desc    Initial setup only — requires REGISTER_SECRET in production
// @access  Protected by setup secret (not public in production)
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('role').optional().isIn(['SUPER_ADMIN', 'CAR_WASH_ADMIN'])
], async (req, res) => {
  try {
    const isProd = process.env.NODE_ENV === 'production';
    const setupSecret = process.env.REGISTER_SECRET;
    const providedSecret = req.headers['x-register-secret'] || req.body.setupSecret;

    if (isProd) {
      if (!setupSecret || providedSecret !== setupSecret) {
        return res.status(404).json({ success: false, message: 'Route not found' });
      }
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;
    let { role } = req.body;
    if (!role) role = 'CAR_WASH_ADMIN';

    if (role === 'SUPER_ADMIN') {
      const existingSuper = await User.countDocuments({ role: 'SUPER_ADMIN' });
      if (existingSuper > 0) {
        return res.status(403).json({
          success: false,
          message: 'Super admin already exists. Use the super admin panel to manage users.'
        });
      }
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists'
      });
    }

    const user = await User.create({ email, password, role });

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  body('branchId').optional().isMongoId()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, branchId } = req.body;

    const user = await User.findOne({ email }).populate('businessId', 'businessName status');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        message: 'Account is suspended'
      });
    }

    if (!branchId && user.role === 'BRANCH_ADMIN') {
      const bizId = user.businessId?._id || user.businessId;
      if (!(await assertBranchesModuleForBusiness(bizId))) {
        return res.status(403).json({
          success: false,
          code: 'MODULE_DISABLED',
          message: 'Multi-branch is disabled for this business. Branch logins are unavailable.'
        });
      }
      if (!user.branchId) {
        return res.status(403).json({
          success: false,
          message: 'Branch assignment not found. Contact your business owner.'
        });
      }
      const branch = await Branch.findById(user.branchId).lean();
      if (!branch) {
        return res.status(403).json({
          success: false,
          message: 'Assigned branch not found'
        });
      }
      const operational = await isBranchOperational(branch);
      if (!operational) {
        return res.status(403).json({
          success: false,
          code: 'BRANCH_INACTIVE',
          message: 'This branch is inactive or its license has expired. Contact your business owner.'
        });
      }
    }

    if (branchId) {
      const branch = await Branch.findById(branchId).lean();
      if (!branch) {
        return res.status(400).json({ success: false, message: 'Invalid branch portal' });
      }

      if (!(await assertBranchesModuleForBusiness(branch.businessId))) {
        return res.status(403).json({
          success: false,
          code: 'MODULE_DISABLED',
          message: 'Multi-branch is disabled for this business. Branch portals are unavailable.'
        });
      }

      const userBiz = String(user.businessId?._id || user.businessId || '');
      if (userBiz !== String(branch.businessId)) {
        return res.status(403).json({
          success: false,
          message: 'This account is not authorized for this branch'
        });
      }

      if (user.role === 'SUPER_ADMIN') {
        return res.status(403).json({
          success: false,
          message: 'Use the platform admin login instead'
        });
      }

      if (user.role === 'BRANCH_ADMIN' || user.role === 'EMPLOYEE') {
        if (!user.branchId || String(user.branchId) !== String(branchId)) {
          return res.status(403).json({
            success: false,
            message: 'This login is not set up for this branch. Ask your owner to create a login under Settings → Branches → Logins.'
          });
        }
        const operational = await isBranchOperational(branch);
        if (!operational) {
          return res.status(403).json({
            success: false,
            code: 'BRANCH_INACTIVE',
            message: 'This branch is inactive. Contact your business owner.'
          });
        }
      }

      if (user.role === 'CAR_WASH_ADMIN') {
        const operational = await isBranchOperational(branch);
        if (!operational) {
          return res.status(403).json({
            success: false,
            code: 'BRANCH_INACTIVE',
            message: 'This branch is inactive or its license has expired.'
          });
        }
      }

      // Legacy branch portal logins were created as EMPLOYEE without an employee code — promote once.
      if (user.role === 'EMPLOYEE' && !user.employeeCode) {
        user.role = 'BRANCH_ADMIN';
      }
    }

    // Update last login
    user.lastLoginAt = new Date();
    await user.save();
    invalidateUserAuthCache(user._id);

    const token = generateToken(user._id);

    const userResponse = {
      id: user._id,
      email: user.email,
      role: user.role,
      businessId: user.businessId?._id || user.businessId || null,
      businessName: user.businessId?.businessName || null
    };
    if (user.role === 'EMPLOYEE' || user.role === 'BRANCH_ADMIN') {
      userResponse.name = user.name || '';
      userResponse.branchId = user.branchId || null;
      if (user.role === 'EMPLOYEE') {
        userResponse.employeeCode = user.employeeCode || '';
      }
    }
    res.json({
      success: true,
      token,
      user: userResponse
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Request password reset OTP
// @access  Public
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal if user exists (security best practice)
      return res.json({
        success: true,
        message: 'If an account exists with this email, an OTP has been sent.'
      });
    }

    // Limit active OTPs per user
    const recentCutoff = new Date(Date.now() - 15 * 60 * 1000);
    const recentCount = await OtpToken.countDocuments({
      userId: user._id,
      type: 'PASSWORD_RESET',
      createdAt: { $gte: recentCutoff }
    });
    if (recentCount >= 5) {
      return res.status(429).json({
        success: false,
        message: 'Too many reset attempts. Please try again later.'
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = getOTPExpiry(15);

    await OtpToken.create({
      userId: user._id,
      token: otp,
      type: 'PASSWORD_RESET',
      expiresAt
    });

    // Send email
    await sendOTPEmail(user.email, otp);

    res.json({
      success: true,
      message: 'If an account exists with this email, an OTP has been sent.'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/auth/reset-password
// @desc    Reset password with OTP
// @access  Public
router.post('/reset-password', [
  body('email').isEmail().normalizeEmail(),
  body('otp').isLength({ min: 6, max: 6 }),
  body('newPassword').isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, otp, newPassword } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email or OTP'
      });
    }

    // Verify OTP
    const otpRecord = await OtpToken.findOne({
      userId: user._id,
      token: otp,
      type: 'PASSWORD_RESET',
      used: false,
      expiresAt: { $gt: new Date() }
    });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP'
      });
    }

    // Mark OTP as used
    otpRecord.used = true;
    await otpRecord.save();

    // Update password
    user.password = newPassword;
    await user.save();
    invalidateUserAuthCache(user._id);

    res.json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password')
      .populate('businessId', 'businessName status');

    const u = {
      id: user._id,
      email: user.email,
      role: user.role,
      businessId: user.businessId?._id || null,
      businessName: user.businessId?.businessName || null
    };
    if (user.role === 'EMPLOYEE' || user.role === 'BRANCH_ADMIN') {
      u.name = user.name || '';
      u.phone = user.phone || '';
      u.address = user.address || '';
      u.branchId = user.branchId || null;
      if (user.role === 'EMPLOYEE') {
        u.employeeCode = user.employeeCode || '';
      }
    }
    res.json({ success: true, user: u });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PUT /api/auth/me/password
// @desc    Change own password (business owner or branch admin only)
// @access  Private
router.put('/me/password', authenticate, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
  body('confirmPassword').optional().isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (!isAdminPanelRole(user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Employee accounts cannot change password here. Ask your business or branch admin to reset it.'
      });
    }
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (confirmPassword != null && newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'New passwords do not match' });
    }
    const valid = await user.comparePassword(currentPassword);
    if (!valid) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ success: false, message: 'New password must be different from current password' });
    }
    user.password = newPassword;
    await user.save();
    invalidateUserAuthCache(user._id);
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
