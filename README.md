# Tempo

**Where should your friends meet?** Drop friends anywhere in a city and Tempo floods the real road network from each of them to find the fairest place to meet. The animation shows why searching *all at once* beats searching *one by one*, and you can record it as a 9:16 video.

<p>
  <img src="docs/one-by-one.jpg" width="270" alt="One by one: a friend's search floods all of Tokyo">
  <img src="docs/preview.jpg" width="270" alt="All at once: four floods meet near Shibaura-futo Station">
</p>

## What it does

1. **One by one.** A full Dijkstra search from each friend. Without knowing where everyone will end up, every search has to cover the whole city: 4 × 188,870 = 755,480 roads in Tokyo.
2. **All at once.** The four searches take turns, always growing whichever front is closest. The first junction every flood has reached is the place that keeps the *longest* trip as short as possible, so the search stops right there. In Tokyo that is 271,077 roads, 64% fewer.
3. **Meet.** The meeting point is named from a nearby station or park (via Nominatim), and each friend's route and distance is drawn.

## Features

- Tokyo's 23 wards are bundled (188k road segments, 2.5 MB), so the default view loads without downloading roads.
- **Any other city** loads live: search for it, and its roads come from the Overpass API and are built into a graph in a Web Worker. Detail is chosen from the city's size (all streets, main roads or major roads).
- 2 to 6 friends: drag markers, or select a friend and click the map, or search for a place by name. Names and place labels are editable.
- Timeline scrubber, 0.5× to 2× speed, and an option to skip the one-by-one phase.
- **Record video**: saves the animation as a 1080×1920 MP4 or WebM from the browser.
- **Copy link**: the URL keeps the city and every friend, so a shared link reopens the same scene.

## Running it

It is a static site with no build step and no dependencies.

```sh
npm start          # serves on http://localhost:8000 (or: python3 -m http.server)
npm test           # unit tests (Node 20+)
```

Any static host works, including GitHub Pages. Loading other cities needs the browser to reach `nominatim.openstreetmap.org` and the Overpass API.

## How the code is laid out

| File | Purpose |
| --- | --- |
| `src/graph.js` | Builds an intersection-to-intersection road graph from OSM ways, binary (de)serialisation, nearest-node grid |
| `src/search.js` | Dijkstra, the simultaneous multi-source search, and `Flood` replay data |
| `src/timeline.js` | The sequence of phases and what each frame shows |
| `src/renderer.js` | Canvas rendering: base map, incremental flood layers, glowing wavefronts, markers, routes, captions |
| `src/geo.js` | Projection, simplification, point-in-polygon index, shore-hugging outline tracing |
| `src/osm.js` | Nominatim (rate limited to 1 request/second) and Overpass queries |
| `src/worker.js` | Downloads and builds other cities off the main thread |
| `src/main.js` | App state, UI, interaction, sharing and recording |

## Rebuilding or adding a bundled city

Presets are defined in `scripts/presets.json` (boundary relations, road detail and default friends).

```sh
pip install osmium shapely
# PBF extracts: https://download.openstreetmap.fr/extracts/ or https://download.geofabrik.de/
python3 scripts/extract_osm.py kanto.osm.pbf tokyo -o build/tokyo-osm.json
node scripts/build-preset.mjs build/tokyo-osm.json   # writes data/tokyo.tmpo and data/tokyo.json
```

To show a new preset in the app, add it to `PRESETS` in `src/main.js`.

## Data

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License. The files in `data/` are derived from it.
