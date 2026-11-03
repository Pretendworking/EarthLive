import * as maplibregl from "../node_modules/maplibre-gl/dist/maplibre-gl.mjs";
import Hls from "../node_modules/hls.js/dist/hls.mjs";

const STORAGE_KEY = "earthlive.cameras.v1";
const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
const IMAGERY_ATTRIBUTION = "© Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const initialCenter = [-98.5, 39.5];
maplibregl.setWorkerUrl(new URL("../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);
const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  transformStyle: (_previousStyle, nextStyle) => ({
    ...nextStyle,
    projection: { type: "vertical-perspective" }
  }),
  center: initialCenter,
  zoom: 1.25,
  pitch: 0,
  bearing: 0,
  pitchWithRotate: true,
  maxZoom: 19,
  minZoom: 1,
  attributionControl: false,
  renderWorldCopies: false
});
map.setMissingStyleImageResolver(async (id) => {
  if (id !== "circle-11") return;
  const size = 22;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(size / 2, size / 2, 7, 0, Math.PI * 2);
  context.fill();
  map.addImage(id, context.getImageData(0, 0, size, size), { pixelRatio: 2 });
});

const $ = (id) => document.getElementById(id);
const panel = $("camera-panel");
const video = $("camera-video");
const snapshot = $("camera-snapshot");
const cameraPlayer = $("camera-player");
const emptyVideo = $("video-empty");
const streamMeta = $("stream-meta");
const errorOverlay = $("video-error");
let cameras = [];
let activeCamera = null;
let selectedLocation = { longitude: initialCenter[0], latitude: initialCenter[1], name: "Earth" };
let imageryEnabled = false;
let hlsPlayer = null;
let toastTimeout = null;
let mapLoaded = false;
let cameraState = null;
let visibleCameraView = "video";
let snapshotRefreshTimer = null;
let flightRadarEnabled = false;
let flightState = null;
let flightRefreshTimer = null;
let flightFreshnessTimer = null;
let aircraftAltitudeScale = 1;
let selectedAircraftId = null;
let selectedAircraft = null;
let followAircraftEnabled = false;
const cameraFilters = { country: "", city: "", type: "", status: "", mediaType: "", playbackStatus: "" };
const AIRCRAFT_STALE_AFTER_MS = 2 * 60 * 1000;

function loadLegacyCameras() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.slice(0, 1000).filter((camera) => camera && typeof camera.name === "string");
  } catch (error) {
    console.error("Could not read saved cameras.", error);
    return [];
  }
}

function cameraKey(camera) {
  return camera.camera_key || camera.cameraKey || `local:${camera.source_id || camera.id}`;
}

function cameraType(camera) {
  return camera.camera_type || camera.type || "webcam";
}

function cameraMediaType(camera) {
  return camera.media_type || camera.mediaType || "unknown";
}

function cameraStatus(camera) {
  if (camera.status === "offline") return "offline";
  if (camera.status === "working" && camera.last_checked_at &&
      Date.now() - camera.last_checked_at < 7 * 24 * 60 * 60 * 1000) return "working";
  return "unverified";
}

function formatCoordinates(latitude, longitude, precision = 4) {
  return `${Math.abs(latitude).toFixed(precision)}° ${latitude < 0 ? "S" : "N"}, ${Math.abs(longitude).toFixed(precision)}° ${longitude < 0 ? "W" : "E"}`;
}

function distanceKm(a, b) {
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function nearestCamera(location) {
  if (!cameras.length) return null;
  return cameras
    .map((camera) => ({ camera, distance: distanceKm(location, camera) }))
    .sort((a, b) => a.distance - b.distance)[0];
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function clearVideo() {
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }
  video.pause();
  video.removeAttribute("src");
  video.load();
  snapshot.removeAttribute("src");
  snapshot.hidden = true;
  cameraPlayer.removeAttribute("src");
  cameraPlayer.hidden = true;
  video.hidden = true;
  errorOverlay.hidden = true;
  streamMeta.hidden = true;
  $("camera-source-link").hidden = true;
  $("toggle-camera-view").hidden = true;
  clearInterval(snapshotRefreshTimer);
  snapshotRefreshTimer = null;
}

function showStreamError(camera, message) {
  if (!activeCamera || activeCamera.id !== camera.id) return;
  $("video-error-message").textContent = message;
  errorOverlay.hidden = false;
}

function updateConnectivity() {
  const isOffline = !navigator.onLine || !mapLoaded;
  $("offline-state").hidden = !isOffline;
  $("map-stage").classList.toggle("is-offline", isOffline);
  if (!navigator.onLine) {
    $("offline-title").textContent = "You're offline";
    $("offline-message").textContent = "Saved cameras, camera coordinates, and location entry still work. Map tiles, satellite imagery, and place search need an internet connection.";
  } else if (!mapLoaded) {
    $("offline-title").textContent = "Map service unavailable";
    $("offline-message").textContent = "The map could not connect. Saved cameras and coordinate entry still work; map tiles, satellite imagery, and place search need an internet connection.";
  }
}

function isAircraftStale(aircraft, now = Date.now()) {
  return !aircraft.lastPositionUpdate ||
    now - aircraft.lastPositionUpdate * 1000 > AIRCRAFT_STALE_AFTER_MS;
}

function formatFlightValue(value, formatter = String) {
  return value === null || value === undefined || value === "" ? "Unavailable" : formatter(value);
}

function renderAircraftInfo() {
  if (!selectedAircraft) return;
  const aircraft = selectedAircraft;
  const stale = isAircraftStale(aircraft);
  $("flight-info-callsign").textContent = formatFlightValue(aircraft.callsign);
  $("flight-info-icao24").textContent = formatFlightValue(aircraft.icao24);
  $("flight-info-country").textContent = formatFlightValue(aircraft.originCountry);
  $("flight-info-altitude").textContent = formatFlightValue(
    aircraft.barometricAltitudeM,
    (altitude) => `${Math.round(altitude * 3.28084).toLocaleString()} ft`
  );
  $("flight-info-speed").textContent = formatFlightValue(
    aircraft.velocityMps,
    (speed) => `${(speed * 2.236936).toFixed(1)} mph · ${(speed * 1.943844).toFixed(1)} kt`
  );
  $("flight-info-heading").textContent = formatFlightValue(
    aircraft.heading,
    (heading) => `${heading.toFixed(0)}°`
  );
  $("flight-info-coordinates").textContent =
    `${aircraft.latitude.toFixed(5)}°, ${aircraft.longitude.toFixed(5)}°`;
  $("flight-info-ground").textContent = formatFlightValue(
    aircraft.onGround,
    (onGround) => onGround ? "Yes" : "No"
  );
  $("flight-info-update").textContent = formatFlightValue(
    aircraft.lastPositionUpdate,
    (timestamp) => new Date(timestamp * 1000).toLocaleString()
  );
  $("flight-info-freshness").textContent = stale ? "Stale (over 2 minutes old)" : "Fresh (under 2 minutes old)";
  $("flight-info-freshness").dataset.stale = String(stale);
  $("follow-aircraft").textContent = followAircraftEnabled ? "Stop following" : "Follow aircraft";
}

function followSelectedAircraft() {
  if (!selectedAircraft) return;
  map.easeTo({
    center: [selectedAircraft.longitude, selectedAircraft.latitude],
    zoom: Math.max(map.getZoom(), 6),
    duration: 500
  });
}

function selectAircraft(aircraft) {
  if (!aircraft) return;
  selectedAircraftId = aircraft.icao24;
  selectedAircraft = aircraft;
  followAircraftEnabled = false;
  $("flight-info-panel").hidden = false;
  renderAircraftInfo();
  syncAircraftMarkers();
}

function closeAircraftInfo() {
  selectedAircraftId = null;
  selectedAircraft = null;
  followAircraftEnabled = false;
  $("flight-info-panel").hidden = true;
  syncAircraftMarkers();
}

function syncAircraftMarkers() {
  if (!mapLoaded || !map.getSource("aircraft-positions")) return;
  const aircraft = flightRadarEnabled ? flightState?.data?.aircraft || [] : [];
  const now = Date.now();
  const latestSelectedAircraft = aircraft.find((item) => item.icao24 === selectedAircraftId);
  if (latestSelectedAircraft) {
    const positionChanged = selectedAircraft &&
      (selectedAircraft.longitude !== latestSelectedAircraft.longitude ||
        selectedAircraft.latitude !== latestSelectedAircraft.latitude);
    selectedAircraft = latestSelectedAircraft;
    renderAircraftInfo();
    if (followAircraftEnabled && positionChanged) followSelectedAircraft();
  }
  const features = aircraft.map((item) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [item.longitude, item.latitude, item.barometricAltitudeM || 0]
    },
    properties: {
      icao24: item.icao24,
      callsign: item.callsign,
      originCountry: item.originCountry,
      latitude: item.latitude,
      longitude: item.longitude,
      altitudeM: item.barometricAltitudeM,
      velocityMps: item.velocityMps,
      heading: item.heading,
      onGround: item.onGround,
      lastPositionUpdate: item.lastPositionUpdate,
      selected: item.icao24 === selectedAircraftId,
      freshness: isAircraftStale(item, now) ? "stale" : "fresh"
    }
  }));
  map.getSource("aircraft-positions").setData({ type: "FeatureCollection", features });
}

function renderFlightState() {
  const data = flightState?.data;
  $("aircraft-count").textContent = String(data?.aircraft.length || 0);
  if (!data) {
    $("flight-radar-message").textContent = flightState?.error || "Waiting for OpenSky aircraft positions.";
    syncAircraftMarkers();
    return;
  }
  const now = Date.now();
  const stale = data.aircraft.filter((item) => isAircraftStale(item, now)).length;
  const fresh = data.aircraft.length - stale;
  const updateTime = new Date(data.receivedAt).toLocaleTimeString();
  const errorSuffix = flightState.error ? ` · Error: ${flightState.error}` : "";
  const creditsSuffix = Number.isInteger(data.creditsRemaining)
    ? ` · ${data.creditsRemaining.toLocaleString()} API credits remain`
    : "";
  $("flight-radar-message").textContent =
    `${data.aircraft.length.toLocaleString()} valid positions from ${data.stateVectors.toLocaleString()} state vectors · ${fresh.toLocaleString()} fresh · ${stale.toLocaleString()} stale · Received ${updateTime}${creditsSuffix}${errorSuffix}`;
  syncAircraftMarkers();
}

function scheduleFlightRefresh() {
  clearTimeout(flightRefreshTimer);
  if (!flightRadarEnabled) return;
  const nextRequestAt = flightState?.nextRequestAt || Date.now() + 20 * 60 * 1000;
  flightRefreshTimer = setTimeout(refreshFlightPositions, Math.max(1000, nextRequestAt - Date.now()));
}

async function refreshFlightPositions() {
  if (!flightRadarEnabled) return;
  $("flight-radar-message").textContent = flightState?.data
    ? "Waiting for the next permitted OpenSky update…"
    : "Requesting live positions from OpenSky…";
  try {
    flightState = await window.earthlive.refreshFlightData();
  } catch (error) {
    flightState = { ...(flightState || {}), error: error.message || "OpenSky request failed." };
  }
  renderFlightState();
  scheduleFlightRefresh();
}

function setFlightRadarEnabled(enabled) {
  flightRadarEnabled = enabled;
  $("flight-radar-toggle").setAttribute("aria-pressed", String(enabled));
  $("flight-radar-status").hidden = !enabled;
  for (const layer of ["aircraft-clusters", "aircraft-cluster-count", "aircraft-icons"]) {
    if (mapLoaded && map.getLayer(layer)) {
      map.setLayoutProperty(layer, "visibility", enabled ? "visible" : "none");
    }
  }
  if (enabled) {
    clearInterval(flightFreshnessTimer);
    flightFreshnessTimer = setInterval(renderFlightState, 30000);
    refreshFlightPositions();
  } else {
    clearTimeout(flightRefreshTimer);
    clearInterval(flightFreshnessTimer);
    syncAircraftMarkers();
    closeAircraftInfo();
  }
}

function stopCamera(message) {
  clearVideo();
  activeCamera = null;
  emptyVideo.hidden = false;
  $("empty-title").textContent = "No camera in this area";
  $("empty-copy").textContent = message || "Satellite and map imagery is not live video. Add a public camera stream to watch this location.";
  $("panel-eyebrow").textContent = map.getZoom() >= 8 ? "CAMERA COVERAGE" : "EXPLORE THE GLOBE";
}

async function showCamera(camera) {
  activeCamera = camera;
  clearVideo();
  emptyVideo.hidden = true;
  $("panel-eyebrow").textContent = "CAMERA STREAM";
  $("stream-name").textContent = camera.name;
  streamMeta.hidden = false;
  $("camera-source-link").hidden = false;
  $("camera-verification-note").textContent = camera.playback_status === "verified" && camera.playback_verified_at
    ? `Video playback last verified ${new Date(camera.playback_verified_at).toLocaleString()}`
    : cameraStatus(camera) === "working"
      ? "Camera image reachable; video playback not verified"
      : "Playback not verified";

  let media;
  try {
    media = await window.earthlive.getCameraMedia(cameraKey(camera));
  } catch (error) {
    if (!activeCamera || cameraKey(activeCamera) !== cameraKey(camera)) return;
    showStreamError(camera, error.message || "Could not load camera media.");
    return;
  }
  if (!activeCamera || cameraKey(activeCamera) !== cameraKey(camera)) return;
  $("open-camera-source").hidden = !media.detailUrl;
  $("open-camera-source").textContent = camera.source === "windy" ? "View on Windy ↗" : "Open source ↗";
  $("open-camera-source").onclick = () => media.detailUrl && window.earthlive.openExternal(media.detailUrl);

  if (media.streamUrl || camera.stream_url) {
    const streamUrl = media.streamUrl || camera.stream_url;
    const isSnapshot = cameraMediaType(camera) === "snapshot" ||
      /\.(?:jpe?g|png|m?jpeg)(?:$|[?#])/i.test(streamUrl);
    if (isSnapshot) {
      showSnapshot(camera, streamUrl);
      visibleCameraView = "snapshot";
      if (camera.source === "local" && !/\.m?jpeg(?:$|[?#])/i.test(streamUrl)) {
        snapshotRefreshTimer = setInterval(() => {
          if (!activeCamera || cameraKey(activeCamera) !== cameraKey(camera)) return;
          showSnapshot(camera, appendCacheBust(streamUrl));
        }, 30000);
      }
    } else if (/\.m3u8(?:$|[?#])/i.test(streamUrl) && Hls.isSupported()) {
      video.hidden = false;
      hlsPlayer = new Hls({ enableWorker: true });
      hlsPlayer.loadSource(streamUrl);
      hlsPlayer.attachMedia(video);
      hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          const hint = data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? " Check that the stream is online, HTTPS is used, and its server allows cross-origin requests (CORS)."
            : " The stream may use an unsupported codec or an invalid playlist.";
          showStreamError(camera, `Stream error (${data.details}).${hint}`);
          window.earthlive.updateCameraStatus(cameraKey(camera), "offline", false).then(refreshCameraState);
        }
      });
      visibleCameraView = "video";
    } else {
      video.hidden = false;
      video.src = streamUrl;
      visibleCameraView = "video";
    }
    video.addEventListener("canplay", () => markCameraWorking(camera, true), { once: true });
    video.addEventListener("error", () => {
      if (!activeCamera || cameraKey(activeCamera) !== cameraKey(camera)) return;
      const errorCode = video.error?.code;
      const reason = errorCode === MediaError.MEDIA_ERR_NETWORK
        ? "The stream could not be reached. Check the URL, network, and whether the server allows playback from this app."
        : errorCode === MediaError.MEDIA_ERR_DECODE
          ? "The browser could not decode this stream. Try an H.264/AAC MP4 or a compatible HLS stream."
          : errorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? "This URL or video format is not supported. Use an HLS playlist, H.264/AAC MP4, or WebM stream."
            : "Playback failed. Check that the camera is online and the URL is correct.";
      showStreamError(camera, reason);
      window.earthlive.updateCameraStatus(cameraKey(camera), "offline", false).then(refreshCameraState);
    }, { once: true });
  } else if (media.playerUrl) {
    cameraPlayer.hidden = false;
    cameraPlayer.src = media.playerUrl;
    $("camera-verification-note").textContent = "Embedded player; playback cannot be verified from EarthLive";
    visibleCameraView = "player";
  } else if (media.snapshotUrl) {
    showSnapshot(camera, media.snapshotUrl);
    visibleCameraView = "snapshot";
  } else {
    showStreamError(camera, "This public camera has no current stream or image URL.");
  }

  if (media.snapshotUrl && media.playerUrl) {
    $("toggle-camera-view").hidden = false;
    $("toggle-camera-view").textContent = "Show latest image";
    $("toggle-camera-view").onclick = () => {
      if (visibleCameraView === "snapshot") {
        cameraPlayer.hidden = false;
        snapshot.hidden = true;
        visibleCameraView = "player";
        $("toggle-camera-view").textContent = "Show latest image";
      } else {
        cameraPlayer.hidden = true;
        showSnapshot(camera, media.snapshotUrl);
        visibleCameraView = "snapshot";
        $("toggle-camera-view").textContent = "Show player";
      }
    };
  }

  if (camera.source === "windy") {
    snapshotRefreshTimer = setInterval(async () => {
      if (!activeCamera || cameraKey(activeCamera) !== cameraKey(camera) || visibleCameraView !== "snapshot") return;
      try {
        const freshMedia = await window.earthlive.getCameraMedia(cameraKey(camera));
        if (freshMedia.snapshotUrl) showSnapshot(camera, freshMedia.snapshotUrl);
      } catch (error) {
        console.warn("Could not refresh the Windy webcam image.", error.message);
      }
    }, 8 * 60 * 1000);
  }
}

function appendCacheBust(url) {
  const updated = new URL(url);
  updated.searchParams.set("earthlive_refresh", String(Date.now()));
  return updated.href;
}

function showSnapshot(camera, url) {
  if (!url || !activeCamera || cameraKey(activeCamera) !== cameraKey(camera)) return;
  cameraPlayer.hidden = true;
  video.hidden = true;
  snapshot.hidden = false;
  snapshot.onload = () => markCameraWorking(camera, false);
  snapshot.onerror = () => {
    if (activeCamera && cameraKey(activeCamera) === cameraKey(camera)) {
      showStreamError(camera, "The camera image could not be loaded. The source may have expired or be unavailable.");
      window.earthlive.updateCameraStatus(cameraKey(camera), "offline", false).then(refreshCameraState);
    }
  };
  snapshot.src = url;
}

async function markCameraWorking(camera, playbackVerified) {
  if (!activeCamera || cameraKey(activeCamera) !== cameraKey(camera)) return;
  try {
    await window.earthlive.updateCameraStatus(cameraKey(camera), "working", playbackVerified);
    await refreshCameraState();
  } catch (error) {
    console.error("Could not save camera verification status.", error);
  }
}

function setLocation(location, title) {
  selectedLocation = {
    longitude: location.longitude,
    latitude: location.latitude,
    name: title || "Selected location"
  };
  $("panel-title").textContent = selectedLocation.name;
  $("panel-location").textContent = map.getZoom() >= 8 ? "Camera coverage near this location" : "Zoom in to explore camera coverage";
  $("coordinate-text").textContent = formatCoordinates(location.latitude, location.longitude);

  const result = nearestCamera(location);
  const coverageKm = map.getZoom() >= 12 ? 12 : map.getZoom() >= 9 ? 35 : map.getZoom() >= 7 ? 100 : 0;
  if (result && coverageKm > 0 && result.distance <= coverageKm) {
    if (cameraKey(activeCamera || {}) !== cameraKey(result.camera)) showCamera(result.camera);
  } else {
    stopCamera(map.getZoom() >= 7
      ? "No saved community camera is near this view. Satellite and map imagery is not live video."
      : "Satellite and map imagery is not live video. Zoom in to check for nearby cameras or add a public stream.");
  }
}

function updateLocationFromMap() {
  const center = map.getCenter();
  const title = selectedLocation.name === "Earth" || selectedLocation.name === "Selected location"
    ? "Selected location"
    : selectedLocation.name;
  setLocation({ longitude: center.lng, latitude: center.lat }, title);
  $("panel-location").textContent = map.getZoom() >= 7
    ? "Camera coverage near this location"
    : "Zoom in to explore camera coverage";
}

function syncMarkers() {
  if (!mapLoaded || !map.getSource("camera-records")) return;
  const features = getFilteredCameras().map((camera) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [camera.longitude, camera.latitude]
    },
    properties: {
      cameraKey: cameraKey(camera),
      status: cameraStatus(camera)
    }
  }));
  map.getSource("camera-records").setData({ type: "FeatureCollection", features });
}

function getFilteredCameras() {
  return cameras.filter((camera) =>
    (!cameraFilters.country || camera.country_code === cameraFilters.country || camera.country === cameraFilters.country) &&
    (!cameraFilters.city || camera.city === cameraFilters.city) &&
    (!cameraFilters.type || cameraType(camera) === cameraFilters.type) &&
    (!cameraFilters.status || cameraStatus(camera) === cameraFilters.status) &&
    (!cameraFilters.mediaType || cameraMediaType(camera) === cameraFilters.mediaType) &&
    (!cameraFilters.playbackStatus || camera.playback_status === cameraFilters.playbackStatus)
  );
}

function renderStats() {
  const stats = cameraState?.stats || {};
  $("stat-indexed").textContent = String(stats.indexed || 0);
  $("top-camera-count").textContent = String(stats.indexed || 0);
  $("stat-working").textContent = String(stats.working || 0);
  $("stat-live-video").textContent = String(stats.live_video || 0);
  $("stat-snapshots").textContent = String(stats.snapshots || 0);
  $("stat-offline").textContent = String(stats.offline || 0);
  $("stat-unverified").textContent = String(stats.unverified || 0);
  $("stat-countries").textContent = String(stats.countries || 0);
  const lastDiscovery = cameraState?.windy?.status?.last_discovery_at;
  $("stat-last-discovery").textContent = lastDiscovery
    ? new Date(lastDiscovery).toLocaleString()
    : "Not yet";
  $("camera-count").textContent = String(stats.indexed || 0);
  $("drawer-count").textContent = String(stats.indexed || 0);
}

function openCameraScope(scope) {
  const scopes = {
    all: { label: "All indexed cameras", status: "", mediaType: "", playbackStatus: "" },
    working: { label: "Recently verified working cameras", status: "working", mediaType: "", playbackStatus: "" },
    "live-video": { label: "Video playback verified in the last 7 days", status: "working", mediaType: "video", playbackStatus: "verified" },
    snapshots: { label: "Snapshot cameras", status: "", mediaType: "snapshot", playbackStatus: "" },
    offline: { label: "Unavailable cameras", status: "offline", mediaType: "", playbackStatus: "" },
    unverified: { label: "Unverified cameras", status: "unverified", mediaType: "", playbackStatus: "" },
    countries: { label: "Browse cameras by country", status: "", mediaType: "", playbackStatus: "" }
  };
  const selected = scopes[scope] || scopes.all;
  cameraFilters.country = "";
  cameraFilters.city = "";
  cameraFilters.type = "";
  cameraFilters.status = selected.status;
  cameraFilters.mediaType = selected.mediaType;
  cameraFilters.playbackStatus = selected.playbackStatus;
  $("camera-list-scope").textContent = selected.label;
  renderFilterOptions();
  syncMarkers();
  openDrawer();
  renderCameraList();
}

function renderFilterOptions() {
  const countrySelect = $("filter-country");
  const previousCountry = cameraFilters.country;
  countrySelect.replaceChildren(new Option("All countries", ""));
  for (const country of cameraState?.filters?.countries || []) {
    countrySelect.add(new Option(`${country.country}${country.code ? ` (${country.code})` : ""}`, country.code || country.country));
  }
  if ([...countrySelect.options].some((option) => option.value === previousCountry)) {
    countrySelect.value = previousCountry;
  } else {
    cameraFilters.country = "";
    countrySelect.value = "";
  }

  const countryName = countrySelect.selectedOptions[0]?.textContent.split(" (")[0];
  const cities = [...new Set(cameras
    .filter((camera) => !cameraFilters.country || camera.country === countryName || camera.country_code === cameraFilters.country)
    .map((camera) => camera.city)
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const citySelect = $("filter-city");
  const previousCity = cameraFilters.city;
  citySelect.replaceChildren(new Option("All cities", ""));
  for (const city of cities) citySelect.add(new Option(city, city));
  if (cities.includes(previousCity)) {
    citySelect.value = previousCity;
  } else {
    cameraFilters.city = "";
    citySelect.value = "";
  }
  $("filter-type").value = cameraFilters.type;
}

async function refreshCameraState() {
  try {
    cameraState = await window.earthlive.getCameraState();
    cameras = cameraState.cameras;
    renderStats();
    renderFilterOptions();
    syncMarkers();
    renderCameraList();
    updateWindySettings();
  } catch (error) {
    console.error("Could not load camera database state.", error);
    showToast("Camera database could not be opened.");
  }
}

function applyCameraFilters() {
  cameraFilters.country = $("filter-country").value;
  cameraFilters.city = $("filter-city").value;
  cameraFilters.type = $("filter-type").value;
  syncMarkers();
  renderCameraList();
}

function renderCameraList() {
  const list = $("camera-list");
  list.replaceChildren();
  const filtered = getFilteredCameras();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "camera-list-empty";
    empty.textContent = cameras.length
      ? "No cameras match these filters."
      : "No cameras are indexed yet. Configure a documented provider or add a public camera.";
    list.append(empty);
    return;
  }

  for (const camera of filtered) {
    const row = document.createElement("div");
    row.className = "camera-list-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "camera-card" + (activeCamera && cameraKey(activeCamera) === cameraKey(camera) ? " is-selected" : "");
    button.innerHTML = '<span class="camera-card-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5h3l1.5-2h5l1.5 2h3v9H3z"/><circle cx="10" cy="11" r="2.7"/></svg></span>';
    const text = document.createElement("span");
    text.className = "camera-card-text";
    const name = document.createElement("strong");
    name.textContent = camera.name;
    const coords = document.createElement("span");
    coords.textContent = [camera.city, camera.country].filter(Boolean).join(", ") ||
      formatCoordinates(camera.latitude, camera.longitude, 2);
    const status = document.createElement("span");
    status.className = "camera-status-dot";
    status.dataset.status = cameraStatus(camera);
    status.setAttribute("aria-label", `${cameraStatus(camera)} camera`);
    text.append(name, coords);
    button.append(button.firstElementChild, text, status);
    button.addEventListener("click", () => {
      selectedLocation = { longitude: camera.longitude, latitude: camera.latitude, name: camera.name };
      map.flyTo({ center: [camera.longitude, camera.latitude], zoom: Math.max(map.getZoom(), 11), duration: 1000 });
      openCamera(camera);
      closeDrawer();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-camera";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${camera.name}`);
    remove.hidden = camera.source !== "local";
    remove.addEventListener("click", () => {
      window.earthlive.deleteCamera(cameraKey(camera)).then(async () => {
        if (activeCamera && cameraKey(activeCamera) === cameraKey(camera)) stopCamera();
        await refreshCameraState();
        showToast("Camera removed.");
      }).catch((error) => showToast(error.message || "Could not remove camera."));
    });
    row.append(button, remove);
    list.append(row);
  }
}

function openCamera(camera) {
  selectedLocation = { longitude: camera.longitude, latitude: camera.latitude, name: camera.name };
  $("panel-title").textContent = camera.name;
  $("panel-location").textContent = [camera.city, camera.country].filter(Boolean).join(", ") || "Public camera";
  $("coordinate-text").textContent = formatCoordinates(camera.latitude, camera.longitude);
  $("camera-panel").classList.remove("is-hidden");
  $("reopen-panel").hidden = true;
  if (activeCamera && cameraKey(activeCamera) === cameraKey(camera)) {
    renderCameraList();
    return;
  }
  showCamera(camera);
  renderCameraList();
}

function openDialog(location = selectedLocation) {
  $("camera-name").value = "";
  $("camera-url").value = "";
  $("camera-lat").value = Number(location.latitude.toFixed(5));
  $("camera-lon").value = Number(location.longitude.toFixed(5));
  $("form-error").textContent = "";
  $("camera-dialog").showModal();
  $("camera-name").focus();
}

function openDrawer() {
  $("camera-drawer").classList.add("is-open");
  $("camera-drawer").setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  $("camera-drawer").classList.remove("is-open");
  $("camera-drawer").setAttribute("aria-hidden", "true");
}

function updateWindySettings() {
  const windy = cameraState?.windy;
  const configured = Boolean(windy?.configured);
  $("windy-key-status").textContent = configured ? "Key saved encrypted on this device" : "Not configured";
  $("windy-api-key").value = "";
  const status = windy?.status;
  if (status?.last_error) {
    $("discovery-progress").textContent = `Last source error: ${status.last_error}`;
    $("discovery-progress").dataset.error = "true";
  }
  if (cameraState?.settings) {
    $("discovery-hours").value = cameraState.settings.refreshHours;
    $("discovery-pages").value = cameraState.settings.pagesPerRun;
    $("health-hours").value = cameraState.settings.healthIntervalHours;
    $("health-batch").value = cameraState.settings.healthBatchSize;
  }
}

function openSourceDialog() {
  $("source-error").textContent = "";
  $("source-dialog").showModal();
  updateWindySettings();
}

function saveDiscoverySettings() {
  return window.earthlive.updateCameraSettings({
    refreshHours: Number($("discovery-hours").value),
    pagesPerRun: Number($("discovery-pages").value),
    healthIntervalHours: Number($("health-hours").value),
    healthBatchSize: Number($("health-batch").value)
  });
}

function setDiscoveryProgress(message, error = false) {
  $("discovery-progress").textContent = message;
  $("discovery-progress").dataset.error = error ? "true" : "false";
}

async function initializeCameraStore() {
  const legacy = loadLegacyCameras();
  if (legacy.length) {
    try {
      await window.earthlive.importLegacyCameras(legacy);
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.error("Could not migrate previously saved cameras.", error);
    }
  }
  await refreshCameraState();
}

function parseCoordinates(query) {
  const match = query.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

async function searchPlace(query) {
  const coordinates = parseCoordinates(query);
  if (coordinates) {
    selectedLocation = { longitude: coordinates.longitude, latitude: coordinates.latitude, name: "Selected coordinates" };
    map.flyTo({ center: [coordinates.longitude, coordinates.latitude], zoom: 10, duration: 1300 });
    setLocation(coordinates, "Selected coordinates");
    return;
  }
  if (!query.trim()) return;

  const submitButton = $("search-form").querySelector("button");
  submitButton.disabled = true;
  $("search-input").setAttribute("aria-busy", "true");
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("q", query.trim());
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Search service returned ${response.status}`);
    const results = await response.json();
    if (!results.length) {
      showToast("No matching place found.");
      return;
    }
    const place = results[0];
    const latitude = Number(place.lat);
    const longitude = Number(place.lon);
    selectedLocation = { longitude, latitude, name: place.name || place.display_name.split(",")[0] };
    map.flyTo({ center: [longitude, latitude], zoom: 10, duration: 1300 });
    setLocation({ latitude, longitude }, selectedLocation.name);
  } catch (error) {
    console.error("Place search failed.", error);
    showToast("Place search is unavailable. Try latitude, longitude instead.");
  } finally {
    submitButton.disabled = false;
    $("search-input").removeAttribute("aria-busy");
  }
}

function toggleImagery() {
  if (!mapLoaded || !navigator.onLine) {
    showToast("Satellite imagery needs an internet connection and a loaded map.");
    return;
  }
  const styleLayers = map.getStyle().layers || [];
  const firstSymbol = styleLayers.find((layer) => layer.type === "symbol")?.id;
  if (imageryEnabled) {
    if (map.getLayer("earthlive-imagery")) map.removeLayer("earthlive-imagery");
    if (map.getSource("earthlive-imagery")) map.removeSource("earthlive-imagery");
    for (const layer of styleLayers) {
      if (map.getLayer(layer.id) && layer.id !== "earthlive-imagery") {
        const isAircraftLayer = layer.id.startsWith("aircraft-");
        map.setLayoutProperty(layer.id, "visibility", isAircraftLayer && !flightRadarEnabled ? "none" : "visible");
      }
    }
    imageryEnabled = false;
    $("imagery-toggle").setAttribute("aria-pressed", "false");
    $("imagery-toggle").setAttribute("aria-label", "Switch to satellite imagery");
    $("imagery-attribution").hidden = true;
  } else {
    map.addSource("earthlive-imagery", {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      attribution: IMAGERY_ATTRIBUTION,
      maxzoom: 19
    });
    map.addLayer({
      id: "earthlive-imagery",
      type: "raster",
      source: "earthlive-imagery",
      paint: { "raster-fade-duration": 200 }
    }, firstSymbol);
    for (const layer of styleLayers) {
      if (layer.type !== "symbol" && !layer.id.startsWith("camera-") &&
          !layer.id.startsWith("aircraft-") && map.getLayer(layer.id)) {
        map.setLayoutProperty(layer.id, "visibility", "none");
      }
    }
    imageryEnabled = true;
    $("imagery-toggle").setAttribute("aria-pressed", "true");
    $("imagery-toggle").setAttribute("aria-label", "Switch to map view");
    $("imagery-attribution").hidden = false;
    showToast("Satellite imagery is not live video.");
  }
}

function addAircraftIcon() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.moveTo(32, 3);
  context.lineTo(37, 24);
  context.lineTo(58, 36);
  context.lineTo(58, 42);
  context.lineTo(38, 37);
  context.lineTo(40, 56);
  context.lineTo(32, 52);
  context.lineTo(24, 56);
  context.lineTo(26, 37);
  context.lineTo(6, 42);
  context.lineTo(6, 36);
  context.lineTo(27, 24);
  context.closePath();
  context.fill();
  map.addImage("flight-aircraft-icon", context.getImageData(0, 0, size, size), { pixelRatio: 2, sdf: true });
}

function addAircraftMapLayers() {
  addAircraftIcon();
  map.addSource("aircraft-positions", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    cluster: true,
    clusterMaxZoom: 6,
    clusterRadius: 38
  });
  map.addLayer({
    id: "aircraft-clusters",
    type: "circle",
    source: "aircraft-positions",
    filter: ["has", "point_count"],
    layout: { visibility: flightRadarEnabled ? "visible" : "none" },
    paint: {
      "circle-color": "#1688ad",
      "circle-radius": ["step", ["get", "point_count"], 18, 50, 23, 250, 29],
      "circle-stroke-color": "#c0efff",
      "circle-stroke-width": 1.5,
      "circle-opacity": 0.96
    }
  });
  map.addLayer({
    id: "aircraft-cluster-count",
    type: "symbol",
    source: "aircraft-positions",
    filter: ["has", "point_count"],
    layout: {
      visibility: flightRadarEnabled ? "visible" : "none",
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12
    },
    paint: { "text-color": "#ffffff" }
  });
  map.addLayer({
    id: "aircraft-icons",
    type: "symbol",
    source: "aircraft-positions",
    filter: ["!", ["has", "point_count"]],
    layout: {
      visibility: flightRadarEnabled ? "visible" : "none",
      "icon-image": "flight-aircraft-icon",
      "icon-size": [
        "*",
        ["interpolate", ["linear"], ["coalesce", ["get", "altitudeM"], 0], 0, 0.7, 12000, 1.15],
        ["*", aircraftAltitudeScale, ["case", ["get", "selected"], 1.45, 1]]
      ],
      "icon-rotate": ["coalesce", ["get", "heading"], 0],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-height-offset": ["coalesce", ["get", "altitudeM"], 0],
      "symbol-height-anchor": "absolute"
    },
    paint: {
      "icon-color": [
        "case",
        ["get", "selected"], "#ffd36a",
        ["==", ["get", "freshness"], "fresh"], "#73dcff",
        "#a9b0b4"
      ],
      "icon-opacity": ["match", ["get", "freshness"], "fresh", 1, 0.58],
      "icon-halo-color": "#09202d",
      "icon-halo-width": 1.25
    }
  });
  map.on("click", "aircraft-clusters", (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    map.getSource("aircraft-positions").getClusterExpansionZoom(feature.properties.cluster_id, (error, zoom) => {
      if (error) {
        console.error("Could not expand aircraft cluster.", error);
        return;
      }
      map.easeTo({ center: feature.geometry.coordinates, zoom });
    });
  });
  map.on("click", "aircraft-icons", (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const aircraft = flightState?.data?.aircraft.find((item) => item.icao24 === feature.properties.icao24);
    selectAircraft(aircraft);
  });
  for (const layer of ["aircraft-clusters", "aircraft-icons"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }
}

function addCameraMapLayers() {
  if (!map.getSource("camera-records")) {
    map.addSource("camera-records", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterMaxZoom: 13,
      clusterRadius: 42
    });
  }
  if (!map.getLayer("camera-clusters")) {
    map.addLayer({
      id: "camera-clusters",
      type: "circle",
      source: "camera-records",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#244d4b",
        "circle-radius": ["step", ["get", "point_count"], 21, 25, 27, 100, 34],
        "circle-stroke-color": "#a0ffe0",
        "circle-stroke-width": 2,
        "circle-opacity": 0.98
      }
    });
    map.addLayer({
      id: "camera-cluster-count",
      type: "symbol",
      source: "camera-records",
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 13
      },
      paint: { "text-color": "#edfff8" }
    });
    map.addLayer({
      id: "camera-points",
      type: "circle",
      source: "camera-records",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": ["match", ["get", "status"], "working", "#61dfb2", "offline", "#ff786f", "#e8c56d"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 6, 8, 10, 13, 12],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2.5
      }
    });
  }
  map.on("click", "camera-clusters", (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const clusterId = feature.properties.cluster_id;
    map.getSource("camera-records").getClusterExpansionZoom(clusterId, (error, zoom) => {
      if (error) {
        console.error("Could not expand camera cluster.", error);
        return;
      }
      map.easeTo({ center: feature.geometry.coordinates, zoom });
    });
  });
  map.on("click", "camera-points", (event) => {
    const camera = cameras.find((item) => cameraKey(item) === event.features?.[0]?.properties?.cameraKey);
    if (!camera) return;
    openCamera(camera);
  });
  for (const layer of ["camera-clusters", "camera-points"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }
}

map.on("load", () => {
  mapLoaded = true;
  updateConnectivity();
  addCameraMapLayers();
  addAircraftMapLayers();
  map.setSky({
    "atmosphere-blend": 0.8,
    "sky-color": "rgb(4, 9, 15)",
    "horizon-color": "rgb(33, 75, 96)",
    "fog-color": "rgb(7, 16, 25)"
  });
  syncMarkers();
  syncAircraftMarkers();
  renderCameraList();
  setLocation({ longitude: initialCenter[0], latitude: initialCenter[1] }, "Earth");
  refreshCameraState();
});

window.addEventListener("offline", updateConnectivity);
window.addEventListener("online", () => {
  if (mapLoaded) {
    $("offline-state").hidden = true;
    $("map-stage").classList.remove("is-offline");
    map.resize();
  }
  updateConnectivity();
});
setTimeout(() => {
  if (!mapLoaded) updateConnectivity();
}, 12000);

map.on("moveend", updateLocationFromMap);
map.on("click", (event) => {
  if (mapLoaded && map.queryRenderedFeatures(event.point, {
    layers: ["camera-clusters", "camera-points", "aircraft-clusters", "aircraft-icons"]
  }).length) return;
  const place = { longitude: event.lngLat.lng, latitude: event.lngLat.lat };
  selectedLocation = { ...place, name: "Selected location" };
  setLocation(place, "Selected location");
});
map.on("error", (event) => {
  if (event.error) console.warn("Map resource could not be loaded.", event.error.message);
});

$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  searchPlace($("search-input").value);
});
$("imagery-toggle").addEventListener("click", toggleImagery);
$("flight-radar-toggle").addEventListener("click", () => setFlightRadarEnabled(!flightRadarEnabled));
$("close-flight-info").addEventListener("click", closeAircraftInfo);
$("follow-aircraft").addEventListener("click", () => {
  if (!selectedAircraft) return;
  followAircraftEnabled = !followAircraftEnabled;
  renderAircraftInfo();
  if (followAircraftEnabled) followSelectedAircraft();
});
$("aircraft-altitude-scale").addEventListener("input", () => {
  aircraftAltitudeScale = Number($("aircraft-altitude-scale").value);
  localStorage.setItem("earthlive.aircraftAltitudeScale", String(aircraftAltitudeScale));
  if (mapLoaded && map.getLayer("aircraft-icons")) {
    map.setLayoutProperty("aircraft-icons", "icon-size", [
      "*",
      ["interpolate", ["linear"], ["coalesce", ["get", "altitudeM"], 0], 0, 0.7, 12000, 1.15],
      ["*", aircraftAltitudeScale, ["case", ["get", "selected"], 1.45, 1]]
    ]);
  }
});
$("retry-stream").addEventListener("click", () => {
  if (activeCamera) showCamera(activeCamera);
});
$("zoom-in").addEventListener("click", () => map.zoomIn({ duration: 300 }));
$("zoom-out").addEventListener("click", () => map.zoomOut({ duration: 300 }));
$("locate-button").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("Location is not available on this device.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      selectedLocation = { longitude: coords.longitude, latitude: coords.latitude, name: "Your location" };
      map.flyTo({ center: [coords.longitude, coords.latitude], zoom: 11, duration: 1000 });
      setLocation(coords, "Your location");
    },
    () => showToast("Location permission was denied or could not be determined."),
    { timeout: 8000, maximumAge: 60000 }
  );
});
$("add-camera-top").addEventListener("click", () => openDialog());
$("add-camera-here").addEventListener("click", () => openDialog(selectedLocation));
$("close-dialog").addEventListener("click", () => $("camera-dialog").close());
$("cancel-camera").addEventListener("click", () => $("camera-dialog").close());
$("browse-cameras").addEventListener("click", openDrawer);
$("browse-cameras-top").addEventListener("click", () => openCameraScope("all"));
$("camera-stats").addEventListener("click", (event) => {
  const button = event.target.closest("[data-camera-scope]");
  if (button) openCameraScope(button.dataset.cameraScope);
});
$("close-drawer").addEventListener("click", closeDrawer);
$("close-panel").addEventListener("click", () => {
  panel.classList.add("is-hidden");
  $("reopen-panel").hidden = false;
});
$("reopen-panel").addEventListener("click", () => {
  panel.classList.remove("is-hidden");
  $("reopen-panel").hidden = true;
});
$("camera-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("camera-name").value.trim();
  const url = $("camera-url").value.trim();
  const latitude = Number($("camera-lat").value);
  const longitude = Number($("camera-lon").value);
  const mediaType = $("camera-media-type").value;
  const cameraType = $("camera-kind").value;
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    $("form-error").textContent = "Enter a valid stream URL.";
    return;
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    $("form-error").textContent = "Stream URL must use HTTP or HTTPS.";
    return;
  }
  if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    $("form-error").textContent = "Enter a name and valid latitude and longitude.";
    return;
  }
  window.earthlive.saveUserCamera({ name, url, latitude, longitude, mediaType, type: cameraType })
    .then(async (camera) => {
      $("camera-dialog").close();
      selectedLocation = { longitude, latitude, name };
      map.flyTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 10), duration: 1000 });
      await refreshCameraState();
      openCamera(camera);
      showToast("Camera saved in the local database.");
    })
    .catch((error) => {
      $("form-error").textContent = error.message || "Could not save this camera.";
    });
});

$("filter-country").addEventListener("change", () => {
  cameraFilters.country = $("filter-country").value;
  cameraFilters.city = "";
  renderFilterOptions();
  applyCameraFilters();
});
$("filter-city").addEventListener("change", applyCameraFilters);
$("filter-type").addEventListener("change", applyCameraFilters);
$("manage-sources").addEventListener("click", openSourceDialog);
$("close-source-dialog").addEventListener("click", () => $("source-dialog").close());
$("paste-windy-key").addEventListener("click", async () => {
  $("source-error").textContent = "";
  try {
    const clipboardText = await window.earthlive.readClipboard();
    if (!clipboardText.trim()) {
      $("source-error").textContent = "Your clipboard is empty. Copy the Windy API key first.";
      return;
    }
    $("windy-api-key").value = clipboardText.trim();
    $("windy-api-key").focus();
    $("windy-api-key").select();
  } catch (error) {
    $("source-error").textContent = error.message || "Could not read the clipboard.";
  }
});
$("save-windy-key").addEventListener("click", async () => {
  $("source-error").textContent = "";
  try {
    await window.earthlive.saveWindyKey($("windy-api-key").value);
    $("windy-api-key").value = "";
    await refreshCameraState();
    showToast("Windy API key encrypted on this device.");
    setDiscoveryProgress("Key saved. Start a discovery run to import public cameras.");
  } catch (error) {
    $("source-error").textContent = error.message || "Could not save the key.";
  }
});
$("remove-windy-key").addEventListener("click", async () => {
  try {
    await window.earthlive.clearWindyKey();
    $("windy-api-key").value = "";
    await refreshCameraState();
    setDiscoveryProgress("Windy key removed. Existing imported camera records are preserved.");
  } catch (error) {
    $("source-error").textContent = error.message || "Could not remove the key.";
  }
});
$("save-source-settings").addEventListener("click", async () => {
  try {
    await saveDiscoverySettings();
    await refreshCameraState();
    setDiscoveryProgress("Discovery and health-check settings saved.");
  } catch (error) {
    $("source-error").textContent = error.message || "Could not save settings.";
  }
});
$("discover-now").addEventListener("click", async () => {
  $("source-error").textContent = "";
  $("discover-now").disabled = true;
  try {
    await saveDiscoverySettings();
    const result = await window.earthlive.discoverWindy();
    await refreshCameraState();
    setDiscoveryProgress(
      `Indexed ${result.indexed} actual records; ${result.imported} new, ${result.duplicates} duplicate updates across ${result.pages} API pages.`
    );
  } catch (error) {
    $("source-error").textContent = error.message || "Discovery could not be completed.";
    setDiscoveryProgress("Discovery failed; no cameras were added from that run.", true);
  } finally {
    $("discover-now").disabled = false;
  }
});

window.earthlive.onCameraProgress((progress) => {
  if (progress.error) {
    setDiscoveryProgress(`Discovery failed: ${progress.error}`, true);
    return;
  }
  if (progress.running) {
    if (progress.page) {
      setDiscoveryProgress(
        `Page ${progress.page}/${progress.pages} · source reports ${progress.totalAvailable} cameras · ${progress.imported} new records imported…`
      );
    } else {
      setDiscoveryProgress(progress.message);
    }
    $("discover-now").disabled = true;
    return;
  }
  $("discover-now").disabled = false;
});

initializeCameraStore();
try {
  const savedAltitudeScale = Number(localStorage.getItem("earthlive.aircraftAltitudeScale"));
  if (Number.isFinite(savedAltitudeScale) && savedAltitudeScale >= 0.5 && savedAltitudeScale <= 2) {
    aircraftAltitudeScale = savedAltitudeScale;
    $("aircraft-altitude-scale").value = String(savedAltitudeScale);
  }
} catch (error) {
  console.warn("Could not restore the aircraft altitude scale setting.", error);
}
