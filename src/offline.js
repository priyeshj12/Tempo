// Bundled data for a preset city, used when OpenStreetMap's live services
// cannot be reached (no network, or a page that may not call other sites).
//
//   data/<id>-places.json.gz     things to do, already sorted into groups
//   data/<id>-gazetteer.json.gz  neighbourhoods, stations and landmarks

const TYPE_LABEL = { s: 'station', a: 'airport', p: 'area', n: 'neighbourhood', l: 'landmark' };
const TYPE_BONUS = { s: 8, a: 10, l: 6, p: 5, n: 3 };

import { dataPath, fetchBytes } from './files.js';

const bundles = new Map();

/** Fetches a file that may be gzipped and parses it as JSON. */
export async function fetchJson(url) {
  let bytes = await fetchBytes(url);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Loads (once) the bundled places and gazetteer of a preset. */
export function loadBundle(id, meta) {
  if (!bundles.has(id)) {
    const p = Promise.all([fetchJson(dataPath(`${id}-places.json.gz`)), fetchJson(dataPath(`${id}-gazetteer.json.gz`))]).then(
      ([places, gaz]) => makeBundle(id, meta, places, gaz),
    );
    p.catch(() => bundles.delete(id));
    bundles.set(id, p);
  }
  return bundles.get(id);
}

/** Builds a bundle from the parsed files. */
export function makeBundle(id, meta, places, gaz) {
  return {
    id,
    city: meta.name,
    country: meta.country || '',
    kinds: places.kinds.map((k) => k.split('\t')),
    places: places.items,
    gazetteer: gaz.items.map((it) => ({
      lat: it[0] / 1e5,
      lon: it[1] / 1e5,
      type: it[2],
      name: it[3],
      nameEn: it[4],
      latn: it[5],
      keys: [it[3], it[4], it[5]].filter(Boolean).map(normalize),
    })),
  };
}

export function normalize(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const STATION_WORDS = /\b(station|sta|eki)\b|駅/g;

function scoreKey(q, key) {
  if (!key) return 0;
  if (key === q) return 100;
  if (key.startsWith(q)) return 75 - Math.min(20, key.length - q.length);
  if (q.length >= 3 && key.includes(q)) return 50;
  const words = q.split(' ');
  if (words.length > 1 && words.every((w) => key.includes(w))) return 45;
  // "Nakameguro" for "Naka-meguro": compare without spaces, a little lower
  const qc = q.replace(/ /g, '');
  const kc = key.replace(/ /g, '');
  if (qc !== q || kc !== key) {
    if (kc === qc) return 95;
    if (kc.startsWith(qc)) return 70 - Math.min(20, kc.length - qc.length);
  }
  return 0;
}

const metres = (a, b) =>
  Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));

/** Finds starting points by name, shaped like osm.geocode results. */
export function searchGazetteer(bundle, query, limit = 5) {
  const raw = normalize(query);
  const wantsStation = STATION_WORDS.test(raw) || /駅/.test(query);
  STATION_WORDS.lastIndex = 0;
  const q = raw.replace(STATION_WORDS, ' ').replace(/\s+/g, ' ').trim() || raw;
  if (!q) return [];
  const hits = [];
  for (const g of bundle.gazetteer) {
    let best = 0;
    for (const k of g.keys) best = Math.max(best, scoreKey(q, k));
    if (!best) continue;
    let score = best + (TYPE_BONUS[g.type] || 0);
    if (wantsStation && g.type === 's') score += 15;
    hits.push({ g, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const out = [];
  for (const { g } of hits) {
    const label = g.nameEn || g.name;
    // the same station is often mapped several times, once per line
    if (out.some((o) => o.label === label && metres(o, g) < 600)) continue;
    out.push({
      label,
      detail: `${label}, ${TYPE_LABEL[g.type]} in ${bundle.city}`,
      sub: `${TYPE_LABEL[g.type][0].toUpperCase()}${TYPE_LABEL[g.type].slice(1)} in ${bundle.city}`,
      lat: g.lat,
      lon: g.lon,
      city: bundle.city,
      region: bundle.city,
      country: bundle.country,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function nearest(bundle, at, types, within) {
  let best = null;
  let bestD = within;
  for (const g of bundle.gazetteer) {
    if (!types.includes(g.type)) continue;
    const d = metres(at, g);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best ? { g: best, d: bestD } : null;
}

/** Neighbourhood name for a point, like osm.placeName. */
export function bundledPlaceName(bundle, lat, lon) {
  const at = { lat, lon };
  const hit = nearest(bundle, at, ['n', 'p'], 2000) || nearest(bundle, at, ['s'], 1500);
  return { label: hit ? hit.g.nameEn || hit.g.name : '', city: bundle.city };
}

/** A station or park people would recognise near a point, like osm.landmarkName. */
export function bundledLandmark(bundle, lat, lon, stationName) {
  const at = { lat, lon };
  let best = null;
  let bestScore = Infinity;
  for (const g of bundle.gazetteer) {
    if (g.type !== 's') continue;
    const d = metres(at, g);
    if (d < 900 && d / 1.6 < bestScore) {
      bestScore = d / 1.6;
      best = stationName(g.nameEn || g.name);
    }
  }
  for (const p of bundle.places) {
    if (!(p[5] & 4) || !p[7]) continue; // parks and gardens with an area
    const d = metres(at, { lat: p[0] / 1e5, lon: p[1] / 1e5 });
    if (d < 600 && d < bestScore) {
      bestScore = d;
      best = p[4] || p[3];
    }
  }
  if (best) return best;
  return bundledPlaceName(bundle, lat, lon).label;
}

/** Place candidates (see places.candidatesFrom) within radius metres. */
export function bundledPlacesNear(bundle, lat, lon, radius = 1200, lang = 'en') {
  const out = [];
  const dLat = radius / 111320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  for (const p of bundle.places) {
    const plat = p[0] / 1e5;
    const plon = p[1] / 1e5;
    if (Math.abs(plat - lat) > dLat || Math.abs(plon - lon) > dLon) continue;
    const [category, kind] = bundle.kinds[p[2]];
    const id = p[6];
    out.push({
      id: `${id[0] === 'w' ? 'way' : id[0] === 'r' ? 'relation' : 'node'}/${id.slice(1)}`,
      category,
      kind,
      name: (lang === 'en' && p[4]) || p[3],
      lat: plat,
      lon: plon,
      area: p[7] || 0,
      notable: !!(p[5] & 1),
      details: !!(p[5] & 2),
      park: !!(p[5] & 4),
    });
  }
  return out;
}
