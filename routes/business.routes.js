import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.middleware.js';
import User from '../models/User.model.js';

const router = express.Router();

// Business owner only endpoints
router.use(authenticate);

// POST /api/business/save-token
// Body: { fcmToken, previousToken? }
router.post('/save-token', [
  body('fcmToken').notEmpty().isString().trim(),
  body('previousToken').optional().isString().trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    if (req.user.role !== 'CAR_WASH_ADMIN' && req.user.role !== 'EMPLOYEE') {
      return res.status(403).json({ success: false, message: 'Only business owners and employees can register push tokens' });
    }

    const token = String(req.body.fcmToken).trim();
    const previousToken = req.body.previousToken ? String(req.body.previousToken).trim() : '';
    // If token rotated on same device/browser, remove the previous one to prevent duplicate pushes.
    if (previousToken && previousToken !== token) {
      await User.updateOne({ _id: req.user._id }, { $pull: { fcmTokens: previousToken } });
    }
    await User.updateOne({ _id: req.user._id }, { $addToSet: { fcmTokens: token } });
    // Cap list size (keep last 20)
    await User.updateOne(
      { _id: req.user._id },
      [{ $set: { fcmTokens: { $slice: ['$fcmTokens', -20] } } }]
    ).catch(() => {});

    res.json({ success: true, message: 'Token saved' });
  } catch (e) {
    console.error('Save business token error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/business/remove-token
// Body: { fcmToken? }
// - If fcmToken provided: removes that token
// - Else: clears all tokens (useful when permission is blocked)
router.post('/remove-token', [
  body('fcmToken').optional().isString().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    if (req.user.role !== 'CAR_WASH_ADMIN' && req.user.role !== 'EMPLOYEE') {
      return res.status(403).json({ success: false, message: 'Only business owners and employees can manage push tokens' });
    }
    const token = req.body.fcmToken ? String(req.body.fcmToken).trim() : '';
    if (token) {
      await User.updateOne({ _id: req.user._id }, { $pull: { fcmTokens: token } });
      return res.json({ success: true, message: 'Token removed' });
    }
    await User.updateOne({ _id: req.user._id }, { $set: { fcmTokens: [] } });
    res.json({ success: true, message: 'All tokens cleared' });
  } catch (e) {
    console.error('Remove business token error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/business/push-status
// Returns: { enabled: boolean, tokenCount: number }
router.get('/push-status', async (req, res) => {
  try {
    if (req.user.role !== 'CAR_WASH_ADMIN' && req.user.role !== 'EMPLOYEE') {
      return res.status(403).json({ success: false, message: 'Only business owners and employees' });
    }
    const u = await User.findOne({ _id: req.user._id }).select('fcmTokens').lean();
    const count = Array.isArray(u?.fcmTokens) ? u.fcmTokens.filter(Boolean).length : 0;
    res.json({ success: true, enabled: count > 0, tokenCount: count });
  } catch (e) {
    console.error('Push status error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;

