const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const source = readFileSync(require("node:path").join(__dirname, "../src/app.js"), "utf8");
function functions(from, to) {
  return source.slice(source.indexOf(`function ${from}(`), source.indexOf(`function ${to}(`));
}
class Element {
  constructor() { this.children = []; this.dataset = {}; this.events = {}; this.classList = { contains: () => true }; }
  append(...items) { for (const item of items) item.fragment ? this.children.push(...item.children) : this.children.push(item); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  addEventListener(name, handler) { this.events[name] = handler; }
  set innerHTML(value) { this.firstElementChild = new Element(); }
  querySelector() { return null; }
}

test("50,000-camera drawer renders bounded pages, with every camera reachable", () => {
  const list = new Element();
  const drawer = new Element();
  const cameras = Array.from({ length: 50000 }, (_, i) => ({ camera_key: String(i), name: `Camera ${i}`, source: "tfl" }));
  const context = vm.createContext({
    cameras, activeCamera: null, cameraFilters: {}, cameraListPage: 0, cameraListFilterKey: "", CAMERA_PAGE_SIZE: 100,
    document: { createElement: () => new Element(), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }) },
    $: id => id === "camera-list" ? list : drawer,
    getFilteredCameras: () => cameras, cameraKey: c => c.camera_key, cameraStatus: () => "unverified", formatCoordinates: () => "",
  });
  vm.runInContext(functions("renderCameraList", "openCamera"), context);
  vm.runInContext("renderCameraList()", context);
  assert.equal(list.children.length, 101);
  assert.equal(list.children[100].children[0].disabled, true);
  list.children[100].children[2].events.click();
  assert.equal(list.children[0].children[0].children[1].children[0].textContent, "Camera 100");
  context.cameraListPage = 499;
  vm.runInContext("renderCameraList()", context);
  assert.equal(list.children[100].children[2].disabled, true);
  assert.equal(list.children[99].children[0].children[1].children[0].textContent, "Camera 49999");
  context.cameraFilters.country = "GB";
  vm.runInContext("renderCameraList()", context);
  assert.equal(context.cameraListPage, 0);
  drawer.classList.contains = () => false;
  list.replaceChildren();
  vm.runInContext("renderCameraList()", context);
  assert.equal(list.children.length, 0);
});

test("nearest-camera lookup handles empty catalogs, ties and the date line", () => {
  const context = vm.createContext({ cameras: [] });
  vm.runInContext(functions("distanceKm", "showToast"), context);
  assert.equal(vm.runInContext("nearestCamera({latitude:0,longitude:179.9})", context), null);
  context.cameras = [{ latitude: 0, longitude: -179.9 }, { latitude: 0, longitude: 170 }];
  assert.equal(vm.runInContext("nearestCamera({latitude:0,longitude:179.9}).camera", context), context.cameras[0]);
  context.cameras.push({ ...context.cameras[0] });
  assert.equal(vm.runInContext("nearestCamera({latitude:0,longitude:179.9}).camera", context), context.cameras[0]);
});

test("camera switches cancel old video handlers and reject unrelated errors", () => {
  const video = new EventTarget();
  video.pause = video.removeAttribute = video.load = () => {};
  const control = new Element();
  control.removeAttribute = () => {};
  const session = new AbortController();
  let obsoleteEvents = 0;
  video.addEventListener("canplay", () => obsoleteEvents++, { signal: session.signal });
  const context = vm.createContext({
    video, snapshot: control, cameraPlayer: control, errorOverlay: control, streamMeta: control,
    mediaRequestId: 4, mediaSession: session, hlsPlayer: null, snapshotRefreshTimer: null,
    clearInterval, $: () => control, activeCamera: { camera_key: "new" }, cameraKey: c => c.camera_key,
  });
  vm.runInContext(functions("clearVideo", "updateConnectivity"), context);
  vm.runInContext("clearVideo()", context);
  video.dispatchEvent(new Event("canplay"));
  assert.equal(obsoleteEvents, 0);
  assert.equal(context.mediaRequestId, 5);
  vm.runInContext("showStreamError({camera_key:'old'}, 'stale error')", context);
  assert.equal(control.hidden, true);
  vm.runInContext("showStreamError({camera_key:'new'}, 'current error')", context);
  assert.equal(control.hidden, false);
});
