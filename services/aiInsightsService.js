const OUTPUT_SCHEMA = {
  executiveSummary: 'string — 2-4 sentences overview',
  businessHealthScore: 'number 0-100',
  businessHealthExplanation: 'string',
  keyFindings: ['string'],
  mistakesBeingMade: ['string'],
  growthOpportunities: ['string'],
  revenueImprovementRecommendations: ['string'],
  customerRetentionRecommendations: ['string'],
  staffOptimizationRecommendations: ['string'],
  marketingRecommendations: ['string'],
  immediateActionPlan: {
    next7Days: ['string'],
    next30Days: ['string'],
    next90Days: ['string']
  },
  strengths: ['string'],
  weaknesses: ['string'],
  risks: ['string']
};

const FOLLOW_UP_PROMPTS = {
  revenue_growth: 'Create a detailed revenue growth plan with specific tactics, targets, and weekly milestones for this car wash business.',
  customer_retention: 'Create a detailed customer retention plan with win-back campaigns, loyalty ideas, and measurable KPIs.',
  whatsapp_campaign: 'Create 3 WhatsApp campaign templates with timing, audience segments, and expected outcomes for this car wash.',
  employee_improvement: 'Create an employee improvement plan with training focus areas, performance targets, and incentive ideas.',
  expense_reduction: 'Create an expense reduction plan with category-specific cuts, savings targets, and implementation steps.',
  subscription_growth: 'Create a subscription/package growth plan with pricing, bundling, and promotion strategies.'
};

function buildSystemPrompt(insightType, module, followUpType) {
  const depth = insightType === 'quick'
    ? 'Provide concise, high-impact insights. Keep each list to 3-5 items max.'
    : insightType === 'consultant'
      ? 'Act as a senior car wash business consultant. Answer the owner\'s strategic question with depth, specificity, and actionable guidance grounded in their data.'
      : 'Provide thorough, consultant-grade analysis with specific numbers from the data where possible.';

  const followUp = followUpType && FOLLOW_UP_PROMPTS[followUpType]
    ? `\nFocus exclusively on: ${FOLLOW_UP_PROMPTS[followUpType]}`
    : '';

  return `You are an expert car wash business consultant embedded in VashQ SaaS.
${depth}
STRICT RULES:
- Answer ONLY using the provided business JSON and the owner's question/focus.
- The owner may ask about analytics, workflow mistakes, data/report issues, or operational doubts — always tie answers to their data.
- Do NOT answer product how-to, login/support, technical troubleshooting, or general knowledge unrelated to their business data.
- If the question cannot be answered from the data, say so in executiveSummary and keyFindings; do not guess metrics.
- Do not invent numbers not supported by the data.
Be direct about problems and opportunities. Use the business currency when mentioning money.
Module focus: ${module}.${followUp}

Return valid JSON matching this schema (all fields required, use empty arrays if no data):
${JSON.stringify(OUTPUT_SCHEMA, null, 2)}`;
}

function buildUserPrompt({ businessData, userPrompt, insightType, previousInsight }) {
  const parts = [
    '## Business Data (JSON)',
    JSON.stringify(businessData, null, 2)
  ];

  if (previousInsight) {
    parts.push('\n## Previous Insight Context', JSON.stringify(previousInsight, null, 2));
  }

  if (userPrompt?.trim()) {
    parts.push('\n## Owner Question / Focus', userPrompt.trim());
  }

  if (insightType === 'consultant' && !userPrompt?.trim()) {
    parts.push('\n## Owner Question', 'What are the biggest opportunities and risks for my business right now?');
  }

  return parts.join('\n');
}

export function insightToMarkdown(result, meta = {}) {
  const lines = [];
  lines.push('# VashQ AI Insights Report');
  if (meta.businessName) lines.push(`**Business:** ${meta.businessName}`);
  if (meta.module) lines.push(`**Module:** ${meta.module}`);
  if (meta.periodLabel) lines.push(`**Period:** ${meta.periodLabel}`);
  if (meta.generatedAt) lines.push(`**Generated:** ${meta.generatedAt}`);
  lines.push('');

  if (result.executiveSummary) {
    lines.push('## Executive Summary', result.executiveSummary, '');
  }
  if (result.businessHealthScore != null) {
    lines.push(`## Business Health Score: ${result.businessHealthScore}/100`, result.businessHealthExplanation || '', '');
  }

  const section = (title, items) => {
    if (!items?.length) return;
    lines.push(`## ${title}`);
    items.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  };

  section('Key Findings', result.keyFindings);
  section('Strengths', result.strengths);
  section('Weaknesses', result.weaknesses);
  section('Risks', result.risks);
  section('Mistakes Being Made', result.mistakesBeingMade);
  section('Growth Opportunities', result.growthOpportunities);
  section('Revenue Improvement Recommendations', result.revenueImprovementRecommendations);
  section('Customer Retention Recommendations', result.customerRetentionRecommendations);
  section('Staff Optimization Recommendations', result.staffOptimizationRecommendations);
  section('Marketing Recommendations', result.marketingRecommendations);

  const plan = result.immediateActionPlan;
  if (plan) {
    lines.push('## Immediate Action Plan');
    if (plan.next7Days?.length) {
      lines.push('### Next 7 Days');
      plan.next7Days.forEach((a) => lines.push(`- ${a}`));
    }
    if (plan.next30Days?.length) {
      lines.push('### Next 30 Days');
      plan.next30Days.forEach((a) => lines.push(`- ${a}`));
    }
    if (plan.next90Days?.length) {
      lines.push('### Next 90 Days');
      plan.next90Days.forEach((a) => lines.push(`- ${a}`));
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function generateAiInsight({
  businessData,
  userPrompt,
  insightType = 'deep',
  module = 'reports',
  followUpType = null,
  previousInsight = null
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI Insights is not configured. Please set OPENAI_API_KEY on the server.');
    err.status = 503;
    throw err;
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const maxTokens = insightType === 'quick' ? 1800 : 4096;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: insightType === 'consultant' ? 0.6 : 0.4,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(insightType, module, followUpType) },
        { role: 'user', content: buildUserPrompt({ businessData, userPrompt, insightType, previousInsight }) }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const err = new Error(`AI service error (${response.status}). Please try again later.`);
    err.status = response.status >= 500 ? 502 : 400;
    err.detail = errBody.slice(0, 500);
    throw err;
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error('AI returned an empty response.');
    err.status = 502;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const err = new Error('AI returned invalid JSON. Please try again.');
    err.status = 502;
    throw err;
  }

  const score = Number(parsed.businessHealthScore);
  parsed.businessHealthScore = Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : null;

  return parsed;
}

export { FOLLOW_UP_PROMPTS };
