/** Simple in-memory TTL cache for hot middleware / lookup paths. */
const store = new Map();

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
}

export function cacheDelete(key) {
  store.delete(key);
}

export async function cacheGetOrSet(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit != null) return hit;
  const value = await fn();
  if (value != null) cacheSet(key, value, ttlMs);
  return value;
}
