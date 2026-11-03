# EarthLive

EarthLive is a Windows desktop globe for exploring places and watching public camera streams that you add. It is an MVP, not a source of continuous satellite video: map and satellite imagery is static imagery refreshed by its providers, while live video comes only from camera feeds.

## Run on Windows

1. Install Node.js 22.12 or newer.
2. Open PowerShell in this folder.
3. Run:

   ```powershell
   npm install
   npm start
   ```

To package a Windows installer:

```powershell
npm run dist:win
```

The NSIS installer is written to `release/`. Building the installer requires a working internet connection the first time Electron and its packaging tools are downloaded.

## Using the app

### Version 0.5.0 — globe-first interface

- **Explore / Cameras / Flights** separate the main tasks. Cameras opens the searchable collection on the left. Flights opens flight controls on the left and selected-aircraft details on the right; camera markers and playback are paused when switching to Flights. Leaving Flights stops its polling.
- **Show planes** centers the map on the last requested regional feed and selects a zoom level that displays individual aircraft. It does not issue an extra API request or bypass cooldowns.
- **Focus view** temporarily hides panels and counters for an immersive globe; **Exit focus** restores them. Choosing another mode also exits Focus view.
- The default counter row shows the key totals; **More stats** reveals the remaining camera filters. Display controls and provider details sit in the collapsible **Display & data source** section. Panels use separate left/right positions, independent scrolling, higher contrast and larger text. The header wraps on smaller desktop windows.

### Version 0.4.0 — free regional aircraft tracking

- Enable **Flight Radar** to use **adsb.lol**, the default free regional feed. EarthLive requests reported aircraft within 100 nautical miles of the map center, with a thirty-second refresh target while the app is visible. Move the map and use **Track this area**; it respects the existing cooldown. This is regional receiver coverage, not a full-world feed. Source: [adsb.lol](https://www.adsb.lol/docs/open-data/api), [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- Find an aircraft in the loaded feed by callsign, ICAO24 or registration, then select **Follow aircraft**. The panel shows provider-reported position, registration, type, altitude and speed where available. Missing values stay unavailable. If a selected plane disappears from a later area response, its panel explicitly says last known position. No movement is predicted between reports.
- Position age uses the provider timestamp and `seen_pos`; reports over two minutes old or without position timing are marked stale/unknown. Request errors preserve the last response with an error notice. Retry-After and exponential backoff take precedence over the thirty-second target; cooldowns survive app restarts. Updates pause while the app is hidden or Flight Radar is disabled.
- The provider selector retains the slower **OpenSky worldwide** option with its existing twenty-minute anonymous quota schedule. The providers have separate caches and cooldowns. Switching providers never silently changes a failed regional request into another provider request.

### Version 0.3.0 — day/night and camera clocks

- **Day & night** adds a current, approximate night-side overlay to the globe. Toggle it with the Sun button; the setting is saved locally. The boundary refreshes every minute while visible and immediately when you return to the app. Camera markers remain above the shading.
- Selecting a camera shows its current local clock, calendar date, time-zone name, and an estimated Daylight / Twilight / Night state. The clock updates once a second while the app is visible. The location-based time zone is estimated offline using `tz-lookup`, with daylight-saving rules applied by the runtime. Locations close to time-zone boundaries can be approximate. If a zone cannot be resolved, the app explicitly shows UTC.
- Solar shading and daylight state use the [NOAA fractional-year equations](https://gml.noaa.gov/grad/solcalc/solareqns.PDF). They describe current sunlight, not weather, forecast conditions, or the time a camera image was captured. Twilight is the Sun between 0 and 6 degrees below the geometric horizon; atmospheric refraction is not modeled.

### Version 0.2.0

- **Search and favorites:** Open Camera list, search by camera name, city, country or source, and use the star beside a camera to save it. Favorites are kept in the local SQLite database and survive app restarts and repeat imports. Use Favorites only to narrow the list and map. Lists are paged in batches of 100.
- **More sources:** Sources now offers key-free Finland (Fintraffic / Digitraffic road-weather camera views) and Singapore (LTA via data.gov.sg traffic images) imports. Finland metadata is cached for an hour; open Finnish images refresh every ten minutes. Singapore directories and image URLs refresh at most once per minute while selected. Source failures preserve existing saved records. Imports do not pre-verify every image.
- **Attribution:** Finnish imagery/data: Fintraffic / Digitraffic, [CC BY 4.0 and service terms](https://www.digitraffic.fi/en/terms-of-service/). Singapore traffic images: Land Transport Authority via [data.gov.sg](https://data.gov.sg/datasets/d_6cdb6b405b25aaaacbaf7689bcc6fae0/view), Singapore Open Data Licence. Provider availability and freshness vary.
- **Playback recovery:** A failed media request or video retries twice (after two and five seconds); video buffering has a twenty-second timeout while playing. When available, an image is used as a fallback. Switching cameras cancels pending recovery. A manual Retry starts a new attempt. Failed snapshot refreshes may also retry twice; embedded frames remain unverified.
- **Honest media labels:** The panel distinguishes still images, short TfL clips, embedded players, video files and streams. Singapore exposes a capture timestamp; TfL and Finland may expose a source-file modification time. Missing timestamps stay unknown, and media older than thirty minutes is labeled older. VIDEO READY counts recently verified video playback, including clips; it does not establish continuous live video.
- **Build and update:** The header shows the app version; Sources shows the build identifier and Check for updates. Update checks read official GitHub releases and never silently install anything. With no published release, the app says so. Code pushes alone do not update the installed build.

To produce a repeatable versioned desktop folder, run `npm run build:desktop`. To select an output folder after running `npm run check`, run `node scripts/build-desktop.cjs <output-directory>`. Keep the entire generated `win-unpacked` folder together and point the EarthLive desktop shortcut to its versioned executable. Use the same local app storage to retain cameras and favorites.

- Open **Sources → Import London cameras** to import available TfL JamCams without an API key. Then choose **United Kingdom / London** in Camera list. Powered by TfL Open Data; see [TfL Open Data and terms](https://tfl.gov.uk/info-for/open-data-users/our-open-data). The import uses the official TfL directory, skips cameras reported unavailable, and updates existing records without duplicating them. Successful directory imports are limited to once per hour; failed attempts have a one-minute cooldown.
- TfL provides short traffic clips and periodically updated still images, rather than continuous live video. Use **Show latest image / Show traffic clip** to switch views. While open, images refresh every five minutes; a finished clip is refreshed on the same schedule without interrupting playback. Provider availability and capture times vary. A playable clip counts as verified video playback in the existing totals; that does not establish continuous live coverage or image freshness.

- Drag the spherical globe to rotate it, scroll to zoom, and right-drag to tilt; the on-screen controls also zoom.
- Search for a place (online geocoding) or enter `latitude, longitude`.
- Select **Imagery** to view satellite basemap imagery. This imagery is not real-time video.
- Select **Flight Radar** to load real OpenSky Network aircraft state vectors on the globe. Aircraft markers are placed at reported coordinates and barometric altitude, oriented to reported true track, clustered while zoomed out, and colored gray when their reported position is over two minutes old or has no position timestamp. Click an individual aircraft marker for its OpenSky-reported details; the selected aircraft stays highlighted and its panel updates with new positions. The follow control tracks the selected aircraft. No movement is extrapolated between provider updates. The altitude-scale slider changes marker size and is saved locally.
- Flight Radar uses anonymous OpenSky access and waits at least 20 minutes between global requests. OpenSky documents a 400-credit daily anonymous bucket; a global state-vector request costs 4 credits, so EarthLive's maximum schedule is 72 requests (288 credits) per 24 hours, leaving headroom. Multiple people behind the same public IP may share the anonymous quota. HTTP 429 responses are delayed according to OpenSky's retry header. Updates run only while Flight Radar is enabled.
- Select **Add camera** to save a camera name, stream URL, and coordinates. Cameras appear as pins and are kept in local app storage on this device.
- Select **Sources** to configure Windy Webcams, save its API key using Windows-encrypted credential storage, and run a rate-limited import. The discovery and health-check batch sizes can be configured; automatic discovery is at least 24 hours apart.
- Windy snapshots use expiring, signed URLs; EarthLive requests a fresh image URL when a camera opens and refreshes the selected snapshot. Embedded Windy player frames are labeled unverified because a cross-origin frame cannot expose its playback state to EarthLive.
- The permanent camera totals are queried from actual local SQLite records. “Working” means a recent image load or an image response from the scheduled health check; it does not mean video playback. “Live video” counts only video streams that emitted `canplay` within the last seven days. Embed-frame loading and URL reachability do not verify playback.
- HLS (`.m3u8`), MP4, and WebM streams may work if the URL is reachable, the server permits playback from EarthLive's secure `earthlive://app` origin (including CORS for HLS), and the stream is compatible with Chromium. A saved camera is not necessarily online.
- Use **Camera list** to revisit or remove saved cameras.
- If the network or map service is unavailable, EarthLive keeps camera management and coordinate entry available and shows an offline status. Geographic map tiles, satellite imagery, and place-name search are provided online and are not stored for offline use.

The included search and map work without a paid API key. They do require internet access. Place search uses OpenStreetMap Nominatim. The default map style and tiles use OpenFreeMap and OpenStreetMap data. Satellite tiles use Esri World Imagery. Provider availability, terms, attribution, and rate limits apply; see [OpenFreeMap](https://openfreemap.org), [OpenStreetMap](https://www.openstreetmap.org/copyright), [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/), and [Esri terms](https://www.esri.com/en-us/legal/terms/full-master-agreement).

The Windows installer includes a custom EarthLive icon. It is not digitally signed; distribution without security warnings requires a code-signing certificate issued to the publisher.

To sign a release when you have a trusted publisher certificate, set `CSC_LINK` to the certificate file and `CSC_KEY_PASSWORD` in the build environment before running `npm run dist:win`. Keep the certificate and password out of the project and source control. The build remains unsigned when no certificate is configured.

The first integrated discovery provider is Windy Webcams API v3. It requires a key from the [Windy API key manager](https://api.windy.com/keys); the API rejects requests without an authorized key. No cameras are imported until a key is configured, so totals remain zero rather than displaying fabricated records. Windy describes its directory as worldwide; the country coverage counter is the number of countries represented by actual indexed records, not an estimate of provider coverage. The app does not download the full directory in one run: it paginates incrementally (up to 50 records/page) with a 3.1-second pause between requests. API quotas and terms for the selected Windy account apply.

Official 511 and government feeds, and additional licensed webcam providers, will be added as separate adapters after this first source is verified. For example, [WSDOT's documented camera API](https://wsdot.wa.gov/traffic/api/Documentation/group___highway_cameras.html) requires a Traveler API access code; EarthLive does not bundle one. Road511 also requires a customer API key/subscription and covers North America rather than the whole world.

The initial flight provider is the official [OpenSky Network REST API](https://openskynetwork.github.io/opensky-api/rest.html), requested anonymously from `/api/states/all`. Anonymous responses provide only recent state vectors, at 10-second time resolution; availability, coverage, fields, quota, and rate limits are controlled by OpenSky. The first-stage integration does not include credentials, flight history, airline/airport enrichment, or a historical trail.

## Developer checks

```powershell
npm run check
```

`npm run check` includes JavaScript syntax checks and the camera-provider/SQLite tests. Rebuild the Windows installer with `npm run dist:win`; the generated installer is unsigned unless you configure a publisher certificate as described above.
