export function matchesCameraSearch(camera, query) {
  const words = String(query || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [camera.name, camera.country, camera.country_code, camera.city, camera.source, camera.source_id]
    .filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every(word => haystack.includes(word));
}

export function describeCameraMedia(camera, view, capturedAt, now = Date.now(), timestampBasis = "Provider capture time") {
  const kind = view === "snapshot" ? "Still image" : view === "player" ? "Embedded player · playback unverified" :
    camera.source === "tfl" ? "Short traffic clip · not continuous live video" :
      /\.(mp4|webm)(?:$|[?#])/i.test(camera.stream_url || "") ? "Video file · not verified live" : "Video stream · delay unknown";
  const time = Date.parse(capturedAt);
  if (!Number.isFinite(time) || time > now + 60000) return `${kind} · capture time unknown`;
  const age = Math.max(0, Math.floor((now - time) / 60000));
  const ageText = age === 0 ? "less than a minute ago" : age < 60 ? `${age} min ago` : age < 1440 ? `${Math.floor(age / 60)} hr ago` : `${Math.floor(age / 1440)} days ago`;
  const timeLabel = timestampBasis === "Provider file modification time" ? "source file updated" : "captured";
  return `${kind} · ${timeLabel} ${ageText}${age >= 30 ? " · older image / clip" : ""}`;
}
