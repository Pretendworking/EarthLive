const RAD = Math.PI / 180;
// NOAA's fractional-year approximation. This visual estimate is not a forecast.
export function sunPosition(date = new Date()) {
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new Error("Invalid solar calculation date.");
  const year = date.getUTCFullYear();
  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  const day = Math.floor((time - Date.UTC(year, 0, 1)) / 86400000) + 1;
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const g = 2 * Math.PI / days * (day - 1 + (hour - 12) / 24);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const declination = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const longitude = ((180 - (hour * 60 + eq) / 4 + 540) % 360) - 180;
  return { latitude: declination / RAD, longitude };
}

export function solarElevation(latitude, longitude, date = new Date()) {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error("Invalid camera coordinates.");
  const sun = sunPosition(date);
  const sine = Math.sin(latitude * RAD) * Math.sin(sun.latitude * RAD) +
    Math.cos(latitude * RAD) * Math.cos(sun.latitude * RAD) * Math.cos((longitude - sun.longitude) * RAD);
  return Math.asin(Math.max(-1, Math.min(1, sine))) / RAD;
}

export function daylightLabel(latitude, longitude, date = new Date()) {
  const altitude = solarElevation(latitude, longitude, date);
  return altitude >= 0 ? "Daylight" : altitude >= -6 ? "Twilight" : "Night";
}

export function nightGeometry(date = new Date()) {
  const sun = sunPosition(date);
  // Split into one-degree longitude strips: no polygon crosses the date line.
  const declination = Math.abs(sun.latitude) < 1e-7 ? 1e-7 : sun.latitude;
  const boundary = lon => Math.atan(-Math.cos(declination * RAD) * Math.cos((lon - sun.longitude) * RAD) / Math.sin(declination * RAD)) / RAD;
  const coordinates = [];
  for (let lon = -180; lon < 180; lon++) {
    const a = boundary(lon), b = boundary(lon + 1);
    const ring = declination > 0
      ? [[lon, -90], [lon + 1, -90], [lon + 1, b], [lon, a], [lon, -90]]
      : [[lon, a], [lon + 1, b], [lon + 1, 90], [lon, 90], [lon, a]];
    coordinates.push([ring]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates } };
}

export function formatCameraTime(timeZone, date = new Date()) {
  try {
    if (!timeZone) throw new Error("Time zone unavailable.");
    return {
      time: new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date),
      date: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", timeZoneName: "short" }).format(date),
      fallback: false
    };
  } catch {
    return { time: date.toISOString().slice(11, 19), date: `${date.toISOString().slice(0, 10)} UTC · local zone unavailable`, fallback: true };
  }
}
