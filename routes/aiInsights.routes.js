import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.middleware.js';
import AiInsight from '../models/AiInsight.model.js';
import { gatherAiInsightsData, VALID_MODULES } from '../services/aiInsightsDataService.js';
import { generateAiInsight, insightToMarkdown, FOLLOW_UP_PROMPTS } from '../services/aiInsightsService.js';
import { generateAiQaAnswer, qaResultToMarkdown } from '../services/aiInsightsQaService.js';
import { gatherQaBusinessData, enrichQaResultWithCustomers } from '../services/aiInsightsQaDataService.js';
import { generateWhatsAppTemplateMessage } from '../services/aiWhatsAppTemplateService.js';
import Business from '../models/Business.model.js';
import { parseAiInsightsDateRange } from '../utils/aiInsightsDateRange.js';

import { isAdminPanelRole } from '../utils/adminRoles.js';
import { requireBusinessModule } from '../middleware/businessModules.middleware.js';
import { enforceActiveSubscription } from '../middleware/subscription.middleware.js';

const router = express.Router();

router.use(authenticate);

router.use((req, res, next) => {
  if (!isAdminPanelRole(req.user.role)) {
    return res.status(403).json({ success: false, message: 'AI Insights is available to admins only.' });
  }
  if (!req.user.businessId) {
    return res.status(403).json({ success: false, message: 'Business not assigned' });
  }
  req.businessId = req.user.businessId;
  next();
});

router.use(requireBusinessModule('aiInsights'));
router.use(enforceActiveSubscription());

const generateValidators = [
  body('module').isIn(VALID_MODULES),
  body('insightType').isIn(['quick', 'deep', 'consultant', 'qa']),
  body('timeRange').optional().isString(),
  body('from').optional().isISO8601(),
  body('to').optional().isISO8601(),
  body('prompt').optional().isString().isLength({ max: 4000 }),
  body('followUpType').optional().isIn(Object.keys(FOLLOW_UP_PROMPTS)),
  body('parentInsightId').optional().isMongoId()
];

// POST /api/admin/ai-insights/generate
router.post('/generate', generateValidators, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const {
      module,
      insightType,
      timeRange = 'this_month',
      from,
      to,
      prompt = '',
      followUpType,
      parentInsightId
    } = req.body;

    const { label: rangeLabel } = parseAiInsightsDateRange(timeRange, from, to);

    let previousInsight = null;
    if (parentInsightId) {
      const parent = await AiInsight.findOne({
        _id: parentInsightId,
        businessId: req.businessId
      }).lean();
      if (parent?.result) previousInsight = parent.result;
    }

    const businessData = await gatherAiInsightsData(req.businessId, module, {
      range: timeRange,
      from,
      to
    });

    const result = await generateAiInsight({
      businessData,
      userPrompt: prompt,
      insightType,
      module,
      followUpType: followUpType || null,
      previousInsight
    });

    const reportMarkdown = insightToMarkdown(result, {
      businessName: businessData.business?.businessName,
      module,
      periodLabel: rangeLabel,
      generatedAt: new Date().toLocaleString()
    });

    const saved = await AiInsight.create({
      businessId: req.businessId,
      userId: req.user._id,
      module,
      insightType,
      timeRange,
      rangeLabel,
      customFrom: from ? new Date(from) : undefined,
      customTo: to ? new Date(to) : undefined,
      prompt: prompt?.trim() || undefined,
      followUpType: followUpType || undefined,
      parentInsightId: parentInsightId || undefined,
      businessHealthScore: result.businessHealthScore,
      result,
      reportMarkdown
    });

    res.json({
      success: true,
      insight: {
        id: saved._id,
        module,
        insightType,
        timeRange,
        rangeLabel,
        businessHealthScore: result.businessHealthScore,
        result,
        reportMarkdown,
        createdAt: saved.createdAt
      }
    });
  } catch (error) {
    console.error('AI Insights generate error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to generate insights'
    });
  }
});

// POST /api/admin/ai-insights/ask — natural language Q&A with actionable data
router.post('/ask', [
  body('module').optional().isIn(VALID_MODULES),
  body('timeRange').optional().isString(),
  body('from').optional().isISO8601(),
  body('to').optional().isISO8601(),
  body('question').isString().trim().isLength({ min: 3, max: 4000 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const {
      module = 'reports',
      timeRange = 'this_month',
      from,
      to,
      question
    } = req.body;

    const { label: rangeLabel } = parseAiInsightsDateRange(timeRange, from, to);
    const businessData = await gatherQaBusinessData(req.businessId, { range: timeRange, from, to });

    let result = await generateAiQaAnswer({
      businessData,
      question,
      module
    });

    result = enrichQaResultWithCustomers(result, businessData.customerIndex);

    const business = await Business.findById(req.businessId).select('businessName').lean();
    const reportMarkdown = qaResultToMarkdown(result, {
      businessName: business?.businessName,
      periodLabel: rangeLabel,
      generatedAt: new Date().toLocaleString()
    });

    const saved = await AiInsight.create({
      businessId: req.businessId,
      userId: req.user._id,
      module,
      insightType: 'qa',
      timeRange,
      rangeLabel,
      customFrom: from ? new Date(from) : undefined,
      customTo: to ? new Date(to) : undefined,
      prompt: question.trim(),
      result,
      reportMarkdown
    });

    res.json({
      success: true,
      insight: {
        id: saved._id,
        module,
        insightType: 'qa',
        timeRange,
        rangeLabel,
        question: question.trim(),
        result,
        reportMarkdown,
        createdAt: saved.createdAt
      }
    });
  } catch (error) {
    console.error('AI Q&A error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to answer question'
    });
  }
});

// POST /api/admin/ai-insights/whatsapp-template — generate WhatsApp job status template text
router.post('/whatsapp-template', [
  body('templateKey').isIn(['received', 'workStarted', 'completed', 'delivered', 'invoiceShare', 'invoicePackage', 'googleReview']),
  body('currentTemplate').optional().isString().isLength({ max: 2000 }),
  body('prompt').optional().isString().isLength({ max: 1000 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const business = await Business.findById(req.businessId).select('businessName').lean();
    const message = await generateWhatsAppTemplateMessage({
      templateKey: req.body.templateKey,
      businessName: business?.businessName,
      currentTemplate: req.body.currentTemplate || '',
      userPrompt: req.body.prompt || ''
    });

    res.json({ success: true, message, templateKey: req.body.templateKey });
  } catch (error) {
    console.error('AI WhatsApp template error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to generate template'
    });
  }
});

// GET /api/admin/ai-insights/history?module=&limit=
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = { businessId: req.businessId };
    if (req.query.module && VALID_MODULES.includes(String(req.query.module))) {
      filter.module = req.query.module;
    }

    const items = await AiInsight.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('module insightType timeRange rangeLabel businessHealthScore prompt followUpType createdAt')
      .lean();

    res.json({ success: true, history: items });
  } catch (error) {
    console.error('AI Insights history error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/ai-insights/history/:id
router.get('/history/:id', async (req, res) => {
  try {
    const item = await AiInsight.findOne({
      _id: req.params.id,
      businessId: req.businessId
    }).lean();

    if (!item) {
      return res.status(404).json({ success: false, message: 'Insight not found' });
    }

    res.json({ success: true, insight: item });
  } catch (error) {
    console.error('AI Insights get error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
