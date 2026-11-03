const CATALOG_URL = "https://api.tfl.gov.uk/Place/Type/JamCam";
const SOURCE_URL = "https://tfl.gov.uk/traffic/status/";

function mediaUrl(value, extension) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const bucketHost = url.hostname === "s3-eu-west-1.amazonaws.com" && url.pathname.startsWith("/jamcams.tfl.gov.uk/");
    const directHost = ["jamcams.tfl.gov.uk", "jamcams.tfl.gov.uk.s3.amazonaws.com", "jamcams.tfl.gov.uk.s3.eu-west-1.amazonaws.com"].includes(url.hostname);
    return (bucketHost || directHost) && url.pathname.endsWith(extension) ? url.href : null;
  } catch { return null; }
}

function normalizeCamera(place) {
  if (place?.placeType !== "JamCam" || !/^JamCams_[\d.]+$/.test(place.id || "")) return null;
  if (typeof place.lat !== "number" || typeof place.lon !== "number" ||
      !Number.isFinite(place.lat) || Math.abs(place.lat) > 90 ||
      !Number.isFinite(place.lon) || Math.abs(place.lon) > 180) return null;
  const properties = Object.fromEntries((Array.isArray(place.additionalProperties) ? place.additionalProperties : [])
    .filter(p => p && typeof p.key === "string").map(p => [p.key, p.value]));
  if (properties.available !== "true") return null;
  const snapshotUrl = mediaUrl(properties.imageUrl, ".jpg");
  const streamUrl = mediaUrl(properties.videoUrl, ".mp4");
  if (!snapshotUrl && !streamUrl) return null;
  return {
    cameraKey: `tfl:${place.id}`, source: "tfl", sourceId: place.id,
    name: String(place.commonName || place.id).slice(0, 180),
    country: "United Kingdom", countryCode: "GB", city: "London",
    latitude: place.lat, longitude: place.lon, type: "traffic",
    mediaType: streamUrl ? "video" : "snapshot", streamUrl, snapshotUrl,
    detailUrl: SOURCE_URL, sourceStatus: "active"
  };
}

async function getTflCameras(fetchImpl = fetch) {
  const response = await fetchImpl(CATALOG_URL, {
    headers: { Accept: "application/json", "User-Agent": "EarthLive/0.1.0" },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 429) throw new Error("TfL is rate limiting requests. Try again later.");
  if (!response.ok) throw new Error(`TfL camera directory returned HTTP ${response.status}.`);
  const places = await response.json();
  if (!Array.isArray(places)) throw new Error("TfL returned an unexpected camera directory.");
  const cameras = [...new Map(places.map(normalizeCamera).filter(Boolean).map(c => [c.cameraKey, c])).values()];
  return { total: places.length, cameras };
}

module.exports = { CATALOG_URL, getTflCameras, normalizeCamera };
