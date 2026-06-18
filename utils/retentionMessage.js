function firstName(fullName) {
  const n = String(fullName || '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0];
}

function formatShortDate(d) {
  if (!d) return null;
  try {
    return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return null;
  }
}

function daysSince(date) {
  if (!date) return null;
  const ms = Date.now() - new Date(date).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

/**
 * Build a warm, personal retention WhatsApp message from customer context (no AI).
 */
export function buildRetentionMessageTemplate(ctx) {
  const {
    customerName,
    businessName,
    lastVisitDate,
    carLabel,
    loyaltyPoints = 0,
    totalVisits = 0,
    hasActivePackage = false
  } = ctx;

  const name = firstName(customerName);
  const shop = businessName || 'our car wash';
  const lastDate = formatShortDate(lastVisitDate);
  const gap = daysSince(lastVisitDate);

  let opener;
  if (gap == null || totalVisits === 0) {
    opener = `Hi ${name}! 👋\n\nThis is Team ${shop}. We'd love to take care of your car and give it the shine it deserves.`;
  } else if (gap >= 45) {
    opener = `Hi ${name}! 👋\n\nWe've been thinking of you at ${shop} — it's been a while since your last visit${lastDate ? ` on ${lastDate}` : ''}, and we genuinely miss seeing you!`;
  } else if (gap >= 14) {
    opener = `Hi ${name}! 👋\n\nHope you're doing great! Your car deserves a fresh wash, and we'd love to welcome you back at ${shop}${lastDate ? ` (last visit: ${lastDate})` : ''}.`;
  } else {
    opener = `Hi ${name}! 👋\n\nThank you for trusting ${shop}${totalVisits > 1 ? ` — you've visited us ${totalVisits} times` : ''}! We'd love to see you again soon.`;
  }

  const lines = [opener, ''];

  if (carLabel) {
    lines.push(`🚗 Your ${carLabel} always gets VIP treatment here.`);
    lines.push('');
  }

  if (loyaltyPoints > 0) {
    lines.push(`🎁 Good news — you have ${loyaltyPoints} loyalty point${loyaltyPoints === 1 ? '' : 's'} ready to use on your next visit!`);
    lines.push('');
  }

  if (hasActivePackage) {
    lines.push('📦 You still have an active package with us — book your next visit whenever it suits you.');
    lines.push('');
  }

  lines.push(
    '✨ Reply to this message or visit us anytime. We\'ll keep your car looking its absolute best.',
    '',
    `Warm regards,`,
    `Team ${shop}`
  );

  return lines.join('\n');
}

export async function generateRetentionMessageWithAi(ctx) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const system = `You write short, warm WhatsApp retention messages for a car wash business.
Rules:
- 4-8 lines max, plain text, friendly and personal (use customer's first name)
- Use 1-2 emojis total, not excessive
- Mention their visit history or car only if provided in context
- Include loyalty points or active package if provided
- End with team sign-off using business name
- Do NOT invent offers, discounts, or dates not in context
- Output ONLY the message text, no quotes or labels`;

  const user = JSON.stringify(ctx, null, 2);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 280,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!response.ok) return null;
  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content?.trim();
  return text || null;
}

export async function generateRetentionMessage(ctx) {
  const ai = await generateRetentionMessageWithAi(ctx).catch(() => null);
  if (ai) return ai;
  return buildRetentionMessageTemplate(ctx);
}
