/**
 * Haversine distance between two WGS84 points, in meters.
 */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const R = 6371000;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(Number(lat2) - Number(lat1));
  const Δλ = toRad(Number(lon2) - Number(lon1));
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function isValidLatitude(lat) {
  const n = Number(lat);
  return Number.isFinite(n) && n >= -90 && n <= 90;
}

export function isValidLongitude(lng) {
  const n = Number(lng);
  return Number.isFinite(n) && n >= -180 && n <= 180;
}

export function isValidPerimeterMeters(m) {
  const n = Number(m);
  return Number.isFinite(n) && n > 0 && n <= 100000;
}

/**
 * Normalize perimeter input to meters.
 * @param {number|string} value
 * @param {'m'|'km'|string} unit
 */
export function perimeterToMeters(value, unit = 'm') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || 'm').toLowerCase();
  if (u === 'km' || u === 'kilometer' || u === 'kilometers') {
    return Math.round(n * 1000 * 100) / 100;
  }
  return Math.round(n * 100) / 100;
}

/**
 * Build public geo-fence payload for the employee punch UI / today API.
 */
export function buildAttendanceGeoFencePublic(settings) {
  if (!settings?.attendanceEnabled || !settings?.attendanceGeoFenceEnabled) {
    return { enabled: false };
  }
  const latitude = Number(settings.attendanceLatitude);
  const longitude = Number(settings.attendanceLongitude);
  const perimeterMeters = Number(settings.attendancePerimeterMeters);
  const configured =
    isValidLatitude(latitude) &&
    isValidLongitude(longitude) &&
    isValidPerimeterMeters(perimeterMeters);
  return {
    enabled: true,
    configured,
    latitude: configured ? latitude : null,
    longitude: configured ? longitude : null,
    perimeterMeters: configured ? perimeterMeters : null
  };
}

/**
 * Assert employee coords are inside the business fence.
 * Throws Error with .status and .code when blocked.
 */
export function assertInsideAttendanceGeoFence(settings, { latitude, longitude } = {}) {
  const fence = buildAttendanceGeoFencePublic(settings);
  if (!fence.enabled) return { enforced: false };

  if (!fence.configured) {
    const err = new Error(
      'Location-based attendance is enabled but shop coordinates are not configured. Ask your admin to set them in Settings.'
    );
    err.status = 403;
    err.code = 'GEO_FENCE_NOT_CONFIGURED';
    throw err;
  }

  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    const err = new Error(
      'Your device location is required to punch in or out. Enable location access and try again.'
    );
    err.status = 400;
    err.code = 'GEO_LOCATION_REQUIRED';
    throw err;
  }

  const dist = distanceMeters(
    fence.latitude,
    fence.longitude,
    Number(latitude),
    Number(longitude)
  );
  if (dist > fence.perimeterMeters) {
    const err = new Error(
      `You are outside the allowed area (${Math.round(dist)} m away; limit is ${Math.round(fence.perimeterMeters)} m). Move closer to the shop to punch in or out.`
    );
    err.status = 403;
    err.code = 'GEO_OUTSIDE_PERIMETER';
    err.distanceMeters = Math.round(dist);
    err.perimeterMeters = fence.perimeterMeters;
    throw err;
  }

  return {
    enforced: true,
    distanceMeters: Math.round(dist * 10) / 10,
    perimeterMeters: fence.perimeterMeters
  };
}
