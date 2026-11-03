const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/app.js"), "utf8");
test("switching Flights to Cameras stops polling and removes competing map layers", () => {
  const nodes = new Map(), visibility = new Map();
  let refreshes = 0, closed = 0, stopped = 0;
  const context = vm.createContext({
    workspaceMode: "explore", flightRadarEnabled: false, flightUpdateGeneration: 0,
    activeCamera: {}, mapLoaded: true, flightFreshnessTimer: null, flightRefreshTimer: null,
    document: { body: { dataset: { focus: "true" } }, hidden: false },
    $: id => { if (!nodes.has(id)) nodes.set(id, { hidden: false, attrs: {}, classList: { remove: () => {} }, setAttribute(name, value) { this.attrs[name] = value; } }); return nodes.get(id); },
    map: { getLayer: () => true, setLayoutProperty: (layer, _property, value) => visibility.set(layer, value), resize() {} },
    requestAnimationFrame: fn => fn(), setInterval: () => 1, clearInterval() {}, clearTimeout() {},
    refreshFlightPositions: () => refreshes++, renderFlightState() {}, syncAircraftMarkers() {},
    closeAircraftInfo: () => closed++, stopCamera: () => { stopped++; context.activeCamera = null; }
  });
  vm.runInContext(source.slice(source.indexOf("function setWorkspace("), source.indexOf("let flightRefreshTimer")), context);
  vm.runInContext(source.slice(source.indexOf("function setFlightRadarEnabled("), source.indexOf("function stopCamera(")), context);
  vm.runInContext("setFlightRadarEnabled(true)", context);
  assert.equal(context.document.body.dataset.workspace, "flights");
  assert.equal(context.document.body.dataset.focus, "false");
  assert.equal(visibility.get("camera-points"), "none");
  assert.equal(visibility.get("aircraft-icons"), "visible");
  assert.equal(stopped, 1);
  assert.equal(refreshes, 1);
  vm.runInContext("setWorkspace('cameras')", context);
  assert.equal(context.flightRadarEnabled, false);
  assert.equal(context.workspaceMode, "cameras");
  assert.equal(visibility.get("aircraft-icons"), "none");
  assert.equal(visibility.get("camera-points"), "visible");
  assert.equal(closed, 1);
  vm.runInContext("setWorkspace('invalid')", context);
  assert.equal(context.workspaceMode, "cameras");
});
