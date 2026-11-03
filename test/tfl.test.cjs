const test = require("node:test");
const assert = require("node:assert/strict");
const { getTflCameras, normalizeCamera } = require("../electron/providers/tfl.cjs");
const { CameraStore } = require("../electron/camera-store.cjs");

function place(id = "00001.00001", overrides = {}) {
  return { id: `JamCams_${id}`, placeType: "JamCam", commonName: "London road", lat: 51.5, lon: -0.1,
    additionalProperties: [
      { key: "available", value: "true" },
      { key: "imageUrl", value: `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${id}.jpg` },
      { key: "videoUrl", value: `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${id}.mp4` }
    ], ...overrides };
}

test("TfL excludes unavailable, malformed and untrusted camera media", () => {
  assert.equal(normalizeCamera(null), null);
  assert.equal(normalizeCamera(place(undefined, { lat: null })), null);
  assert.equal(normalizeCamera(place(undefined, { lon: Infinity })), null);
  assert.equal(normalizeCamera(place(undefined, { additionalProperties: [] })), null);
  assert.equal(normalizeCamera(place(undefined, { additionalProperties: [
    { key: "available", value: "false" }, { key: "imageUrl", value: "https://jamcams.tfl.gov.uk/a.jpg" }
  ] })), null);
  assert.equal(normalizeCamera(place(undefined, { additionalProperties: [
    { key: "available", value: "true" }, { key: "imageUrl", value: "https://evil.example/a.jpg" }
  ] })), null);
  const snapshot = normalizeCamera(place(undefined, { additionalProperties: [
    { key: "available", value: "true" }, { key: "imageUrl", value: "https://jamcams.tfl.gov.uk/a.jpg" }
  ] }));
  assert.equal(snapshot.mediaType, "snapshot");
});

test("TfL directory handles API failure and duplicate records", async () => {
  await assert.rejects(getTflCameras(async () => new Response("", { status: 429 })), /rate limiting/);
  await assert.rejects(getTflCameras(async () => new Response("", { status: 503 })), /503/);
  await assert.rejects(getTflCameras(async () => Response.json({})), /unexpected/);
  const result = await getTflCameras(async url => {
    assert.equal(url, "https://api.tfl.gov.uk/Place/Type/JamCam");
    return Response.json([place(), place(), place("00002.00002")]);
  });
  assert.equal(result.cameras.length, 2);
  const store = new CameraStore(":memory:");
  try {
    assert.equal(store.importCameras(result.cameras).imported, 2);
    assert.equal(store.importCameras(result.cameras).duplicates, 2);
    assert.equal(store.getStats().indexed, 2);
    assert.equal(store.getStats().live_video, 0);
    assert.equal(store.getCamera(result.cameras[0].cameraKey).media_type, "video");
  } finally { store.close(); }
});
