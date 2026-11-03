const test = require("node:test");
const assert = require("node:assert/strict");
const {
  API_URL,
  MIN_REFRESH_INTERVAL_MS,
  normalizeStateVector,
  normalizeStatesResponse,
  fetchOpenSky
} = require("../electron/providers/opensky.cjs");

const state = (overrides = {}) => {
  const row = Array(18).fill(null);
  row[0] = "ABC123";
  row[1] = "TEST123 ";
  row[2] = "United States";
  row[3] = 1700000000;
  row[4] = 1700000001;
  row[5] = -122.3;
  row[6] = 47.6;
  row[7] = 10000;
  row[8] = false;
  row[9] = 250;
  row[10] = 270;
  row[11] = 2;
  for (const [key, value] of Object.entries(overrides)) row[Number(key)] = value;
  return row;
};

test("OpenSky positions preserve reported data and reject invalid coordinates", () => {
  const normalized = normalizeStateVector(state(), 1700000002000);
  assert.equal(normalized.icao24, "abc123");
  assert.equal(normalized.callsign, "TEST123");
  assert.equal(normalized.longitude, -122.3);
  assert.equal(normalized.latitude, 47.6);
  assert.equal(normalized.barometricAltitudeM, 10000);
  assert.equal(normalized.velocityMps, 250);
  assert.equal(normalized.heading, 270);
  assert.equal(normalized.lastPositionUpdate, 1700000000);
  assert.equal(normalized.receivedAt, 1700000002000);
  assert.equal(normalizeStateVector(state({ 5: null }), 1), null);
  assert.equal(normalizeStateVector(state({ 6: 91 }), 1), null);
  assert.equal(normalizeStateVector(state({ 0: "not-an-address" }), 1), null);
  assert.equal(normalizeStateVector(state({ 10: null }), 1).heading, null);
});

test("OpenSky response contains only unique state vectors with valid positions", () => {
  const payload = {
    time: 1700000000,
    states: [state(), state({ 1: "DUPLICATE" }), state({ 0: "DEF456", 5: null })]
  };
  const result = normalizeStatesResponse(payload, 1700000001000);
  assert.equal(result.stateVectors, 3);
  assert.equal(result.aircraft.length, 1);
  assert.equal(result.aircraft[0].callsign, "DUPLICATE");
  assert.throws(() => normalizeStatesResponse({ states: [] }), /unexpected states response/);
});

test("OpenSky fetch uses the official anonymous endpoint and decodes actual responses", async () => {
  let requestedUrl;
  const result = await fetchOpenSky(async (url, options) => {
    requestedUrl = url;
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ time: 1700000000, states: [state()] }, {
      headers: { "X-Rate-Limit-Remaining": "396" }
    });
  }, 1700000001000);
  assert.equal(requestedUrl, API_URL);
  assert.equal(result.aircraft.length, 1);
  assert.equal(result.receivedAt, 1700000001000);
  assert.equal(result.creditsRemaining, 396);
  assert.equal(MIN_REFRESH_INTERVAL_MS, 20 * 60 * 1000);
});

test("OpenSky rate limit honors provider retry headers and access errors are explicit", async () => {
  await assert.rejects(
    fetchOpenSky(async () => new Response("", {
      status: 429,
      headers: { "X-Rate-Limit-Retry-After-Seconds": "7200" }
    })),
    (error) => error.status === 429 && error.retryAfterSeconds === 7200
  );
  await assert.rejects(
    fetchOpenSky(async () => new Response("", { status: 403 })),
    (error) => error.status === 403 && /rejected anonymous access/.test(error.message)
  );
});
