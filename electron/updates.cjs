function compareVersions(a, b) {
  const parse = value => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const left = parse(a), right = parse(b);
  if (!left || !right) throw new Error("Unrecognized release version.");
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
async function checkForUpdates(version, fetchImpl = fetch) {
  const response = await fetchImpl("https://api.github.com/repos/Pretendworking/EarthLive/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "EarthLive" }, signal: AbortSignal.timeout(15000)
  });
  if (response.status === 404) return { available: false, message: "No published releases yet. Your installed build stays unchanged." };
  if (!response.ok) throw new Error(`Update check returned HTTP ${response.status}. Try again later.`);
  const release = await response.json();
  const url = new URL(release.html_url);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith("/Pretendworking/EarthLive/releases/tag/") || release.draft || release.prerelease) {
    throw new Error("Unrecognized update response.");
  }
  const available = compareVersions(release.tag_name, version) > 0;
  return { available, version: release.tag_name, url: url.href,
    message: available ? `Version ${release.tag_name} is available. Open the release to download it.` : "This build is up to date with published releases." };
}
module.exports = { compareVersions, checkForUpdates };
