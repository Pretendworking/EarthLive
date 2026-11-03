const lookup = require("tz-lookup");
function cameraTimeZone(camera) {
  if (!camera || !Number.isFinite(camera.latitude) || Math.abs(camera.latitude) > 90 ||
      !Number.isFinite(camera.longitude) || Math.abs(camera.longitude) > 180) return null;
  try {
    const zone = lookup(camera.latitude, camera.longitude);
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return zone;
  } catch { return null; }
}
module.exports = { cameraTimeZone };
