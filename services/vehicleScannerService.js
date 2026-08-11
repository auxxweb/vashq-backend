import OpenAI from 'openai';

const VEHICLE_TYPES = new Set([
  'Car',
  'SUV',
  'Sedan',
  'Hatchback',
  'MPV',
  'Pickup',
  'Van',
  'Truck',
  'Bus',
  'Motorcycle',
  'Scooter',
  'Auto Rickshaw',
  'Other',
  'Unknown',
  'N/A'
]);

const SCAN_SYSTEM_PROMPT = `Return JSON only for this vehicle photo:
{"numberPlate":"","plateConfidence":0,"brand":"","model":"","color":"","vehicleType":"","bodyType":"","confidence":0,"notes":""}
Rules: no inventing plates; blurry→Unreadable; partial→Partially readable; unsure→Unknown; no vehicle→all N/A + confidence 0. Prefer Indian plates like KL07AB1234 when clear. confidence/plateConfidence 0-100 ints. vehicleType: Car|SUV|Sedan|Hatchback|MPV|Pickup|Van|Truck|Bus|Motorcycle|Scooter|Auto Rickshaw|Other|Unknown.`;

function clampConfidence(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

function normalizeStr(value, fallback = 'Unknown') {
  const s = String(value ?? '').trim();
  if (!s) return fallback;
  return s.slice(0, 120);
}

function normalizePlate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'Unknown';
  const lower = raw.toLowerCase();
  if (lower === 'n/a') return 'N/A';
  if (lower === 'unreadable') return 'Unreadable';
  if (lower === 'partially readable') return 'Partially readable';
  if (lower === 'unknown') return 'Unknown';
  // Keep readable plates uppercase without separators when alphanumeric-ish
  const compact = raw.replace(/[\s\-]/g, '').toUpperCase();
  if (/^[A-Z0-9]{4,15}$/.test(compact)) return compact;
  return raw.slice(0, 32);
}

function normalizeVehicleType(value) {
  const s = normalizeStr(value, 'Unknown');
  if (VEHICLE_TYPES.has(s)) return s;
  // soft match
  const found = [...VEHICLE_TYPES].find((t) => t.toLowerCase() === s.toLowerCase());
  return found || 'Other';
}

/**
 * Normalize / validate AI JSON for the client.
 */
export function normalizeVehicleScanResult(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!data || typeof data !== 'object') {
    return {
      numberPlate: 'Unknown',
      plateConfidence: 0,
      brand: 'Unknown',
      model: 'Unknown',
      color: 'Unknown',
      vehicleType: 'Unknown',
      bodyType: 'Unknown',
      confidence: 0,
      notes: 'Could not parse vehicle details from the image.'
    };
  }

  return {
    numberPlate: normalizePlate(data.numberPlate),
    plateConfidence: clampConfidence(data.plateConfidence),
    brand: normalizeStr(data.brand),
    model: normalizeStr(data.model),
    color: normalizeStr(data.color),
    vehicleType: normalizeVehicleType(data.vehicleType),
    bodyType: normalizeStr(data.bodyType),
    confidence: clampConfidence(data.confidence),
    notes: normalizeStr(data.notes, '')
  };
}

let openaiClient = null;

function getOpenAIClient(apiKey) {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Call OpenAI Vision with a JPEG/PNG data URL (or base64 data URL).
 * Tuned for low latency (fast model, compact prompt, low image detail).
 * @param {string} dataUrl e.g. data:image/jpeg;base64,...
 */
export async function analyzeVehicleImage(dataUrl) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    const err = new Error('Vehicle scanner is not configured on the server.');
    err.status = 503;
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  // Prefer mini for speed; override with OPENAI_VISION_MODEL if needed
  const model =
    process.env.OPENAI_VISION_MODEL ||
    process.env.OPENAI_MODEL ||
    'gpt-4o-mini';
  const client = getOpenAIClient(apiKey);

  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 280,
      messages: [
        { role: 'system', content: SCAN_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Read plate + brand/model/color. JSON only.'
            },
            {
              type: 'image_url',
              // auto balances speed vs plate readability (faster than forced high)
              image_url: { url: dataUrl, detail: 'auto' }
            }
          ]
        }
      ]
    });
  } catch (providerErr) {
    const status = providerErr?.status || providerErr?.response?.status;
    const err = new Error('Unable to analyze this vehicle. Please try taking a clearer photo.');
    err.status = status === 429 ? 429 : 502;
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  const content = completion?.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error('Unable to analyze this vehicle. Please try taking a clearer photo.');
    err.status = 502;
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }

  return normalizeVehicleScanResult(content);
}
