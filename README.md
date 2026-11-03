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
