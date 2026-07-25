/** Normalize job before/after image URL arrays from API input or DB. */
export function normalizeJobImageUrls(input) {
  if (!Array.isArray(input)) return [];
  return input
    .flat()
    .map((u) => String(u || '').trim())
    .filter((u) => u.length > 0);
}

export const DEFAULT_JOB_IMAGES_MIN = 2;
export const DEFAULT_JOB_IMAGES_MAX = 4;
/** Absolute ceiling regardless of business settings (multer / storage safety). */
export const JOB_IMAGES_HARD_MAX = 20;

/** Resolve min/max photo counts from business settings (with safe defaults). */
export function resolveJobImageLimits(settings) {
  let min = Number(settings?.jobImagesMin);
  let max = Number(settings?.jobImagesMax);
  if (!Number.isFinite(min) || min < 0) min = DEFAULT_JOB_IMAGES_MIN;
  if (!Number.isFinite(max) || max < 1) max = DEFAULT_JOB_IMAGES_MAX;
  min = Math.floor(min);
  max = Math.floor(max);
  if (max > JOB_IMAGES_HARD_MAX) max = JOB_IMAGES_HARD_MAX;
  if (min > max) min = max;
  return { min, max };
}

/**
 * Validate image URL count against limits.
 * @param {unknown} urls
 * @param {{ min: number, max: number }} limits
 * @param {{ allowEmpty?: boolean, label?: string }} [opts]
 */
export function assertJobImageCount(urls, limits, opts = {}) {
  const { allowEmpty = false, label = 'images' } = opts;
  const count = normalizeJobImageUrls(urls).length;
  if (allowEmpty && count === 0) return count;
  if (count > limits.max) {
    const err = new Error(`Maximum ${limits.max} ${label} allowed`);
    err.status = 400;
    throw err;
  }
  if (count < limits.min) {
    const err = new Error(`Please upload at least ${limits.min} ${label}`);
    err.status = 400;
    throw err;
  }
  return count;
}
