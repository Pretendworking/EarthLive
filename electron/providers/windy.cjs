const API_ROOT = "https://api.windy.com/webcams/api/v3";
const WINDY_HOST = /(^|\.)windy\.com$/i;

function publicUrl(value, { windyOnly = false } = {}) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (windyOnly && !WINDY_HOST.test(url.hostname))) return null;
    return url.href;
  } catch {
    return null;
  }
}

function extractPlayerUrl(player) {
  const live = player?.live;
  return publicUrl(typeof live === "string" ? live : live?.embed ?? live?.url, { windyOnly: true });
}

function extractSnapshotUrl(images) {
  const current = images?.current;
  if (!current || typeof current !== "object") return null;
  for (const key of ["preview", "icon", "thumbnail", "current"]) {
    const url = publicUrl(current[key], { windyOnly: true });
    if (url) return url;
  }
  return null;
}

function normalizeWebcam(webcam) {
  if (!webcam || webcam.status !== "active" || webcam.webcamId == null) return null;
  const location = webcam.location;
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;

  const snapshotUrl = extractSnapshotUrl(webcam.images);
  const playerUrl = extractPlayerUrl(webcam.player);
  if (!snapshotUrl && !playerUrl) return null;
  const categories = Array.isArray(webcam.categories) ? webcam.categories : [];
  const categoryText = categories.map((item) => `${item?.id || ""} ${item?.name || ""}`).join(" ");
  const type = /\b(traffic|road|transport|airport|harbou?r|port)\b/i.test(categoryText) ? "traffic" : "webcam";
  const detailUrl = publicUrl(webcam.urls?.detail, { windyOnly: true });

  return {
    cameraKey: `windy:${webcam.webcamId}`,
    source: "windy",
    sourceId: String(webcam.webcamId),
    name: String(webcam.title || `Windy webcam ${webcam.webcamId}`).slice(0, 180),
    country: String(location?.country || ""),
    countryCode: String(location?.country_code || "").toUpperCase(),
    city: String(location?.city || ""),
    latitude,
    longitude,
    type,
    mediaType: playerUrl ? "embed" : "snapshot",
    snapshotUrl,
    playerUrl,
    detailUrl,
    sourceStatus: "active",
    sourceUpdatedAt: webcam.lastUpdatedOn || null
  };
}

function buildWebcamsUrl({ offset = 0, limit = 50 } = {}) {
  const url = new URL(`${API_ROOT}/webcams`);
  url.searchParams.set("include", "categories,images,location,player,urls");
  url.searchParams.set("lang", "en");
  url.searchParams.set("limit", String(Math.max(1, Math.min(50, Math.trunc(limit)))));
  url.searchParams.set("offset", String(Math.max(0, Math.trunc(offset))));
  url.searchParams.set("sortKey", "createdOn");
  url.searchParams.set("sortDirection", "desc");
  return url;
}

async function requestJson(url, apiKey, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      "X-WINDY-API-KEY": apiKey,
      Accept: "application/json",
      "User-Agent": "EarthLive/0.1.0"
    },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Windy rejected the API key. Verify it in the Windy API key manager.");
  }
  if (response.status === 429) throw new Error("Windy API rate limit reached. Discovery will retry at the next scheduled update.");
  if (response.status === 404) throw new Error("Windy webcam was not found or is no longer active.");
  if (!response.ok) throw new Error(`Windy Webcams API returned HTTP ${response.status}.`);
  return response.json();
}

async function getWebcamsPage(apiKey, options = {}, fetchImpl = fetch) {
  if (!apiKey) throw new Error("A Windy Webcams API key is required.");
  const result = await requestJson(buildWebcamsUrl(options), apiKey, fetchImpl);
  if (!result || !Array.isArray(result.webcams) || !Number.isFinite(Number(result.total))) {
    throw new Error("Windy returned an unexpected webcam response.");
  }
  return {
    total: Number(result.total),
    returned: result.webcams.length,
    cameras: result.webcams.map(normalizeWebcam).filter(Boolean)
  };
}

async function getWebcam(apiKey, webcamId, fetchImpl = fetch) {
  if (!apiKey) throw new Error("A Windy Webcams API key is required.");
  if (!/^\d+$/.test(String(webcamId))) throw new Error("Invalid Windy webcam ID.");
  const url = new URL(`${API_ROOT}/webcams/${encodeURIComponent(webcamId)}`);
  url.searchParams.set("include", "categories,images,location,player,urls");
  url.searchParams.set("lang", "en");
  const result = await requestJson(url, apiKey, fetchImpl);
  const camera = normalizeWebcam(result.webcam || result);
  if (!camera) throw new Error("Windy webcam is no longer active or has no public media.");
  return camera;
}

module.exports = { buildWebcamsUrl, getWebcamsPage, getWebcam, normalizeWebcam };
