/**
 * SOSService — helpers for the SOS (distress) message feature.
 *
 * SOS messages are normal mesh messages whose payload follows a tiny
 * pipe-delimited format so they can be identified, parsed, and rendered
 * specially by receivers. Reusing the existing `Message` type means SOS
 * inherits all of the multi-hop relay, dedup, persistence, and dual-transport
 * (BLE + Meshtastic LoRa) infrastructure without any protocol changes.
 *
 * Wire format (kept compact to fit in BLE-advert chunks):
 *
 *   SOS|<lat>|<lon>|<accuracy_m>|<battery_pct>
 *
 * Example:
 *   SOS|22.22888|88.44950|15|34
 *
 * - lat / lon are decimal degrees with 5 decimal places (~1.1 m precision)
 * - accuracy is the GPS horizontal accuracy in meters (rounded)
 * - battery is the sender's battery percentage 0-100 (rounded; 0 if unknown)
 *
 * Three responsibilities:
 *  1. Detect whether a message is an SOS.
 *  2. Parse it into a typed object.
 *  3. Build the geo: URL that opens the location in Organic Maps (or any
 *     other installed offline-capable map app), in the exact format
 *     Organic Maps itself emits for shared locations.
 */

/**
 * Fixed token at the start of every SOS payload.
 * Receivers branch on this prefix to render the red SOS card instead of
 * a normal chat bubble.
 */
export const SOS_PREFIX = 'SOS|';

/**
 * Parsed SOS payload structure — all numeric so distance/bearing math
 * can run without further conversions.
 */
export interface SOSData {
  lat: number; // decimal degrees, north positive
  lon: number; // decimal degrees, east positive
  accuracy: number; // GPS horizontal accuracy in meters
  battery: number; // sender's battery 0-100 (0 = unknown)
}

/**
 * Cheap prefix check — used in MessageBubble to decide which UI to render.
 * Empty / non-string payloads are guarded so callers can pass anything.
 */
export function isSOSPayload(payload: string | undefined | null): boolean {
  return typeof payload === 'string' && payload.startsWith(SOS_PREFIX);
}

/**
 * Parse an SOS payload into typed coordinates. Returns null if the payload
 * is malformed (missing fields, NaN parse). Tolerates extra fields appended
 * by future versions — only the first four after the prefix are used.
 */
export function parseSOSPayload(payload: string): SOSData | null {
  if (!isSOSPayload(payload)) return null;
  // Strip "SOS|" then split — example body: "22.22888|88.44950|15|34"
  const parts = payload.slice(SOS_PREFIX.length).split('|');
  if (parts.length < 2) return null;
  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  // Accuracy and battery are optional — fall back to 0 (rendered as "?")
  const accuracy = parts[2] ? parseInt(parts[2], 10) : 0;
  const battery = parts[3] ? parseInt(parts[3], 10) : 0;
  // Reject non-finite or out-of-range coordinates — never render bogus data
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    lat,
    lon,
    accuracy: Number.isFinite(accuracy) ? accuracy : 0,
    battery: Number.isFinite(battery) ? battery : 0,
  };
}

/**
 * Build the SOS payload string from raw coordinate components.
 * Centralised here so the encoding stays in lock-step with parseSOSPayload.
 */
export function encodeSOSPayload(
  lat: number,
  lon: number,
  accuracyMeters: number,
  batteryPercent: number,
): string {
  const latStr = lat.toFixed(5); // ~1.1 m precision
  const lonStr = lon.toFixed(5);
  const accStr = String(Math.max(0, Math.round(accuracyMeters || 0)));
  const battStr = String(Math.max(0, Math.min(100, Math.round(batteryPercent || 0))));
  return `${SOS_PREFIX}${latStr}|${lonStr}|${accStr}|${battStr}`;
}

/**
 * Build a `geo:` URL that matches the format Organic Maps emits when
 * sharing a pin (e.g. `geo:22.2288825,88.4495031?z=16.0&q=22.2288825,88.4495031`).
 *
 * Why this exact shape:
 *   - `geo:lat,lon` is the standard Android intent — every map app handles it.
 *   - `?z=16.0`        — zoom level 16 frames the pin tightly for a rescuer
 *                        glancing at the map.
 *   - `?q=lat,lon`     — appends the same point as a labelled query so
 *                        Organic Maps drops a visible pin (without `q` it
 *                        merely centers the camera).
 *
 * Organic Maps takes priority via the `om://` scheme is NOT used here on
 * purpose — using the universal `geo:` URL keeps the intent open so the
 * user's chooser appears if they have multiple map apps, and Organic Maps
 * still handles it correctly when installed.
 */
export function buildGeoUrl(lat: number, lon: number, label?: string): string {
  // Use the same numeric formatting Organic Maps does (7 decimals).
  // toFixed(7) keeps trailing zeros — that's fine, geo: parsers ignore them.
  const latStr = lat.toFixed(7);
  const lonStr = lon.toFixed(7);
  // If a label is supplied, attach it as `(name)` — Android intent spec
  // allows it inside the q= parameter and Organic Maps shows it on the pin.
  const q = label ? `${latStr},${lonStr}(${encodeURIComponent(label)})` : `${latStr},${lonStr}`;
  return `geo:${latStr},${lonStr}?z=16.0&q=${q}`;
}

/**
 * Haversine-formula great-circle distance between two points in meters.
 * Used by the rescuer's SOS card to show "1.2 km NE of you" without any
 * map tiles or internet — pure local math.
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Initial bearing from (lat1,lon1) to (lat2,lon2), returned as a 16-wind
 * compass label like "NE" / "SSW". Receivers use this to print the
 * direction of the victim relative to themselves.
 */
export function bearingLabel(lat1: number, lon1: number, lat2: number, lon2: number): string {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = (toDeg(Math.atan2(y, x)) + 360) % 360; // 0..360
  const dirs = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  // 16-wind compass — divide 360° by 16 sectors of 22.5° each
  return dirs[Math.round(θ / 22.5) % 16];
}

/**
 * Format a meters distance as a human string ("420 m", "1.2 km").
 * Kept in this module so the SOS card stays presentation-agnostic.
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '?';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 2 : 1)} km`;
}
