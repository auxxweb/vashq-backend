import AuditLog from '../models/AuditLog.model.js';

const PRIVATE_IP_RE = /^(::1|::ffff:127\.|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|localhost)$/i;

export function getClientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  if (Array.isArray(fwd) && fwd[0]) {
    return String(fwd[0]).split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

export function summarizeUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const s = ua.slice(0, 400);
  let os = 'Unknown OS';
  if (/Windows NT/i.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  let browser = 'Unknown browser';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/Chrome\//i.test(s) && !/Edg\//i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) browser = 'Safari';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/OPR\//i.test(s) || /Opera/i.test(s)) browser = 'Opera';

  return `${browser} on ${os}`;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const normalized = String(ip).replace(/^::ffff:/i, '');
  return PRIVATE_IP_RE.test(normalized) || normalized === '0.0.0.0';
}

/** Best-effort geo lookup; never throws. */
export async function lookupGeo(ip) {
  if (!ip || isPrivateIp(ip)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.error) return null;
    const country = data.country_name || data.country || null;
    const region = data.region || data.region_code || null;
    const city = data.city || null;
    if (!country && !region && !city) return null;
    return { country, region, city };
  } catch {
    return null;
  }
}

/**
 * Persist a security audit event. Fire-and-forget safe — never throws to callers.
 * @param {object} payload
 */
export async function writeAuditLog(payload = {}) {
  try {
    const ip = payload.ip || null;
    let geo = payload.geo;
    if (geo === undefined && ip) {
      geo = await lookupGeo(ip);
    }
    const doc = {
      actorId: payload.actorId || null,
      actorEmail: payload.actorEmail || null,
      actorRole: payload.actorRole || null,
      businessId: payload.businessId || null,
      action: payload.action,
      severity: payload.severity || 'MEDIUM',
      channel: payload.channel || 'APP',
      method: payload.method || null,
      path: payload.path || null,
      targetType: payload.targetType || null,
      targetId: payload.targetId != null ? String(payload.targetId) : null,
      targetLabel: payload.targetLabel || null,
      success: payload.success !== false,
      statusCode: payload.statusCode ?? null,
      ip,
      userAgent: payload.userAgent || null,
      deviceSummary: payload.deviceSummary || summarizeUserAgent(payload.userAgent) || null,
      meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {}
    };
    if (geo) doc.geo = geo;
    await AuditLog.create(doc);
  } catch (err) {
    console.error('AuditLog write failed:', err?.message || err);
  }
}

export function clientMetaFromRequest(req) {
  const ip = getClientIp(req);
  const userAgent = req.get?.('user-agent') || req.headers?.['user-agent'] || null;
  return {
    ip,
    userAgent,
    deviceSummary: summarizeUserAgent(userAgent)
  };
}
