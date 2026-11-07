#!/usr/bin/env node
// Turns the output of extract_osm.py into the files the app loads:
//   data/<preset>.tmpo  gzipped binary road graph
//   data/<preset>.json  name, outline, default friends
//
// Usage: node scripts/build-preset.mjs build/tokyo-osm.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, encodeGraph } from '../src/graph.js';
import { makeProjection, PolygonIndex, projectPolygons, ringsBounds, simplifyFlat } from '../src/geo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/build-preset.mjs <extract.json>');
  process.exit(1);
}

const t0 = Date.now();
const src = JSON.parse(readFileSync(input, 'utf8'));
const presets = JSON.parse(readFileSync(join(root, 'scripts/presets.json'), 'utf8'));
const preset = presets[src.preset];

// projection centred on the boundary
const lonlat = src.boundary.flat(2);
const lons = lonlat.map((p) => p[0]);
const lats = lonlat.map((p) => p[1]);
const lon0 = +((Math.min(...lons) + Math.max(...lons)) / 2).toFixed(5);
const lat0 = +((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(5);
const proj = makeProjection(lon0, lat0);

const clip = new PolygonIndex(projectPolygons(src.boundary, proj));
const graph = buildGraph(src.elements, {
  proj,
  clip,
  progress: (p) => process.stdout.write(`\rbuilding ${(p * 100).toFixed(0)}%   `),
});
console.log(`\n${graph.nNodes} intersections, ${graph.nEdges} roads, ${graph.geomXY.length / 2} shape points`);

// outer rings only: holes (parks, palaces) read better as plain dark gaps
const outline = projectPolygons(src.outline.map((poly) => [poly[0]]), proj).map((ring) =>
  simplifyFlat(ring, 15).map((v) => Math.round(v)),
);
const b = ringsBounds(outline);

const friends = preset.friends.map((f) => ({ ...f }));
const meta = {
  id: src.preset,
  name: preset.name,
  subtitle: preset.subtitle,
  lon0,
  lat0,
  bounds: [Math.round(b.minX), Math.round(b.minY), Math.round(b.maxX), Math.round(b.maxY)],
  outline,
  friends,
  country: preset.country || '',
  roads: graph.nEdges,
  attribution: '© OpenStreetMap contributors',
};

mkdirSync(join(root, 'data'), { recursive: true });
const bin = encodeGraph(graph);
const gz = gzipSync(bin, { level: 9 });
writeFileSync(join(root, `data/${src.preset}.tmpo`), gz);
writeFileSync(join(root, `data/${src.preset}.json`), JSON.stringify(meta));
console.log(
  `data/${src.preset}.tmpo: ${(bin.length / 1e6).toFixed(2)} MB raw, ${(gz.length / 1e6).toFixed(2)} MB gzipped (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);
