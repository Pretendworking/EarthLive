const test = require("node:test");
const assert = require("node:assert/strict");
const { regionFromCenter, normalizeResponse, fetchAdsbLol } = require("../electron/providers/adsb-lol.cjs");
const sample = { hex: "abc123", flight: "TEST1 ", lat: 51.5, lon: -0.1, seen_pos: 2, seen: 1, gs: 100, alt_baro: 10000, track: -10, r: "G-TEST", t: "A320" };
test("adsb.lol keeps reported coordinates and times and converts aviation units", () => {
  const result = normalizeResponse({ now: 1700000000000, ac: [sample, { ...sample, hex: "bad" }, { ...sample, hex: "def456", lat: null }] }, regionFromCenter({ latitude: 51.5, longitude: -0.1 }));
  assert.equal(result.aircraft.length, 1);
  const a = result.aircraft[0];
  assert.equal(a.lastPositionUpdate, 1699999998);
  assert.equal(a.barometricAltitudeM, 3048);
  assert.ok(Math.abs(a.velocityMps - 51.4444) < 0.001);
  assert.equal(a.heading, 350);
  assert.equal(a.callsign, "TEST1");
  assert.equal(a.registration, "G-TEST");
  assert.equal(a.originCountry, null);
  const ground = normalizeResponse({ now: 1700000000000, ac: [{ ...sample, alt_baro: "ground", seen_pos: null }] }, {});
  assert.equal(ground.aircraft[0].onGround, true);
  assert.equal(ground.aircraft[0].barometricAltitudeM, null);
  assert.equal(ground.aircraft[0].lastPositionUpdate, null);
  assert.equal(normalizeResponse({ now: 1700000000000, ac: [] }, {}).aircraft.length, 0);
  assert.throws(() => regionFromCenter({ latitude: 91, longitude: 0 }), /Valid/);
  assert.throws(() => normalizeResponse({ ac: [] }, {}), /unexpected/);
});
test("adsb.lol uses the bounded public endpoint and honors retry headers", async () => {
  await fetchAdsbLol({ latitude: 51.5, longitude: -0.1 }, async (url, options) => {
    assert.equal(url, "https://api.adsb.lol/v2/lat/51.5/lon/-0.1/dist/100");
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ now: 1700000000000, ac: [sample], msg: "No error" });
  });
  await assert.rejects(fetchAdsbLol({ latitude: 0, longitude: 0 }, async () => new Response("", { status: 429, headers: { "Retry-After": "180" } })), error => error.retryAfterSeconds === 180);
  await assert.rejects(fetchAdsbLol({ latitude: 0, longitude: 0 }, async () => new Response("", { status: 503 })), /503/);
});
test("regional refresh coalesces calls, preserves old data on failure and persists cooldown", async () => {
  const vm = require("node:vm");
  const text = require("node:fs").readFileSync(require("node:path").join(__dirname, "../electron/main.cjs"), "utf8");
  let now = 1000000, calls = 0, release;
  const saved = new Map();
  const context = vm.createContext({
    Date: { now: () => now }, Math, aircraftProvider: "adsb.lol", ADSB_REFRESH_MS: 30000,
    adsbNextRequestAt: 0, adsbLastData: null, adsbError: null, adsbFailures: 0, adsbRequestRunning: false,
    regionFromCenter, fetchAdsbLol: async () => { calls++; return new Promise(resolve => { release = resolve; }); },
    getStore: () => ({ setSetting: (key, value) => saved.set(key, value) }),
    getOpenSkyFlightState: () => ({ provider: "OpenSky Network" }), refreshOpenSkyFlightData: async () => ({ provider: "OpenSky Network" })
  });
  vm.runInContext(text.slice(text.indexOf("function getFlightState()"), text.indexOf("async function rateLimitedWindyFetch")), context);
  const pending = vm.runInContext("refreshFlightData({latitude:0,longitude:0})", context);
  assert.equal((await vm.runInContext("refreshFlightData({latitude:1,longitude:1})", context)).skipped, true);
  release({ aircraft: [sample] }); await pending;
  await vm.runInContext("refreshFlightData({latitude:0,longitude:0})", context);
  assert.equal(calls, 1);
  now += 30000;
  context.fetchAdsbLol = async () => { const error = new Error("limited"); error.retryAfterSeconds = 180; throw error; };
  const state = await vm.runInContext("refreshFlightData({latitude:0,longitude:0})", context);
  assert.equal(state.error, "limited");
  assert.equal(state.data.aircraft.length, 1);
  assert.equal(saved.get("adsbNextRequestAt"), now + 180000);
});
