/**
 * FRONTEND_URL may be comma-separated (CORS allowlist). Customer-facing links need one origin.
 */

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:4173',
  'http://127.0.0.1:3000',
  'https://vashq.com',
  'https://www.vashq.com',
  'https://beta.vashq.com'
];

export function parseFrontendOrigins() {
  const raw = (process.env.FRONTEND_URL || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
}

/**
 * Full CORS allowlist: FRONTEND_URL + PUBLIC_FRONTEND_URL + safe production defaults.
 * Ensures https://vashq.com works even if FRONTEND_URL was set to a single other origin.
 */
export function resolveCorsAllowlist() {
  const fromEnv = parseFrontendOrigins();
  const publicOrigin = normalizeOrigin(process.env.PUBLIC_FRONTEND_URL || '');
  const merged = [...fromEnv];
  if (publicOrigin) merged.push(publicOrigin);
  for (const o of DEFAULT_CORS_ORIGINS) {
    if (!merged.includes(o)) merged.push(o);
  }
  // Also allow www ↔ apex pair when one is listed (skip localhost / IPs)
  const withWwwPairs = [...merged];
  for (const o of merged) {
    try {
      const u = new URL(o);
      const host = u.hostname;
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '[::1]' ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      ) {
        continue;
      }
      if (host.startsWith('www.')) {
        const apex = `${u.protocol}//${host.slice(4)}`;
        if (!withWwwPairs.includes(apex)) withWwwPairs.push(apex);
      } else if (host.includes('.')) {
        const www = `${u.protocol}//www.${host}`;
        if (!withWwwPairs.includes(www)) withWwwPairs.push(www);
      }
    } catch {
      /* ignore */
    }
  }
  return [...new Set(withWwwPairs.map((s) => s.replace(/\/$/, '')).filter(Boolean))];
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
