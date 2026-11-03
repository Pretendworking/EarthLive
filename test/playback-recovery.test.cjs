const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const source = readFileSync(require("node:path").join(__dirname, "../src/app.js"), "utf8");
function harness(getCameraMedia) {
  const controls = new Map();
  const timers = [];
  const video = new EventTarget();
  video.pause = () => {};
  video.play = async () => {};
  const context = vm.createContext({
    video, AbortController, Date, console, camera: { camera_key: "local:one", name: "One", source: "local", media_type: "video" },
    document: { body: { dataset: {} } },
    MediaError: { MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 },
    activeCamera: null, mediaRequestId: 0, mediaSession: null, hlsPlayer: null, currentMedia: null,
    mediaRecoveryHandler: null, recoveryTimer: null, bufferingTimer: null, snapshotRefreshTimer: null, freshnessTimer: null,
    visibleCameraView: "video", emptyVideo: {}, streamMeta: {}, errorOverlay: {}, snapshot: {}, cameraPlayer: {},
    $: id => { if (!controls.has(id)) controls.set(id, {}); return controls.get(id); },
    cameraKey: c => c.camera_key, cameraStatus: () => "unverified", cameraMediaType: c => c.media_type,
    window: { earthlive: { getCameraMedia, updateCameraStatus: async () => {} } },
    refreshCameraState: () => {}, showToast: () => {}, showStreamError: () => {}, markCameraWorking: () => {},
    describeCameraMedia: () => "Video stream · capture time unknown",
    setCameraClock: () => {},
    showSnapshot: (_camera, url) => { context.snapshot.src = url; },
    setTimeout: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.cancelled = true; }, setInterval: () => 1,
  });
  context.clearVideo = () => {
    context.mediaRequestId++;
    context.mediaSession?.abort();
    context.mediaSession = null;
    if (context.recoveryTimer) context.recoveryTimer.cancelled = true;
    context.currentMedia = null;
  };
  vm.runInContext(source.slice(source.indexOf("async function showCamera("), source.indexOf("function renderCameraClock(")), context);
  return { context, timers, video };
}

test("failed camera requests stop after two automatic retries", async () => {
  let requests = 0;
  const { context, timers } = harness(async () => { requests++; throw new Error("offline"); });
  await vm.runInContext("showCamera(camera)", context);
  assert.equal(timers[0].delay, 2000);
  timers[0].fn();
  await new Promise(setImmediate);
  assert.equal(timers[1].delay, 5000);
  timers[1].fn();
  await new Promise(setImmediate);
  assert.equal(requests, 3);
  assert.equal(timers.length, 2);
});

test("late responses cannot overwrite a newer attempt for the same camera", async () => {
  const pending = [];
  const { context, video } = harness(() => new Promise(resolve => pending.push(resolve)));
  const first = vm.runInContext("showCamera(camera)", context);
  const second = vm.runInContext("showCamera(camera)", context);
  pending[1]({ streamUrl: "https://example.com/new.mp4" });
  await second;
  assert.equal(video.src, "https://example.com/new.mp4");
  pending[0]({ streamUrl: "https://example.com/old.mp4" });
  await first;
  assert.equal(video.src, "https://example.com/new.mp4");
});

test("video failure offers an available still and switching cancels pending recovery", async () => {
  let requests = 0;
  const { context, timers, video } = harness(async () => {
    requests++;
    return { streamUrl: "https://example.com/video.mp4", snapshotUrl: "https://example.com/image.jpg" };
  });
  await vm.runInContext("showCamera(camera)", context);
  video.dispatchEvent(new Event("error"));
  assert.equal(context.snapshot.src, "https://example.com/image.jpg");
  assert.equal(context.visibleCameraView, "snapshot");
  assert.equal(timers.length, 1);
  context.clearVideo();
  timers[0].fn();
  await new Promise(setImmediate);
  assert.equal(requests, 1);
});
