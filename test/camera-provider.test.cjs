const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { CameraStore } = require("../electron/camera-store.cjs");
const { buildWebcamsUrl, getWebcamsPage, getWebcam, normalizeWebcam } = require("../electron/providers/windy.cjs");

test("Windy requests are paginated and request the metadata used by the importer", () => {
  const url = buildWebcamsUrl({ offset: 75, limit: 75 });
  assert.equal(url.origin + url.pathname, "https://api.windy.com/webcams/api/v3/webcams");
  assert.equal(url.searchParams.get("offset"), "75");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("include"), "categories,images,location,player,urls");
});

test("Windy imports require a key and reject authentication failures without inventing records", async () => {
  await assert.rejects(getWebcamsPage("", {}, async () => assert.fail("Should not request without a key")), /API key is required/);
  await assert.rejects(
    getWebcamsPage("invalid-user-key", {}, async () => new Response("", { status: 403 })),
    /Windy rejected the API key/
  );
  await assert.rejects(
    getWebcam("configured-user-key", "../private", async () => assert.fail("Invalid IDs must be rejected")),
    /Invalid Windy webcam ID/
  );
});

test("Windy only normalizes active cameras with valid coordinates and permitted HTTPS media", () => {
  assert.equal(normalizeWebcam(null), null);
  assert.equal(normalizeWebcam({ webcamId: 7, status: "inactive", location: { latitude: 0, longitude: 0 } }), null);
  assert.equal(normalizeWebcam({
    webcamId: 7,
    status: "active",
    location: { latitude: 94, longitude: 1 },
    images: { current: { icon: "https://images-webcams.windy.com/a.jpg" } }
  }), null);
  assert.equal(normalizeWebcam({
    webcamId: 7,
    status: "active",
    location: { latitude: 0, longitude: 0 },
    player: { live: "https://camera.invalid/embed" }
  }), null);
});

test("Windy pages with no indexed cameras remain empty", async () => {
  const page = await getWebcamsPage("test-key", {}, async (url, options) => {
    assert.equal(options.headers["X-WINDY-API-KEY"], "test-key");
    assert.equal(new URL(url).searchParams.get("limit"), "50");
    return Response.json({ total: 0, webcams: [] });
  });
  assert.deepEqual(page, { total: 0, returned: 0, cameras: [] });
});

test("SQLite upgrades existing camera databases with separate playback verification", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "earthlive-camera-migration-"));
  const file = path.join(directory, "legacy.sqlite");
  const legacyDb = new DatabaseSync(file);
  legacyDb.exec(`
    CREATE TABLE cameras (
      camera_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, source TEXT NOT NULL, source_id TEXT NOT NULL,
      name TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', country_code TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '', latitude REAL NOT NULL, longitude REAL NOT NULL,
      camera_type TEXT NOT NULL, media_type TEXT NOT NULL, stream_url TEXT, snapshot_url TEXT, player_url TEXT,
      detail_url TEXT, source_status TEXT NOT NULL DEFAULT 'active', status TEXT NOT NULL DEFAULT 'unverified',
      last_seen_at INTEGER NOT NULL, last_checked_at INTEGER, playback_verified_at INTEGER, source_updated_at TEXT
    );
  `);
  legacyDb.close();

  const store = new CameraStore(file);
  try {
    const columns = store.db.prepare("PRAGMA table_info(cameras)").all().map((column) => column.name);
    assert.ok(columns.includes("playback_status"));
    assert.equal(store.getStats().indexed, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite camera counts, source status, filters, and duplicate imports are record-backed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "earthlive-camera-test-"));
  const store = new CameraStore(path.join(directory, "test.sqlite"));
  try {
    assert.equal(store.getStats().indexed, 0);
    const record = {
      cameraKey: "test:no-media",
      source: "test",
      sourceId: "no-media",
      name: "Test record",
      country: "Test Country",
      countryCode: "TC",
      city: "Test City",
      latitude: 1,
      longitude: 2,
      type: "webcam",
      mediaType: "unknown"
    };
    assert.deepEqual(store.importCameras([record]), { imported: 1, duplicates: 0 });
    assert.deepEqual(store.importCameras([record]), { imported: 0, duplicates: 1 });
    assert.equal(store.getStats().indexed, 1);
    assert.equal(store.listCameras({ country: "Test Country", city: "Test City", type: "webcam" }).length, 1);
    assert.equal(store.getStats().working, 0);
    assert.equal(store.getStats().unverified, 1);
    assert.equal(store.getStats().live_video, 0);

    const videoRecord = { ...record, cameraKey: "test:video", sourceId: "video", name: "Video record", mediaType: "video" };
    assert.deepEqual(store.importCameras([videoRecord]), { imported: 1, duplicates: 0 });
    store.updateStatus(videoRecord.cameraKey, "working");
    const reachableVideo = store.getCamera(videoRecord.cameraKey);
    assert.equal(reachableVideo.status, "working");
    assert.equal(reachableVideo.playback_status, "unverified");
    assert.equal(store.getStats().live_video, 0);
    store.updateStatus(videoRecord.cameraKey, "working", true);
    assert.equal(store.getCamera(videoRecord.cameraKey).playback_status, "verified");
    assert.equal(store.getStats().live_video, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
