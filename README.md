# Iceberg Map

A peer-to-peer, anonymous ICE sighting report network. No accounts, no servers, no tracking. Reports are shared directly between browsers using WebRTC.

## How It Works

Users submit reports of ICE activity (checkpoints, raids, patrols, arrests, surveillance) which are stored locally in the browser using IndexedDB and broadcast to other connected peers via WebRTC. There is no central server — peers discover each other through BitTorrent DHT matchmaking via [Trystero](https://github.com/dmotz/trystero).

### Privacy by Design

- **No accounts or identity** — reports carry zero identifying information
- **No central server** — data lives only in users' browsers
- **Timing obfuscation** — reports are broadcast after a random 2–30 second delay to prevent timing correlation
- **Photo metadata stripping** — all EXIF data (GPS, camera info, timestamps) is removed before sharing by re-encoding through a canvas element
- **Federal IP blocking** — WebRTC ICE candidates are checked against known DHS, DOJ, FBI, and DoD CIDR ranges

## Features

- **Feed view** — chronological list of sightings with type/state filters and confirm/dispute voting
- **Map view** — Leaflet map with clustered markers, color-coded by activity type, using a dark CARTO basemap
- **Report submission** — modal form with optional GPS location, photo upload, vehicle descriptions, and agent count
- **Auto-purge** — configurable retention period (7/14/30/90 days) automatically cleans old data
- **Responsive** — mobile-friendly layout

## Project Structure

```
index.html          Main app shell
css/style.css       Dark theme styles
js/
  app.js            App entry point, navigation, feed rendering, report form
  network.js        P2P networking via Trystero (BitTorrent DHT + WebRTC)
  db.js             IndexedDB wrapper for sightings and confirmations
  map.js            Leaflet map with marker clustering
  cidr.js           Federal government IP range detection
  media.js          EXIF metadata stripping for photos
tests/
  test.html         Browser-based test runner
  runner.js         Minimal test framework (describe/test/expect)
  cidr.test.js      CIDR parsing and IP matching tests
  db.test.js        IndexedDB operation tests
  network.test.js   Network module tests
```

## Running

Serve the project with any static file server:

```sh
npx serve .
```

Open `index.html` in a browser. No build step required — the app uses native ES modules and loads Leaflet and Trystero from CDN.

## Running Tests

Open `tests/test.html` in a browser. Results are displayed in-page and logged to the console.

## Tech Stack

- **Networking**: [Trystero](https://github.com/dmotz/trystero) (BitTorrent DHT + WebRTC)
- **Storage**: IndexedDB (via raw API)
- **Map**: [Leaflet](https://leafletjs.com/) + [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster)
- **Tiles**: [CARTO Dark Matter](https://carto.com/basemaps/)
- **Build**: None — vanilla JS with native ES modules

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md)
