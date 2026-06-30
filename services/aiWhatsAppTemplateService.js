const TEMPLATE_META = {
  received: {
    label: 'Received',
    placeholders: ['{{name}}', '{{vehicleNumber}}', '{{token}}'],
    purpose: 'Sent when a vehicle is received at the shop'
  },
  workStarted: {
    label: 'Work Started (In Progress)',
    placeholders: ['{{name}}', '{{vehicleNumber}}', '{{token}}'],
    purpose: 'Sent when washing/work has started'
  },
  completed: {
    label: 'Completed (Ready for Delivery)',
    placeholders: ['{{name}}', '{{vehicleNumber}}', '{{token}}'],
    purpose: 'Sent when the vehicle is ready for pickup/delivery'
  },
  delivered: {
    label: 'Delivered (Job Completed)',
    placeholders: ['{{name}}', '{{vehicleNumber}}', '{{token}}', '{{beforeImagesLink}}', '{{afterImagesLink}}'],
    purpose: 'Sent after delivery with optional before/after photo links'
  },
  invoiceShare: {
    label: 'Invoice — Job / Service',
    placeholders: ['{{name}}', '{{total}}', '{{currency}}', '{{invoiceLink}}', '{{invoiceNumber}}', '{{vehicleNumber}}'],
    purpose: 'WhatsApp message when sharing a service job invoice PDF link'
  },
  invoicePackage: {
    label: 'Invoice — Package',
    placeholders: ['{{name}}', '{{total}}', '{{currency}}', '{{invoiceLink}}', '{{packageName}}', '{{invoiceNumber}}'],
    purpose: 'WhatsApp message when sharing a package invoice PDF link'
  },
  googleReview: {
    label: 'Google Review Request',
    placeholders: ['{{reviewLink}}'],
    purpose: 'Ask the customer for a Google review after delivery'
  }
};

export function getWhatsAppTemplateMeta(templateKey) {
  return TEMPLATE_META[templateKey] || null;
}

export async function generateWhatsAppTemplateMessage({
  templateKey,
  businessName,
  currentTemplate = '',
  userPrompt = ''
}) {
  const meta = TEMPLATE_META[templateKey];
  if (!meta) {
    const err = new Error(`Unknown template: ${templateKey}`);
    err.status = 400;
    throw err;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI is not configured. Please set OPENAI_API_KEY on the server.');
    err.status = 503;
    throw err;
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const placeholders = meta.placeholders.join(', ');

  const system = `You write WhatsApp message templates for a car wash business (${businessName || 'the shop'}).
Rules:
- Output ONLY the message text, no quotes or labels
- MUST include these placeholders exactly as written: ${placeholders}
- Keep messages concise (2-6 lines), friendly, professional
- Use 0-2 emojis max
- Plain text suitable for WhatsApp click-to-send
- Do not invent new placeholder names`;

  const userParts = [
    `Template type: ${meta.label}`,
    `Purpose: ${meta.purpose}`,
    `Required placeholders: ${placeholders}`
  ];
  if (currentTemplate?.trim()) {
    userParts.push(`Current template (improve or rewrite):\n${currentTemplate.trim()}`);
  }
  if (userPrompt?.trim()) {
    userParts.push(`Owner instructions: ${userPrompt.trim()}`);
  } else {
    userParts.push('Write a clear, warm default template for this status.');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.65,
      max_tokens: 400,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userParts.join('\n\n') }
      ]
    })
  });

  if (!response.ok) {
    const err = new Error(`AI service error (${response.status}). Please try again later.`);
    err.status = response.status >= 502 ? 502 : 400;
    throw err;
  }

  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) {
    const err = new Error('AI returned an empty template.');
    err.status = 502;
    throw err;
  }

  return text;
}

export { TEMPLATE_META };
