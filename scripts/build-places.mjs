#!/usr/bin/env node
// Turns the output of extract_places.py into the bundled offline data:
//   data/<preset>-places.json.gz     things to do, sorted into the four groups
//   data/<preset>-gazetteer.json.gz  neighbourhoods, stations and landmarks
//
// Usage: node scripts/build-places.mjs build/tokyo-places-osm.json tokyo
// (run build-preset.mjs first; this keeps only places on or near its streets)

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, position } from '../src/places.js';
import { decodeGraph } from '../src/graph.js';
import { PolygonIndex } from '../src/geo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [input, id] = process.argv.slice(2);
if (!input || !id) {
  console.error('usage: node scripts/build-places.mjs <extract.json> <preset>');
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(root, `data/${id}.json`), 'utf8'));
const graph = await decodeGraph(readFileSync(join(root, `data/${id}.tmpo`)));
const outline = new PolygonIndex(meta.outline);
const near = (lat, lon) => {
  const [x, y] = graph.proj.fwd(lon, lat);
  if (outline.contains(x, y)) return true;
  const n = graph.grid.nearest(x, y);
  return Math.hypot(graph.nodeX[n] - x, graph.nodeY[n] - y) < 1000;
};
const metres = (a, b) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180));
const shortId = (el) => `${el.type[0]}${el.id}`;

const { elements } = JSON.parse(readFileSync(input, 'utf8'));
const kinds = [];
const kindIndex = new Map();
const places = [];
const gazetteer = [];
const seenPlace = new Map();
const seenGaz = new Map();

for (const el of elements) {
  const tags = el.tags || {};
  const pos = position(el);
  if (!pos || !tags.name) continue;
  const [lat, lon, area] = pos;
  if (!near(lat, lon)) continue;
  const lat5 = Math.round(lat * 1e5);
  const lon5 = Math.round(lon * 1e5);

  const cls = classify(tags);
  if (cls) {
    const key = `${cls.category}\t${cls.kind}`;
    if (!kindIndex.has(key)) {
      kindIndex.set(key, kinds.length);
      kinds.push(key);
    }
    const dupKey = `${key}\t${tags.name}`;
    const prev = seenPlace.get(dupKey);
    if (!prev || !prev.some((p) => metres(p, [lat, lon]) < 60)) {
      seenPlace.set(dupKey, [...(prev || []), [lat, lon]]);
      const park = tags.leisure === 'park' || tags.leisure === 'garden' || tags.leisure === 'nature_reserve';
      const flags =
        (tags.wikidata || tags.wikipedia ? 1 : 0) |
        (tags.website || tags['contact:website'] || tags.opening_hours ? 2 : 0) |
        (park ? 4 : 0);
      places.push([lat5, lon5, kindIndex.get(key), tags.name, tags['name:en'] || '', flags, shortId(el), Math.round(area)]);
    }
  }

  let type = null;
  if (tags.railway === 'station' || tags.railway === 'halt') type = 's';
  else if (tags.aeroway === 'aerodrome') type = 'a';
  else if (tags.place === 'suburb' || tags.place === 'quarter') type = 'p';
  else if (tags.place === 'neighbourhood') type = 'n';
  else if (tags.wikidata) type = 'l';
  if (type) {
    const dupKey = `${type}\t${tags['name:en'] || tags.name}`;
    const prev = seenGaz.get(dupKey);
    if (!prev || !prev.some((p) => metres(p, [lat, lon]) < 300)) {
      seenGaz.set(dupKey, [...(prev || []), [lat, lon]]);
      gazetteer.push([lat5, lon5, type, tags.name, tags['name:en'] || '', tags['name:ja-Latn'] || tags['name:ja_rm'] || '']);
    }
  }
}

const write = (name, data) => {
  const json = JSON.stringify(data);
  const gz = gzipSync(json, { level: 9 });
  writeFileSync(join(root, `data/${name}`), gz);
  return `${(json.length / 1e6).toFixed(2)} MB raw, ${(gz.length / 1e6).toFixed(2)} MB gzipped`;
};
console.log(`${places.length} places in ${kinds.length} kinds: ${write(`${id}-places.json.gz`, { v: 1, kinds, items: places })}`);
const counts = gazetteer.reduce((a, g) => ((a[g[2]] = (a[g[2]] || 0) + 1), a), {});
console.log(`${gazetteer.length} gazetteer entries ${JSON.stringify(counts)}: ${write(`${id}-gazetteer.json.gz`, { v: 1, items: gazetteer })}`);
