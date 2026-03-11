import express from 'express';
import Invoice from '../models/Invoice.model.js';
import PlatformSettings from '../models/PlatformSettings.model.js';

const router = express.Router();

// GET /api/public/invoice/:id/view?token=xxx - view invoice by share token (no auth)
// Currency is global (platform default) set by Super Admin
router.get('/invoice/:id/view', async (req, res) => {
  try {
    const { id } = req.params;
    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token required' });
    }
    const invoice = await Invoice.findOne({ _id: id, shareToken: token }).lean();
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    const platform = await PlatformSettings.findOne({}).lean();
    const currency = platform?.defaultCurrency || 'USD';
    res.json({ success: true, invoice, currency });
  } catch (error) {
    console.error('Public invoice view error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
