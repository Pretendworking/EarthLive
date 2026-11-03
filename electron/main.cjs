const { app, BrowserWindow, clipboard, ipcMain, protocol, safeStorage, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { CameraStore, createLocalCamera } = require("./camera-store.cjs");
const { getWebcamsPage, getWebcam } = require("./providers/windy.cjs");
const { MIN_REFRESH_INTERVAL_MS, fetchOpenSky } = require("./providers/opensky.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "earthlive",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const appRoot = path.resolve(__dirname, "..");
const WINDY_KEY_FILE = "windy-api-key.enc";
const WINDY_SOURCE = "windy";
let cameraStore;
let discoveryRunning = false;
let healthCheckRunning = false;
let lastWindyRequestAt = 0;
let lastFlightData = null;
let flightError = null;
let nextFlightRequestAt = 0;
let flightRequestRunning = false;
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#071019",
    title: "EarthLive",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });

  const indexUrl = "earthlive://app/src/index.html";
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== indexUrl) {
      event.preventDefault();
      if (url.startsWith("https://")) shell.openExternal(url);
    }
  });

  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} EarthLive/0.1.0`);
  window.loadURL(indexUrl);
}

function getStore() {
  if (!cameraStore) throw new Error("EarthLive camera database is not ready.");
  return cameraStore;
}

function getWindyKeyPath() {
  return path.join(app.getPath("userData"), WINDY_KEY_FILE);
}

async function getWindyKey() {
  const keyPath = getWindyKeyPath();
  try {
    const encrypted = await fs.readFile(keyPath);
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows secure credential storage is unavailable. The saved Windy key was not read.");
    }
    return safeStorage.decryptString(encrypted);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveWindyKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows secure credential storage is unavailable. EarthLive will not save the API key as plain text.");
  }
  const normalized = String(key || "").trim();
  if (!normalized || normalized.length > 512) throw new Error("Enter a valid Windy API key.");
  const keyPath = getWindyKeyPath();
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  await fs.writeFile(keyPath, safeStorage.encryptString(normalized), { mode: 0o600 });
  return true;
}

function sendCameraProgress(progress) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("camera:progress", progress);
  }
}

function getFlightState() {
  return {
    provider: "OpenSky Network",
    refreshIntervalMs: MIN_REFRESH_INTERVAL_MS,
    nextRequestAt: nextFlightRequestAt,
    error: flightError,
    data: lastFlightData
  };
}

async function refreshFlightData() {
  if (flightRequestRunning) return { ...getFlightState(), skipped: true };
  if (Date.now() < nextFlightRequestAt) return { ...getFlightState(), skipped: true };

  flightRequestRunning = true;
  nextFlightRequestAt = Date.now() + MIN_REFRESH_INTERVAL_MS;
  flightError = null;
  try {
    getStore().setSetting("openskyNextRequestAt", nextFlightRequestAt);
    lastFlightData = await fetchOpenSky();
    getStore().setSetting("openskyLastState", lastFlightData);
    flightError = null;
  } catch (error) {
    if (error.retryAfterSeconds) {
      nextFlightRequestAt = Math.max(
        nextFlightRequestAt,
        Date.now() + error.retryAfterSeconds * 1000
      );
      getStore().setSetting("openskyNextRequestAt", nextFlightRequestAt);
    }
    flightError = error.message || "OpenSky could not be reached.";
  } finally {
    flightRequestRunning = false;
  }
  return getFlightState();
}

async function rateLimitedWindyFetch(url, options) {
  const wait = Math.max(0, 3100 - (Date.now() - lastWindyRequestAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastWindyRequestAt = Date.now();
  return fetch(url, options);
}

async function discoverWindy() {
  if (discoveryRunning) throw new Error("Windy discovery is already running.");
  const apiKey = await getWindyKey();
  if (!apiKey) throw new Error("Add a Windy Webcams API key in Camera sources before starting discovery.");

  const store = getStore();
  const source = store.getSource(WINDY_SOURCE);
  const pagesPerRun = Math.max(1, Math.min(50, source?.pages_per_run || 12));
  const aggregate = { imported: 0, duplicates: 0, pages: 0, totalAvailable: source?.total_available || 0 };
  discoveryRunning = true;
  sendCameraProgress({ running: true, source: WINDY_SOURCE, message: "Starting Windy camera discovery…" });
  try {
    let offset = source?.next_offset || 0;
    for (let pageNumber = 0; pageNumber < pagesPerRun; pageNumber += 1) {
      if (aggregate.totalAvailable > 0 && offset >= aggregate.totalAvailable) offset = 0;
      const page = await getWebcamsPage(apiKey, { offset, limit: 50 }, rateLimitedWindyFetch);
      aggregate.totalAvailable = page.total;
      const imported = store.importCameras(page.cameras);
      aggregate.imported += imported.imported;
      aggregate.duplicates += imported.duplicates;
      aggregate.pages += 1;
      const nextOffset = page.total > 0 ? (offset + page.returned) % page.total : 0;
      store.updateSource(WINDY_SOURCE, {
        next_offset: nextOffset,
        total_available: page.total,
        last_error: null
      });
      sendCameraProgress({
        running: true,
        source: WINDY_SOURCE,
        page: pageNumber + 1,
        pages: pagesPerRun,
        totalAvailable: page.total,
        imported: aggregate.imported,
        duplicates: aggregate.duplicates
      });
      offset = nextOffset;
      if (page.total === 0 || page.returned === 0 || page.returned < 50) break;
      if (pageNumber + 1 < pagesPerRun) await new Promise((resolve) => setTimeout(resolve, 3100));
    }

    store.updateSource(WINDY_SOURCE, {
      last_discovery_at: Date.now(),
      total_available: aggregate.totalAvailable,
      last_error: null
    });
    const result = { ...aggregate, indexed: store.getStats().indexed };
    sendCameraProgress({ running: false, source: WINDY_SOURCE, ...result });
    return result;
  } catch (error) {
    store.updateSource(WINDY_SOURCE, { last_error: error.message });
    sendCameraProgress({ running: false, source: WINDY_SOURCE, error: error.message });
    throw error;
  } finally {
    discoveryRunning = false;
  }
}

async function checkWindyHealth() {
  if (healthCheckRunning || discoveryRunning) return { checked: 0, skipped: true };
  const apiKey = await getWindyKey();
  if (!apiKey) return { checked: 0, skipped: true };
  healthCheckRunning = true;
  const store = getStore();
  const intervalHours = store.getSetting("healthIntervalHours", 24);
  const batchSize = store.getSetting("healthBatchSize", 5);
  let checked = 0;
  try {
    const batch = store.getHealthBatch(batchSize, intervalHours);
    for (const camera of batch) {
      try {
        const fresh = await getWebcam(apiKey, camera.source_id, rateLimitedWindyFetch);
        if (!fresh.snapshotUrl) {
          store.updateStatus(camera.camera_key, "unverified");
          checked += 1;
          continue;
        }
        const response = await rateLimitedWindyFetch(fresh.snapshotUrl, {
          headers: { Range: "bytes=0-2047" },
          signal: AbortSignal.timeout(12000),
          redirect: "follow"
        });
        const isImage = (response.headers.get("content-type") || "").toLowerCase().startsWith("image/");
        if (response.body) await response.body.cancel();
        store.updateStatus(camera.camera_key, response.ok && isImage ? "working" : "offline");
        checked += 1;
      } catch (error) {
        if (/not found|no longer active|no public media/i.test(error.message)) {
          store.updateStatus(camera.camera_key, "offline");
          checked += 1;
        } else {
          store.updateSource(WINDY_SOURCE, { last_error: error.message });
          break;
        }
      }
    }
    return { checked, skipped: false };
  } finally {
    healthCheckRunning = false;
  }
}

function registerCameraIpc() {
  ipcMain.handle("flight:get-state", () => getFlightState());
  ipcMain.handle("flight:refresh", () => refreshFlightData());

  ipcMain.handle("camera:get-state", async () => {
    const store = getStore();
    const source = store.getSource(WINDY_SOURCE);
    const settings = {
      refreshHours: source?.refresh_hours || 24,
      pagesPerRun: source?.pages_per_run || 12,
      healthIntervalHours: store.getSetting("healthIntervalHours", 24),
      healthBatchSize: store.getSetting("healthBatchSize", 5)
    };
    return {
      cameras: store.listCameras(),
      stats: store.getStats(),
      filters: store.getFilters(),
      settings,
      windy: {
        configured: Boolean(await getWindyKey()),
        status: source,
        documentationUrl: "https://api.windy.com/webcams/docs",
        keyUrl: "https://api.windy.com/keys"
      }
    };
  });

  ipcMain.handle("camera:save-windy-key", async (_event, key) => {
    await saveWindyKey(key);
    getStore().updateSource(WINDY_SOURCE, { enabled: 1, last_error: null });
    return { configured: true };
  });

  ipcMain.handle("camera:read-clipboard", () => clipboard.readText());

  ipcMain.handle("camera:clear-windy-key", async () => {
    try {
      await fs.unlink(getWindyKeyPath());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { configured: false };
  });

  ipcMain.handle("camera:update-settings", async (_event, settings) => {
    const refreshHours = Number(settings?.refreshHours);
    const pagesPerRun = Number(settings?.pagesPerRun);
    const healthIntervalHours = Number(settings?.healthIntervalHours);
    const healthBatchSize = Number(settings?.healthBatchSize);
    if (!Number.isInteger(refreshHours) || refreshHours < 24 || refreshHours > 720 ||
        !Number.isInteger(pagesPerRun) || pagesPerRun < 1 || pagesPerRun > 50 ||
        !Number.isInteger(healthIntervalHours) || healthIntervalHours < 1 || healthIntervalHours > 168 ||
        !Number.isInteger(healthBatchSize) || healthBatchSize < 1 || healthBatchSize > 25) {
      throw new Error("Discovery must run at least daily; check interval and batch size are out of range.");
    }
    getStore().updateSource(WINDY_SOURCE, { refresh_hours: refreshHours, pages_per_run: pagesPerRun });
    getStore().setSetting("healthIntervalHours", healthIntervalHours);
    getStore().setSetting("healthBatchSize", healthBatchSize);
    return { refreshHours, pagesPerRun, healthIntervalHours, healthBatchSize };
  });

  ipcMain.handle("camera:discover-windy", () => discoverWindy());

  ipcMain.handle("camera:get-media", async (_event, cameraKey) => {
    const camera = getStore().getCamera(String(cameraKey || ""));
    if (!camera) throw new Error("Camera record was not found.");
    if (camera.source !== WINDY_SOURCE) {
      return {
        streamUrl: camera.stream_url,
        snapshotUrl: camera.snapshot_url,
        playerUrl: camera.player_url,
        detailUrl: camera.detail_url
      };
    }
    const apiKey = await getWindyKey();
    if (!apiKey) throw new Error("Add your Windy Webcams API key to refresh this camera's secure media URLs.");
    const fresh = await getWebcam(apiKey, camera.source_id, rateLimitedWindyFetch);
    getStore().importCameras([fresh]);
    return {
      streamUrl: fresh.streamUrl || null,
      snapshotUrl: fresh.snapshotUrl,
      playerUrl: fresh.playerUrl,
      detailUrl: fresh.detailUrl || camera.detail_url
    };
  });

  ipcMain.handle("camera:save-user", (_event, input) => {
    const camera = createLocalCamera(input);
    getStore().importCameras([camera]);
    return getStore().getCamera(camera.cameraKey);
  });

  ipcMain.handle("camera:import-legacy", (_event, inputs) => {
    if (!Array.isArray(inputs)) return { imported: 0, invalid: 0 };
    const cameras = [];
    let invalid = 0;
    for (const input of inputs.slice(0, 1000)) {
      try {
        cameras.push(createLocalCamera(input));
      } catch {
        invalid += 1;
      }
    }
    const result = getStore().importCameras(cameras);
    return { ...result, invalid };
  });

  ipcMain.handle("camera:delete", (_event, cameraKey) => getStore().deleteCamera(String(cameraKey || "")));
  ipcMain.handle("camera:update-status", (_event, cameraKey, status, playbackVerified) =>
    getStore().updateStatus(String(cameraKey || ""), status, playbackVerified === true));
  ipcMain.handle("camera:open-external", async (_event, rawUrl) => {
    const url = new URL(String(rawUrl || ""));
    if (url.protocol !== "https:") throw new Error("Only HTTPS camera pages can be opened externally.");
    await shell.openExternal(url.href);
    return true;
  });
}

app.whenReady().then(() => {
  cameraStore = new CameraStore(path.join(app.getPath("userData"), "earthlive.sqlite"));
  nextFlightRequestAt = cameraStore.getSetting("openskyNextRequestAt", 0);
  lastFlightData = cameraStore.getSetting("openskyLastState", null);
  registerCameraIpc();
  protocol.handle("earthlive", async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    let filePath;
    try {
      const requestUrl = new URL(request.url);
      const relativePath = decodeURIComponent(requestUrl.pathname.slice(1));
      filePath = path.resolve(appRoot, relativePath);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const relativePath = path.relative(appRoot, filePath);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath) ||
      !/^(src|assets|node_modules)(?:[\\/]|$)/.test(relativePath)
    ) {
      return new Response("Not found", { status: 404 });
    }

    try {
      const body = await fs.readFile(filePath);
      return new Response(request.method === "HEAD" ? null : body, {
        headers: {
          "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        return new Response("Not found", { status: 404 });
      }
      console.error(`Could not serve app resource ${relativePath}.`, error);
      return new Response("Internal server error", { status: 500 });
    }
  });

  createWindow();
  const runScheduledDiscovery = async () => {
    try {
      if (discoveryRunning || !await getWindyKey()) return;
      const source = getStore().getSource(WINDY_SOURCE);
      const refreshHours = source?.refresh_hours || 24;
      if (!source?.last_discovery_at || Date.now() - source.last_discovery_at >= refreshHours * 60 * 60 * 1000) {
        await discoverWindy();
      }
    } catch (error) {
      console.error("Scheduled Windy discovery failed.", error.message);
    }
  };
  const runScheduledHealthCheck = async () => {
    try {
      await checkWindyHealth();
    } catch (error) {
      console.error("Scheduled camera health check failed.", error.message);
    }
  };
  setTimeout(runScheduledDiscovery, 15000);
  setInterval(runScheduledDiscovery, 30 * 60 * 1000);
  setTimeout(runScheduledHealthCheck, 60000);
  setInterval(runScheduledHealthCheck, 60 * 60 * 1000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (cameraStore) {
    cameraStore.close();
    cameraStore = null;
  }
});
