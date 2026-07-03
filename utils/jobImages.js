/** Normalize job before/after image URL arrays from API input or DB. */
export function normalizeJobImageUrls(input) {
  if (!Array.isArray(input)) return [];
  return input
    .flat()
    .map((u) => String(u || '').trim())
    .filter((u) => u.length > 0);
}
