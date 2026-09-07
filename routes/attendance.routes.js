import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveBranchContext } from '../middleware/branchContext.middleware.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import { adminPanelOnly } from '../middleware/adminPanel.middleware.js';
import { isAdminPanelRole } from '../utils/adminRoles.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import {
  getTodayAttendance,
  punchIn,
  punchOut,
  breakStart,
  breakEnd,
  getCalendar,
  createCorrectionRequest,
  listCorrectionRequests,
  approveCorrectionRequest,
  rejectCorrectionRequest
} from '../services/attendanceService.js';

const router = express.Router();

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.user?.businessId) {
    return res.status(403).json({ success: false, message: 'Business not assigned' });
  }
  req.businessId = req.user.businessId;
  next();
});
router.use(resolveBranchContext);
router.use(enforceActiveSubscription());

async function requireAttendanceEnabled(req, res, next) {
  try {
    const settings = await BusinessSettings.findOne({ businessId: req.businessId })
      .select('attendanceEnabled')
      .lean();
    if (!settings?.attendanceEnabled) {
      return res.status(403).json({
        success: false,
        message: 'Attendance is disabled. Enable it in Settings.',
        code: 'ATTENDANCE_DISABLED'
      });
    }
    next();
  } catch (e) {
    next(e);
  }
}

router.use(requireAttendanceEnabled);

router.use((req, res, next) => {
  if (isAdminPanelRole(req.user?.role) || req.user?.role === 'EMPLOYEE') return next();
  return res.status(403).json({ success: false, message: 'Access denied' });
});

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      message: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array()
    });
    return false;
  }
  return true;
}

router.get('/today', async (req, res) => {
  try {
    const userId = req.user._id;
    const payload = await getTodayAttendance(req, userId);
    res.json({ success: true, ...payload });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.post('/punch-in', async (req, res) => {
  try {
    if (req.user.role !== 'EMPLOYEE') {
      return res.status(403).json({ success: false, message: 'Only employees can punch in' });
    }
    const payload = await punchIn(req, req.user._id);
    res.json({ success: true, ...payload });
  } catch (e) {
    res.status(e.status || 500).json({
      success: false,
      message: e.message || 'Server error',
      ...(e.code ? { code: e.code } : {}),
      ...(e.distanceMeters != null ? { distanceMeters: e.distanceMeters } : {}),
      ...(e.perimeterMeters != null ? { perimeterMeters: e.perimeterMeters } : {})
    });
  }
});

router.post('/punch-out', async (req, res) => {
  try {
    if (req.user.role !== 'EMPLOYEE') {
      return res.status(403).json({ success: false, message: 'Only employees can punch out' });
    }
    const payload = await punchOut(req, req.user._id);
    res.json({ success: true, ...payload });
  } catch (e) {
    res.status(e.status || 500).json({
      success: false,
      message: e.message || 'Server error',
      ...(e.code ? { code: e.code } : {}),
      ...(e.distanceMeters != null ? { distanceMeters: e.distanceMeters } : {}),
      ...(e.perimeterMeters != null ? { perimeterMeters: e.perimeterMeters } : {})
    });
  }
});

router.post('/break-start', async (req, res) => {
  try {
    if (req.user.role !== 'EMPLOYEE') {
      return res.status(403).json({ success: false, message: 'Only employees can take a break' });
    }
    const payload = await breakStart(req, req.user._id);
    res.json({ success: true, ...payload });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.post('/break-end', async (req, res) => {
  try {
    if (req.user.role !== 'EMPLOYEE') {
      return res.status(403).json({ success: false, message: 'Only employees can end a break' });
    }
    const payload = await breakEnd(req, req.user._id);
    res.json({ success: true, ...payload });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.get('/calendar', async (req, res) => {
  try {
    const payload = await getCalendar(req, {
      from: req.query.from,
      to: req.query.to,
      userId: req.query.userId
    });
    res.json({ success: true, ...payload });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.post('/correction-requests', [
  body('date').notEmpty().withMessage('Date is required'),
  body('reason').trim().notEmpty().withMessage('Reason is required')
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    if (req.user.role !== 'EMPLOYEE') {
      return res.status(403).json({ success: false, message: 'Only employees can request attendance review' });
    }
    const doc = await createCorrectionRequest(req, {
      date: req.body.date,
      reason: req.body.reason,
      proposedPunchInAt: req.body.proposedPunchInAt,
      proposedPunchOutAt: req.body.proposedPunchOutAt
    });
    res.status(201).json({ success: true, request: doc });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.get('/correction-requests', async (req, res) => {
  try {
    const requests = await listCorrectionRequests(req, { status: req.query.status });
    res.json({ success: true, requests });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.patch('/correction-requests/:id/approve', adminPanelOnly, [
  body('punchInAt').notEmpty().withMessage('Punch in time is required'),
  body('punchOutAt').notEmpty().withMessage('Punch out time is required')
], async (req, res) => {
  try {
    if (!validate(req, res)) return;
    const request = await approveCorrectionRequest(req, req.params.id, {
      punchInAt: req.body.punchInAt,
      punchOutAt: req.body.punchOutAt,
      reviewNote: req.body.reviewNote
    });
    res.json({ success: true, request });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

router.patch('/correction-requests/:id/reject', adminPanelOnly, async (req, res) => {
  try {
    const request = await rejectCorrectionRequest(req, req.params.id, {
      reviewNote: req.body?.reviewNote
    });
    res.json({ success: true, request });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || 'Server error' });
  }
});

export default router;
