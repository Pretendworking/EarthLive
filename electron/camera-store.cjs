const { DatabaseSync } = require("node:sqlite");
const { createHash, randomUUID } = require("node:crypto");

const STATUSES = new Set(["working", "offline", "unverified"]);
const CAMERA_TYPES = new Set(["traffic", "webcam"]);
const MEDIA_TYPES = new Set(["video", "snapshot", "embed", "unknown"]);

function fingerprint(camera) {
  if (camera.source === "tfl" && camera.sourceId) {
    return createHash("sha256").update(`tfl:${camera.sourceId}`).digest("hex");
  }
  const mediaUrl = camera.detailUrl || camera.streamUrl || camera.url || camera.playerUrl || camera.snapshotUrl;
  let identity;
  if (mediaUrl) {
    try {
      const url = new URL(mediaUrl);
      url.search = "";
      url.hash = "";
      identity = url.href.toLowerCase();
    } catch {
      identity = String(mediaUrl).toLowerCase();
    }
  } else {
    identity = `${String(camera.name || "").trim().toLowerCase()}|${Number(camera.latitude).toFixed(5)}|${Number(camera.longitude).toFixed(5)}`;
  }
  return createHash("sha256").update(identity).digest("hex");
}

function fromRow(row) {
  return {
    ...row,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    lastSeenAt: row.last_seen_at,
    lastCheckedAt: row.last_checked_at,
    playbackVerifiedAt: row.playback_verified_at,
    sourceUpdatedAt: row.source_updated_at
  };
}

class CameraStore {
  constructor(filePath) {
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS cameras (
        camera_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        name TEXT NOT NULL,
        country TEXT NOT NULL DEFAULT '',
        country_code TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        camera_type TEXT NOT NULL CHECK(camera_type IN ('traffic','webcam')),
        media_type TEXT NOT NULL CHECK(media_type IN ('video','snapshot','embed','unknown')),
        stream_url TEXT,
        snapshot_url TEXT,
        player_url TEXT,
        detail_url TEXT,
        source_status TEXT NOT NULL DEFAULT 'active',
        status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('working','offline','unverified')),
        playback_status TEXT NOT NULL DEFAULT 'unverified' CHECK(playback_status IN ('verified','snapshot','offline','unverified')),
        last_seen_at INTEGER NOT NULL,
        last_checked_at INTEGER,
        playback_verified_at INTEGER,
        source_updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS cameras_location_idx ON cameras(latitude, longitude);
      CREATE INDEX IF NOT EXISTS cameras_filter_idx ON cameras(country, city, camera_type, status);
      CREATE TABLE IF NOT EXISTS camera_sources (
        source TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_discovery_at INTEGER,
        next_offset INTEGER NOT NULL DEFAULT 0,
        total_available INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        refresh_hours INTEGER NOT NULL DEFAULT 24,
        pages_per_run INTEGER NOT NULL DEFAULT 12,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS camera_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const cameraColumns = this.db.prepare("PRAGMA table_info(cameras)").all().map((column) => column.name);
    if (!cameraColumns.includes("playback_status")) {
      this.db.exec("ALTER TABLE cameras ADD COLUMN playback_status TEXT NOT NULL DEFAULT 'unverified'");
    }
    this.upsertCamera = this.db.prepare(`
      INSERT INTO cameras (
        camera_key, fingerprint, source, source_id, name, country, country_code, city,
        latitude, longitude, camera_type, media_type, stream_url, snapshot_url, player_url,
        detail_url, source_status, status, last_seen_at, source_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        name = excluded.name, country = excluded.country, country_code = excluded.country_code,
        city = excluded.city, latitude = excluded.latitude, longitude = excluded.longitude,
        camera_type = excluded.camera_type, media_type = excluded.media_type,
        stream_url = excluded.stream_url, snapshot_url = excluded.snapshot_url,
        player_url = excluded.player_url, detail_url = excluded.detail_url,
        source_status = excluded.source_status, last_seen_at = excluded.last_seen_at,
        source_updated_at = excluded.source_updated_at
    `);
    this.selectCamera = this.db.prepare("SELECT * FROM cameras WHERE camera_key = ?");
  }

  close() {
    this.db.close();
  }

  importCameras(cameras) {
    const now = Date.now();
    let imported = 0;
    let duplicates = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const camera of cameras) {
        if (!camera || !CAMERA_TYPES.has(camera.type) || !MEDIA_TYPES.has(camera.mediaType) ||
            typeof camera.cameraKey !== "string" || !camera.cameraKey ||
            typeof camera.source !== "string" || typeof camera.sourceId !== "string" ||
            typeof camera.name !== "string" || !camera.name.trim() ||
            !Number.isFinite(camera.latitude) || camera.latitude < -90 || camera.latitude > 90 ||
            !Number.isFinite(camera.longitude) || camera.longitude < -180 || camera.longitude > 180) continue;

        const dedupeKey = fingerprint(camera);
        const existing = this.db.prepare("SELECT camera_key FROM cameras WHERE fingerprint = ?").get(dedupeKey);
        this.upsertCamera.run(
          camera.cameraKey, dedupeKey, camera.source, camera.sourceId, camera.name.trim(),
          camera.country || "", camera.countryCode || "", camera.city || "",
          camera.latitude, camera.longitude, camera.type, camera.mediaType,
          camera.streamUrl || camera.url || null, camera.snapshotUrl || null,
          camera.playerUrl || null, camera.detailUrl || null, camera.sourceStatus || "active",
          "unverified", now, camera.sourceUpdatedAt || null
        );
        if (existing) duplicates += 1;
        else imported += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { imported, duplicates };
  }

  listCameras(filters = {}) {
    const conditions = [];
    const params = [];
    for (const [key, column] of [["country", "country"], ["city", "city"], ["type", "camera_type"], ["status", "status"]]) {
      const value = filters[key];
      if (typeof value === "string" && value.trim()) {
        conditions.push(`${column} = ?`);
        params.push(value.trim());
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM cameras ${where} ORDER BY name LIMIT 50000`).all(...params).map(fromRow);
  }

  getCamera(cameraKey) {
    const row = this.selectCamera.get(cameraKey);
    return row ? fromRow(row) : null;
  }

  deleteCamera(cameraKey) {
    return this.db.prepare("DELETE FROM cameras WHERE camera_key = ?").run(cameraKey).changes;
  }

  updateStatus(cameraKey, status, playbackVerified = false) {
    if (!STATUSES.has(status)) throw new Error("Invalid camera status.");
    const now = Date.now();
    const camera = this.getCamera(cameraKey);
    if (!camera) return 0;
    const playbackStatus = playbackVerified
      ? "verified"
      : status === "offline"
        ? "offline"
        : status === "working" && camera.media_type === "snapshot"
          ? "snapshot"
          : status === "working" && camera.playback_status === "verified"
            ? "verified"
            : "unverified";
    return Number(this.db.prepare(`
      UPDATE cameras SET status = ?, playback_status = ?, last_checked_at = ?,
        playback_verified_at = CASE WHEN ? THEN ? ELSE playback_verified_at END
      WHERE camera_key = ?
    `).run(status, playbackStatus, now, playbackVerified ? 1 : 0, playbackVerified ? now : null, cameraKey).changes);
  }

  getStats() {
    const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return this.db.prepare(`
      SELECT
        COUNT(*) AS indexed,
        SUM(CASE WHEN status = 'working' AND last_checked_at >= ? THEN 1 ELSE 0 END) AS working,
        SUM(CASE WHEN media_type = 'video' AND status = 'working' AND playback_status = 'verified' AND playback_verified_at >= ? THEN 1 ELSE 0 END) AS live_video,
        SUM(CASE WHEN media_type = 'snapshot' THEN 1 ELSE 0 END) AS snapshots,
        SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) AS offline,
        SUM(CASE WHEN status = 'unverified' OR (status = 'working' AND last_checked_at < ?) THEN 1 ELSE 0 END) AS unverified,
        COUNT(DISTINCT NULLIF(country_code, '')) AS countries,
        MAX(last_seen_at) AS last_seen_at,
        MAX(playback_verified_at) AS last_verified_at
      FROM cameras
    `).get(recentCutoff, recentCutoff, recentCutoff);
  }

  getFilters() {
    return {
      countries: this.db.prepare("SELECT DISTINCT country country, country_code code FROM cameras WHERE country <> '' ORDER BY country").all(),
      cities: this.db.prepare("SELECT DISTINCT city FROM cameras WHERE city <> '' ORDER BY city LIMIT 5000").all().map((row) => row.city)
    };
  }

  getSource(source) {
    return this.db.prepare("SELECT * FROM camera_sources WHERE source = ?").get(source) || null;
  }

  updateSource(source, updates = {}) {
    const current = this.getSource(source) || {
      source, enabled: 1, last_discovery_at: null, next_offset: 0,
      total_available: 0, last_error: null, refresh_hours: 24,
      pages_per_run: 12, updated_at: Date.now()
    };
    const next = {
      enabled: updates.enabled ?? current.enabled,
      last_discovery_at: updates.last_discovery_at ?? current.last_discovery_at,
      next_offset: updates.next_offset ?? current.next_offset,
      total_available: updates.total_available ?? current.total_available,
      last_error: Object.prototype.hasOwnProperty.call(updates, "last_error") ? updates.last_error : current.last_error,
      refresh_hours: updates.refresh_hours ?? current.refresh_hours,
      pages_per_run: updates.pages_per_run ?? current.pages_per_run,
      updated_at: Date.now()
    };
    this.db.prepare(`
      INSERT INTO camera_sources (source, enabled, last_discovery_at, next_offset, total_available, last_error, refresh_hours, pages_per_run, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        enabled = excluded.enabled, last_discovery_at = excluded.last_discovery_at,
        next_offset = excluded.next_offset, total_available = excluded.total_available,
        last_error = excluded.last_error, refresh_hours = excluded.refresh_hours,
        pages_per_run = excluded.pages_per_run, updated_at = excluded.updated_at
    `).run(source, next.enabled, next.last_discovery_at, next.next_offset, next.total_available, next.last_error, next.refresh_hours, next.pages_per_run, next.updated_at);
    return this.getSource(source);
  }

  getHealthBatch(limit = 10, intervalHours = 24) {
    const cutoff = Date.now() - intervalHours * 60 * 60 * 1000;
    return this.db.prepare(`
      SELECT * FROM cameras WHERE source = 'windy'
        AND (last_checked_at IS NULL OR last_checked_at < ?)
      ORDER BY COALESCE(last_checked_at, 0), camera_key LIMIT ?
    `).all(cutoff, Math.max(1, Math.min(100, Math.trunc(limit)))).map(fromRow);
  }

  setSetting(key, value) {
    this.db.prepare("INSERT INTO camera_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM camera_settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  getUserCameras() {
    return this.listCameras().filter((camera) => camera.source === "local");
  }
}

function createLocalCamera(input) {
  const latitude = Number(input?.latitude);
  const longitude = Number(input?.longitude);
  const url = String(input?.url || input?.streamUrl || "");
  const id = String(input?.id || randomUUID());
  if (!url || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Camera URL and valid coordinates are required.");
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Camera URL must be a valid HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Camera URL must use HTTP or HTTPS.");
  const selectedMediaType = String(input.mediaType || "auto");
  const mediaType = selectedMediaType === "mjpeg" || selectedMediaType === "snapshot"
    ? "snapshot"
    : selectedMediaType === "video" || /\.(?:m3u8|mp4|webm)(?:$|[?#])/i.test(url)
      ? "video"
      : /\.(?:jpe?g|png|m?jpeg)(?:$|[?#])/i.test(url)
        ? "snapshot"
        : "unknown";
  return {
    cameraKey: `local:${id}`,
    source: "local",
    sourceId: id,
    name: String(input.name || "User camera").trim(),
    country: String(input.country || ""),
    countryCode: String(input.countryCode || "").toUpperCase(),
    city: String(input.city || ""),
    latitude,
    longitude,
    type: input.type === "traffic" ? "traffic" : "webcam",
    mediaType,
    streamUrl: url,
    sourceStatus: "user-added"
  };
}

module.exports = { CameraStore, createLocalCamera, fingerprint };
