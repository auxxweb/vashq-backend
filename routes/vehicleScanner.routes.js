import express from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';
import BusinessSettings from '../models/BusinessSettings.model.js';
import { analyzeVehicleImage } from '../services/vehicleScannerService.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
      return;
    }
    cb(new Error('Only image uploads are allowed'));
  }
});

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.user?.businessId) {
    return res.status(403).json({ success: false, message: 'Business not assigned' });
  }
  req.businessId = req.user.businessId;
  next();
});
router.use(enforceActiveSubscription());

async function requireVehicleScannerEnabled(req, res, next) {
  try {
    const settings = await BusinessSettings.findOne({ businessId: req.businessId })
      .select('vehicleScannerEnabled')
      .lean();
    if (!settings?.vehicleScannerEnabled) {
      return res.status(403).json({
        success: false,
        message: 'AI vehicle scanner is disabled. Enable it in Settings.'
      });
    }
    next();
  } catch (err) {
    console.error('vehicle scanner settings check:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

/**
 * POST /api/admin/vehicle-scanner/scan
 * multipart field: image
 */
router.post('/scan', requireVehicleScannerEnabled, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Image is too large. Please try a clearer, smaller photo.'
          : err.message === 'Only image uploads are allowed'
            ? 'Please upload a valid image.'
            : 'Unable to upload image. Please try again.';
      return res.status(400).json({ success: false, message });
    }

    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ success: false, message: 'Image is required.' });
      }

      const mime = req.file.mimetype || 'image/jpeg';
      const dataUrl = `data:${mime};base64,${req.file.buffer.toString('base64')}`;

      const vehicle = await analyzeVehicleImage(dataUrl);
      return res.json({ success: true, vehicle });
    } catch (error) {
      console.error('Vehicle scan error:', error?.code || error?.message || error);
      const status = error.status || 500;
      const message =
        error.code === 'NOT_CONFIGURED'
          ? 'Vehicle scanner is not configured on the server.'
          : 'Unable to analyze this vehicle. Please try taking a clearer photo.';
      return res.status(status).json({ success: false, message });
    }
  });
});

export default router;
