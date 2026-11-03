const REFRESH_INTERVAL_MS = 30000;
const RADIUS_NM = 100;
function regionFromCenter(center) {
  const latitude = center?.latitude, longitude = center?.longitude;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error("Valid tracking center coordinates are required.");
  return { latitude: Math.round(latitude * 10000) / 10000, longitude: Math.round(longitude * 10000) / 10000, radiusNm: RADIUS_NM };
}
function normalizeAircraft(item, sourceTime, receivedAt) {
  if (!item || !/^[a-f0-9]{6}$/i.test(item.hex || "") ||
      typeof item.lat !== "number" || !Number.isFinite(item.lat) || Math.abs(item.lat) > 90 ||
      typeof item.lon !== "number" || !Number.isFinite(item.lon) || Math.abs(item.lon) > 180) return null;
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const positionAge = finite(item.seen_pos) && item.seen_pos >= 0 ? item.seen_pos : null;
  return { icao24: item.hex.toLowerCase(), callsign: typeof item.flight === "string" ? item.flight.trim() || null : null,
    registration: typeof item.r === "string" ? item.r.slice(0, 40) : null,
    model: typeof item.t === "string" ? item.t.slice(0, 40) : null, originCountry: null,
    latitude: item.lat, longitude: item.lon,
    barometricAltitudeM: finite(item.alt_baro) ? item.alt_baro * 0.3048 : null,
    onGround: item.alt_baro === "ground" ? true : finite(item.alt_baro) ? false : null,
    velocityMps: finite(item.gs) && item.gs >= 0 ? item.gs * 0.514444444 : null,
    heading: finite(item.track) ? ((item.track % 360) + 360) % 360 : null,
    verticalRateMps: finite(item.baro_rate) ? item.baro_rate * 0.00508 : finite(item.geom_rate) ? item.geom_rate * 0.00508 : null,
    lastPositionUpdate: positionAge === null ? null : Math.floor(sourceTime - positionAge),
    lastContact: finite(item.seen) && item.seen >= 0 ? Math.floor(sourceTime - item.seen) : null,
    receivedAt };
}
function normalizeResponse(payload, region, receivedAt = Date.now()) {
  if (!Array.isArray(payload?.ac) || typeof payload.now !== "number" || !Number.isFinite(payload.now) || payload.now <= 0 ||
      (payload.msg && payload.msg !== "No error")) throw new Error("adsb.lol returned an unexpected aircraft response.");
  const sourceTime = payload.now / 1000;
  const aircraft = [...new Map(payload.ac.map(item => normalizeAircraft(item, sourceTime, receivedAt)).filter(Boolean).map(item => [item.icao24, item])).values()];
  return { provider: "adsb.lol", region, sourceTime, receivedAt, stateVectors: payload.ac.length, aircraft, creditsRemaining: null };
}
async function fetchAdsbLol(center, fetchImpl = fetch, now = Date.now()) {
  const region = regionFromCenter(center);
  const url = `https://api.adsb.lol/v2/lat/${region.latitude}/lon/${region.longitude}/dist/${region.radiusNm}`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "EarthLive/0.4.0" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const error = new Error(response.status === 429 ? "adsb.lol rate limit reached. Waiting before trying again." : `adsb.lol returned HTTP ${response.status}.`);
    const raw = response.headers.get("retry-after");
    const wait = /^\d+$/.test(raw || "") ? Number(raw) : (Date.parse(raw) - now) / 1000;
    error.retryAfterSeconds = Math.max(60, Number.isFinite(wait) ? Math.ceil(wait) : 60);
    throw error;
  }
  return normalizeResponse(await response.json(), region, now);
}
module.exports = { REFRESH_INTERVAL_MS, RADIUS_NM, regionFromCenter, normalizeAircraft, normalizeResponse, fetchAdsbLol };
