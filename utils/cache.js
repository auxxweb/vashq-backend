/** Simple in-memory TTL cache for hot middleware / lookup paths. */
const store = new Map();
const MAX_ENTRIES = 5000;

function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) store.delete(key);
  }
}

function evictIfNeeded() {
  if (store.size <= MAX_ENTRIES) return;
  pruneExpired();
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest == null) break;
    store.delete(oldest);
  }
}

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function cacheSet(key, value, ttlMs = 60_000) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  evictIfNeeded();
}

export function cacheDelete(key) {
  store.delete(key);
}

export function cacheDeletePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export async function cacheGetOrSet(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit != null) return hit;
  const value = await fn();
  if (value != null) cacheSet(key, value, ttlMs);
  return value;
}

// Periodic cleanup in long-running production processes
const SWEEP_MS = 5 * 60 * 1000;
if (typeof setInterval === 'function') {
  setInterval(pruneExpired, SWEEP_MS).unref?.();
}
