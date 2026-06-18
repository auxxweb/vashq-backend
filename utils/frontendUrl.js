/**
 * FRONTEND_URL may be comma-separated (CORS allowlist). Customer-facing links need one origin.
 */

export function parseFrontendOrigins() {
  const raw = (process.env.FRONTEND_URL || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function isLocalOrigin(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

function originFromReferer(referer) {
  const trimmed = (referer || '').trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return '';
  }
}

function normalizeOrigin(url) {
  const raw = (url || '').trim();
  if (!raw) return '';
  if (raw.includes(',')) {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return (parts.find((p) => !isLocalOrigin(p)) || parts[0] || '').replace(/\/$/, '');
  }
  return raw.replace(/\/$/, '');
}

/**
 * Single frontend origin for public links (invoice PDF share, etc.).
 * @param {{ customerFacing?: boolean }} options - When true, never use localhost if a public URL is configured.
 */
export function resolveFrontendBaseUrl(req, options = {}) {
  const { customerFacing = false } = options;
  const explicitPublic = normalizeOrigin(process.env.PUBLIC_FRONTEND_URL || '');
  if (customerFacing && explicitPublic) {
    return explicitPublic;
  }

  const allowed = parseFrontendOrigins();
  const originHeader = (req?.get?.('origin') || '').trim();
  const refererBase = originFromReferer(req?.get?.('referer') || '');

  for (const candidate of [originHeader, refererBase]) {
    if (!candidate) continue;
    if (customerFacing && isLocalOrigin(candidate)) continue;
    if (allowed.length === 0 || allowed.includes(candidate)) {
      return normalizeOrigin(candidate);
    }
  }

  if (allowed.length > 0) {
    const publicUrl = allowed.find((u) => !isLocalOrigin(u));
    if (publicUrl) return normalizeOrigin(publicUrl);
    if (!customerFacing) return normalizeOrigin(allowed[0]);
  }

  const requestBase = req ? `${req.protocol}://${req.get('host')}` : '';
  const fallback = originHeader || refererBase || requestBase || 'http://localhost:3000';
  return normalizeOrigin(fallback);
}

/** WhatsApp invoice link: use admin app origin (localhost in dev, production when live). */
export function resolveInvoiceShareBaseUrl(req) {
  const explicit = normalizeOrigin(process.env.PUBLIC_FRONTEND_URL || '');
  if (explicit) return explicit;

  const allowed = parseFrontendOrigins();
  const originHeader = (req?.get?.('origin') || '').trim();
  const refererBase = originFromReferer(req?.get?.('referer') || '');

  for (const candidate of [originHeader, refererBase]) {
    if (!candidate) continue;
    if (allowed.length === 0 || allowed.includes(candidate)) {
      return normalizeOrigin(candidate);
    }
  }

  if (allowed.length > 0) {
    const publicUrl = allowed.find((u) => !isLocalOrigin(u));
    if (publicUrl) return normalizeOrigin(publicUrl);
    return normalizeOrigin(allowed[0]);
  }

  return normalizeOrigin(originHeader || refererBase || 'http://localhost:3000');
}
