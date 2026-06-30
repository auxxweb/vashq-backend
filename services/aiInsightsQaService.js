const QA_OUTPUT_SCHEMA = {
  directAnswer: 'string — clear, conversational answer to the owner question',
  explanation: 'string — optional supporting detail or caveats',
  dataTable: {
    title: 'string — table title e.g. Top 10 customers by visits',
    columns: ['string — column header labels'],
    rows: [
      {
        customerId: 'string|null — MongoDB customer _id when row is a customer (from provided data only)',
        cells: ['string — cell values matching columns order']
      }
    ]
  },
  suggestedActions: [
    {
      type: 'whatsapp_retention | view_customers | none',
      label: 'string — button label e.g. Send win-back WhatsApp',
      customerIds: ['string — customer ids from data, max 10 per action']
    }
  ],
  followUpQuestions: ['string — 2-3 suggested follow-up questions the owner might ask next']
};

function buildQaSystemPrompt(module) {
  return `You are VashQ AI — a smart business assistant for car wash owners.
You answer questions using ONLY the business JSON provided. You can:
- Answer analytics questions (top customers, inactive customers, employee performance, services, revenue trends)
- Explain data patterns and clear operational doubts
- Return structured tables when the owner asks for lists or rankings
- Suggest WhatsApp retention actions for inactive or valuable customers

STRICT RULES:
- Use customerId values EXACTLY from the provided data when listing customers — never invent IDs
- If dataTable is not needed, set rows to empty array but keep title/columns
- If the question cannot be answered from data, say so clearly in directAnswer
- Do NOT invent metrics, customer names, or phone numbers
- For "top N" questions, limit rows to what was asked (default 10 if unspecified)
- Use the business currency when mentioning money
- Module context: ${module}

Return valid JSON matching this schema (all fields required):
${JSON.stringify(QA_OUTPUT_SCHEMA, null, 2)}`;
}

function buildQaUserPrompt(businessData, question) {
  return [
    '## Business Data (JSON)',
    JSON.stringify({
      period: businessData.period,
      business: businessData.business,
      summary: businessData.summary,
      topCustomersAllTime: businessData.topCustomersAllTime,
      inactiveCustomers30d: businessData.inactiveCustomers30d,
      newCustomersInPeriod: businessData.newCustomersInPeriod,
      employeeLeaderboard: businessData.employeeLeaderboard,
      topServicesInPeriod: businessData.topServicesInPeriod
    }, null, 2),
    '',
    '## Owner Question',
    question.trim()
  ].join('\n');
}

export function qaResultToMarkdown(result, meta = {}) {
  const lines = ['# VashQ AI Answer'];
  if (meta.businessName) lines.push(`**Business:** ${meta.businessName}`);
  if (meta.periodLabel) lines.push(`**Period:** ${meta.periodLabel}`);
  if (meta.generatedAt) lines.push(`**Generated:** ${meta.generatedAt}`);
  lines.push('');
  lines.push('## Answer', result.directAnswer || '', '');
  if (result.explanation) {
    lines.push('## Details', result.explanation, '');
  }
  if (result.dataTable?.rows?.length) {
    lines.push(`## ${result.dataTable.title || 'Data'}`);
    const cols = result.dataTable.columns || [];
    if (cols.length) lines.push(cols.join(' | '));
    for (const row of result.dataTable.rows) {
      lines.push((row.cells || []).join(' | '));
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function generateAiQaAnswer({
  businessData,
  question,
  module = 'reports'
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI is not configured. Please set OPENAI_API_KEY on the server.');
    err.status = 503;
    throw err;
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildQaSystemPrompt(module) },
        { role: 'user', content: buildQaUserPrompt(businessData, question) }
      ]
    })
  });

  if (!response.ok) {
    const err = new Error(`AI service error (${response.status}). Please try again later.`);
    err.status = response.status >= 500 ? 502 : 400;
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

  parsed.answerType = 'qa';
  if (!Array.isArray(parsed.suggestedActions)) parsed.suggestedActions = [];
  if (!Array.isArray(parsed.followUpQuestions)) parsed.followUpQuestions = [];
  if (!parsed.dataTable) {
    parsed.dataTable = { title: '', columns: [], rows: [] };
  }

  return parsed;
}
