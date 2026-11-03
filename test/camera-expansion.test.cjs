const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeFinland, normalizeSingapore, createPublicCameraClient } = require("../electron/providers/public-cameras.cjs");
const { CameraStore } = require("../electron/camera-store.cjs");
const { compareVersions, checkForUpdates } = require("../electron/updates.cjs");
const sg = (image = "one", timestamp = "2026-11-03T09:00:00Z") => ({ api_info: { status: "healthy" }, items: [{ cameras: [{ camera_id: "2701", image: `https://images.data.gov.sg/api/traffic-images/${image}.jpg`, timestamp, location: { latitude: 1.4, longitude: 103.8 } }] }] });

test("new providers validate coordinates, collection status, media hosts and identities", () => {
  const finland = { features: [{ geometry: { type: "Point", coordinates: [24, 60] }, properties: {
    name: "road_camera", collectionStatus: "GATHERING", state: null,
    presets: [{ id: "C0150301", inCollection: true }, { id: "C0150302", inCollection: false }, { id: "../private", inCollection: true }]
  } }] };
  assert.equal(normalizeFinland(finland).length, 1);
  finland.features[0].properties.collectionStatus = "REMOVED";
  assert.equal(normalizeFinland(finland).length, 0);
  finland.features[0].properties.collectionStatus = "GATHERING";
  finland.features[0].geometry.coordinates = [200, 60];
  assert.equal(normalizeFinland(finland).length, 0);
  const bad = sg(); bad.items[0].cameras[0].image = "https://evil.example/cam.jpg";
  assert.equal(normalizeSingapore(bad).length, 0);
  assert.throws(() => normalizeSingapore({ items: [] }), /unexpected/);
  const store = new CameraStore(":memory:");
  try {
    store.importCameras(normalizeSingapore(sg()));
    const key = "singapore:2701";
    store.setFavorite(key, true);
    store.importCameras(normalizeSingapore(sg("two")));
    assert.equal(store.getStats().indexed, 1);
    assert.equal(store.getCamera(key).snapshot_url.includes("two.jpg"), true);
    assert.deepEqual(store.getFavorites(), [key]);
    assert.throws(() => store.setFavorite(key, "true"), /true or false/);
    assert.throws(() => store.setFavorite("missing", true), /not found/);
    store.deleteCamera(key);
    assert.deepEqual(store.getFavorites(), []);
  } finally { store.close(); }
});

test("public camera requests coalesce, cache and honor provider cooldown", async () => {
  let now = 0, requests = 0;
  const get = createPublicCameraClient(async () => { requests++; return Response.json(sg()); }, () => now);
  await Promise.all([get("singapore"), get("singapore")]);
  await get("singapore");
  assert.equal(requests, 1);
  now = 60001;
  await get("singapore");
  assert.equal(requests, 2);
  await assert.rejects(get("__proto__"), /Unknown/);
  const limited = createPublicCameraClient(async () => new Response("", { status: 429, headers: { "retry-after": "120" } }), () => now);
  await assert.rejects(limited("singapore"), /rate limit/);
  now += 60001;
  await assert.rejects(limited("singapore"), /cooling down/);
});

test("camera search matches all terms; freshness never claims unknown captures are live", async () => {
  const { matchesCameraSearch, describeCameraMedia } = await import("../src/camera-utils.mjs");
  const camera = { name: "Harbor", country: "Finland", city: "Helsinki", source: "finland" };
  assert.equal(matchesCameraSearch(camera, "  HELSINKI harbor "), true);
  assert.equal(matchesCameraSearch(camera, "harbor London"), false);
  assert.match(describeCameraMedia(camera, "snapshot", null), /capture time unknown/);
  const now = Date.parse("2026-11-03T09:00:00Z");
  assert.match(describeCameraMedia(camera, "snapshot", "2026-11-03T07:00:00Z", now), /older image/);
  assert.match(describeCameraMedia(camera, "snapshot", "2026-11-04T07:00:00Z", now), /unknown/);
  assert.match(describeCameraMedia({ source: "tfl" }, "video", "2026-11-03T08:50:00Z", now, "Provider file modification time"), /Short traffic clip.*source file updated/);
});

test("update checks compare numeric versions and reject unrelated downloads", async () => {
  assert.equal(compareVersions("v0.10.0", "0.2.0"), 1);
  assert.throws(() => compareVersions("bad", "0.2.0"), /Unrecognized/);
  assert.equal((await checkForUpdates("0.2.0", async () => new Response("", { status: 404 }))).available, false);
  const release = { tag_name: "v0.3.0", html_url: "https://github.com/Pretendworking/EarthLive/releases/tag/v0.3.0" };
  assert.equal((await checkForUpdates("0.2.0", async () => Response.json(release))).available, true);
  await assert.rejects(checkForUpdates("0.2.0", async () => Response.json({ ...release, html_url: "https://evil.example/update.exe" })), /Unrecognized/);
});
