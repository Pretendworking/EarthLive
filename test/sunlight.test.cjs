const test = require("node:test");
const assert = require("node:assert/strict");
const { cameraTimeZone } = require("../electron/camera-time.cjs");
test("solar model follows seasons, UTC rotation and polar day/night", async () => {
  const { sunPosition, solarElevation, daylightLabel } = await import("../src/sunlight.mjs");
  const june = new Date("2026-06-21T12:00:00Z"), december = new Date("2026-12-21T12:00:00Z");
  assert.ok(Math.abs(sunPosition(june).latitude - 23.44) < 0.5);
  assert.ok(Math.abs(sunPosition(december).latitude + 23.44) < 0.5);
  assert.ok(Math.abs(sunPosition(june).longitude) < 2);
  assert.ok(solarElevation(0, 0, june) > 60);
  assert.ok(solarElevation(0, 180, june) < -60);
  assert.equal(daylightLabel(89, 0, june), "Daylight");
  assert.equal(daylightLabel(89, 0, december), "Night");
  assert.throws(() => solarElevation(100, 0, june), /Invalid/);
  assert.throws(() => sunPosition(new Date("invalid")), /Invalid/);
});
test("night polygons stay finite and split safely at the date line", async () => {
  const { nightGeometry, solarElevation } = await import("../src/sunlight.mjs");
  for (const iso of ["2026-03-20T12:00:00Z", "2026-06-21T00:00:00Z", "2026-12-21T18:00:00Z", "2028-02-29T23:59:00Z"]) {
    const date = new Date(iso), feature = nightGeometry(date);
    assert.equal(feature.geometry.coordinates.length, 360);
    for (const [ring] of feature.geometry.coordinates) {
      assert.deepEqual(ring[0], ring.at(-1));
      for (const [lon, lat] of ring) {
        assert.ok(Number.isFinite(lat) && Math.abs(lat) <= 90);
        assert.ok(Number.isFinite(lon) && Math.abs(lon) <= 180);
      }
      assert.ok(Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0])) <= 1);
      const latitude = (Math.min(...ring.map(p => p[1])) + Math.max(...ring.map(p => p[1]))) / 2;
      assert.ok(solarElevation(latitude, ring[0][0] + 0.5, date) < 1.1);
    }
  }
});
test("geographic camera zones and displayed clocks handle DST and date rollover", async () => {
  const { formatCameraTime } = await import("../src/sunlight.mjs");
  assert.equal(cameraTimeZone({ latitude: 51.5, longitude: -0.1 }), "Europe/London");
  assert.equal(cameraTimeZone({ latitude: 40.7, longitude: -74 }), "America/New_York");
  assert.equal(cameraTimeZone({ latitude: 1.35, longitude: 103.8 }), "Asia/Singapore");
  assert.equal(cameraTimeZone(null), null);
  assert.equal(cameraTimeZone({ latitude: NaN, longitude: 0 }), null);
  assert.equal(formatCameraTime("Europe/London", new Date("2026-01-15T12:00:00Z")).time, "12:00:00");
  assert.equal(formatCameraTime("Europe/London", new Date("2026-07-15T12:00:00Z")).time, "13:00:00");
  assert.match(formatCameraTime("Asia/Singapore", new Date("2026-07-15T20:00:00Z")).date, /Jul 16/);
  assert.equal(formatCameraTime("Invalid/Zone").fallback, true);
  assert.equal(formatCameraTime(null).fallback, true);
});
