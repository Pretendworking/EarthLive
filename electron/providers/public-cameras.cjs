const SOURCES = {
  finland: { url: "https://tie.digitraffic.fi/api/weathercam/v1/stations", interval: 60 * 60 * 1000 },
  singapore: { url: "https://api.data.gov.sg/v1/transport/traffic-images", interval: 60000 }
};

function coordinates(latitude, longitude) {
  return typeof latitude === "number" && Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
    typeof longitude === "number" && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
}
function normalizeFinland(data) {
  if (!Array.isArray(data?.features)) throw new Error("Fintraffic returned an unexpected camera directory.");
  const cameras = [];
  for (const feature of data.features) {
    const p = feature?.properties;
    const [longitude, latitude] = feature?.geometry?.coordinates || [];
    if (feature?.geometry?.type !== "Point" || !coordinates(latitude, longitude) ||
        p?.collectionStatus !== "GATHERING" || (p.state && p.state !== "OK") || !Array.isArray(p.presets)) continue;
    for (const preset of p.presets) {
      if (preset?.inCollection !== true || !/^C\d{7}$/.test(preset.id || "")) continue;
      cameras.push({ cameraKey: `finland:${preset.id}`, source: "finland", sourceId: preset.id,
        name: `${String(p.name || feature.id).replaceAll("_", " ")} · ${preset.id}`.slice(0, 180),
        country: "Finland", countryCode: "FI", city: "", latitude, longitude, type: "traffic", mediaType: "snapshot",
        snapshotUrl: `https://weathercam.digitraffic.fi/${preset.id}.jpg`,
        detailUrl: "https://www.digitraffic.fi/en/road-traffic/", sourceStatus: "active" });
    }
  }
  return cameras;
}
function normalizeSingapore(data) {
  if (!Array.isArray(data?.items) || !Array.isArray(data.items[0]?.cameras)) {
    throw new Error("Singapore returned an unexpected camera directory.");
  }
  if (data.api_info?.status && data.api_info.status !== "healthy") throw new Error("Singapore camera service is currently unavailable.");
  return data.items[0].cameras.flatMap(c => {
    if (!/^\d+$/.test(String(c?.camera_id || "")) || !coordinates(c?.location?.latitude, c?.location?.longitude)) return [];
    let url;
    try { url = new URL(c.image); } catch { return []; }
    if (url.protocol !== "https:" || url.hostname !== "images.data.gov.sg" || url.username || url.password ||
        !url.pathname.startsWith("/api/traffic-images/")) return [];
    return [{ cameraKey: `singapore:${c.camera_id}`, source: "singapore", sourceId: String(c.camera_id),
      name: `Singapore traffic camera ${c.camera_id}`, country: "Singapore", countryCode: "SG", city: "Singapore",
      latitude: c.location.latitude, longitude: c.location.longitude, type: "traffic", mediaType: "snapshot",
      snapshotUrl: url.href, detailUrl: "https://data.gov.sg/datasets/d_6cdb6b405b25aaaacbaf7689bcc6fae0/view",
      sourceStatus: "active", sourceUpdatedAt: Number.isFinite(Date.parse(c.timestamp)) ? c.timestamp : null }];
  });
}
function createPublicCameraClient(fetchImpl = fetch, now = Date.now) {
  const cache = new Map();
  const pending = new Map();
  const retryAfter = new Map();
  return async function getPublicCameras(source) {
    const config = SOURCES[source];
    if (!Object.hasOwn(SOURCES, source)) throw new Error("Unknown camera provider.");
    if (pending.has(source)) return pending.get(source);
    if (cache.has(source) && now() - cache.get(source).at < config.interval) return cache.get(source).cameras;
    if (now() < (retryAfter.get(source) || 0)) throw new Error("Camera provider is cooling down. Try again in a minute.");
    const task = (async () => {
      retryAfter.set(source, now() + 60000);
      const response = await fetchImpl(config.url, { headers: { Accept: "application/json", "Digitraffic-User": "EarthLive/0.2.0", "User-Agent": "EarthLive/0.2.0" }, signal: AbortSignal.timeout(20000) });
      if (response.status === 429) {
        const raw = response.headers.get("retry-after");
        const delay = /^\d+$/.test(raw || "") ? Number(raw) * 1000 : Date.parse(raw) - now();
        retryAfter.set(source, now() + Math.max(60000, Number.isFinite(delay) ? delay : 60000));
        throw new Error("Camera provider rate limit reached. Please try again later.");
      }
      if (!response.ok) throw new Error(`Camera provider returned HTTP ${response.status}.`);
      const data = await response.json();
      const normalized = source === "finland" ? normalizeFinland(data) : normalizeSingapore(data);
      const cameras = [...new Map(normalized.map(c => [c.cameraKey, c])).values()];
      cache.set(source, { at: now(), cameras });
      return cameras;
    })();
    pending.set(source, task);
    try { return await task; } finally { pending.delete(source); }
  };
}
module.exports = { SOURCES, normalizeFinland, normalizeSingapore, createPublicCameraClient };
