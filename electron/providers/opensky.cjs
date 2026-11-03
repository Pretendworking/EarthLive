const API_URL = "https://opensky-network.org/api/states/all";
const MIN_REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const DEFAULT_RETRY_AFTER_SECONDS = MIN_REFRESH_INTERVAL_MS / 1000;

function normalizeStateVector(state, receivedAt) {
  if (!Array.isArray(state)) return null;
  const icao24 = typeof state[0] === "string" ? state[0].trim().toLowerCase() : "";
  const longitude = state[5];
  const latitude = state[6];
  if (!/^[0-9a-f]{6}$/.test(icao24) ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;

  const reportedPositionTime = Number.isInteger(state[3]) && state[3] > 0 ? state[3] : null;
  return {
    icao24,
    callsign: typeof state[1] === "string" ? state[1].trim() || null : null,
    originCountry: typeof state[2] === "string" ? state[2] : null,
    lastPositionUpdate: reportedPositionTime,
    lastContact: Number.isInteger(state[4]) && state[4] > 0 ? state[4] : null,
    longitude,
    latitude,
    barometricAltitudeM: typeof state[7] === "number" && Number.isFinite(state[7]) ? state[7] : null,
    onGround: typeof state[8] === "boolean" ? state[8] : null,
    velocityMps: typeof state[9] === "number" && Number.isFinite(state[9]) ? state[9] : null,
    heading: typeof state[10] === "number" && Number.isFinite(state[10])
      ? ((state[10] % 360) + 360) % 360
      : null,
    verticalRateMps: typeof state[11] === "number" && Number.isFinite(state[11]) ? state[11] : null,
    receivedAt
  };
}

function normalizeStatesResponse(payload, receivedAt = Date.now()) {
  if (!payload || !Array.isArray(payload.states) || !Number.isInteger(payload.time)) {
    throw new Error("OpenSky returned an unexpected states response.");
  }
  const byAddress = new Map();
  for (const state of payload.states) {
    const aircraft = normalizeStateVector(state, receivedAt);
    if (aircraft) byAddress.set(aircraft.icao24, aircraft);
  }
  return {
    provider: "OpenSky Network",
    sourceTime: payload.time,
    receivedAt,
    stateVectors: payload.states.length,
    aircraft: [...byAddress.values()]
  };
}

function retryAfterSeconds(response) {
  const retryHeader = response.headers.get("X-Rate-Limit-Retry-After-Seconds") || response.headers.get("Retry-After");
  if (!retryHeader) return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = Number(retryHeader);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(retryHeader);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : DEFAULT_RETRY_AFTER_SECONDS;
}

async function fetchOpenSky(fetchImpl = fetch, now = Date.now()) {
  const response = await fetchImpl(API_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "EarthLive/0.1.0"
    },
    signal: AbortSignal.timeout(30000)
  });
  if (response.status === 429) {
    const error = new Error("OpenSky rate limit reached. EarthLive will wait for the provider's retry window.");
    error.retryAfterSeconds = retryAfterSeconds(response);
    error.status = response.status;
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error(`OpenSky rejected anonymous access (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`OpenSky returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  const result = normalizeStatesResponse(await response.json(), now);
  const creditsHeader = response.headers.get("X-Rate-Limit-Remaining");
  const creditsRemaining = creditsHeader === null ? null : Number(creditsHeader);
  return {
    ...result,
    creditsRemaining: Number.isInteger(creditsRemaining) ? creditsRemaining : null
  };
}

module.exports = {
  API_URL,
  MIN_REFRESH_INTERVAL_MS,
  normalizeStateVector,
  normalizeStatesResponse,
  retryAfterSeconds,
  fetchOpenSky
};
