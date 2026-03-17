import { v2 as cloudinary } from 'cloudinary';

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret
  });
}

/**
 * Upload a buffer (from multer) to Cloudinary. Returns the secure URL.
 * @param {Buffer} buffer - file buffer
 * @param {string} mimetype - e.g. 'image/jpeg'
 * @param {string} folder - e.g. 'washq/jobs'
 * @returns {Promise<{ url: string, publicId: string }>}
 */
export async function uploadBuffer(buffer, mimetype = 'image/jpeg', folder = 'washq/jobs') {
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.');
  }
  const maxAttempts = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type: 'image',
            timeout: 60000
          },
          (error, res) => {
            if (error) return reject(error);
            resolve(res);
          }
        );
        stream.end(buffer);
      });

      if (!result?.secure_url) throw new Error('No URL returned from Cloudinary');
      return { url: result.secure_url, publicId: result.public_id };
    } catch (err) {
      lastErr = err;
      const name = err?.name || '';
      const msg = String(err?.message || '');
      const isTimeout = name === 'TimeoutError' || /timeout/i.test(msg);
      if (!isTimeout || attempt === maxAttempts) break;
      // small backoff then retry
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  throw lastErr || new Error('Image upload failed');
}

export { cloudinary };
