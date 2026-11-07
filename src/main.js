import { decodeGraph, finalizeGraph } from './graph.js';
import { makeProjection, projectPolygons, geojsonPolygons, ringsBounds, ringsArea, simplifyFlat, landOutline, PolygonIndex, haversine } from './geo.js';
import { solveTogether, separateFloods, dijkstra } from './search.js';
import { buildTimeline } from './timeline.js';
import { Renderer, STAGE_W, STAGE_H, FONT_SANS, FONT_MONO } from './renderer.js';
import { lookupCity, geocode, suggest, placeName, landmarkName, overpassQuery, overpass, isLive, setOffline, stationName } from './osm.js';
import { CATEGORIES, placesQuery, candidatesFrom, candidatesFromTiles, rankCandidates } from './places.js';
import { fetchTiles, decodeLayer, tileLonLat } from './tiles.js';
import { loadBundle, searchGazetteer, bundledPlaceName, bundledLandmark, bundledPlacesNear } from './offline.js';
import { CanvasRecorder, recordingSupported } from './recorder.js';
import { dataPath, fetchBytes } from './files.js';

// One colour per friend, like the lines on a transit map.
const LINE_COLORS = [
  '#e8524a', '#2bb3a3', '#3d8fe0', '#d16fb0', '#8fb83c', '#a585d6',
  '#5fc0e8', '#d9c25a', '#b0705a', '#ee8fa8', '#9aa3b5', '#d4d97a',
];
const MIN_FRIENDS = 2;
const MAX_FRIENDS = 12;
const PRESETS = [{ id: 'tokyo', name: 'Tokyo' }];
// Largest area (km²) to download at each level of detail.
const AREA_LIMIT = { all: 1500, main: 5000, major: 15000 };
// Friends further apart than this are not one meetup.
const MAX_SPAN_KM = 120;

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const renderer = new Renderer(canvas);
renderer.nameOf = (f) => displayName(f);
const lang = (navigator.language || 'en').slice(0, 2);
// Published as a claude.ai artifact: the page may not call other sites, so
// it runs on the bundled Tokyo data and saves files through the viewer.
const EMBED = !!window.TEMPO_EMBED;
// where the full version lives, for any city (set by the artifact build)
const WEB_URL = window.TEMPO_WEB_URL || '';
if (EMBED) setOffline();

const state = {
  city: null,
  graph: null,
  outlineIndex: null,
  friends: [],
  active: [],
  result: null,
  timeline: null,
  t: 0,
  playing: false,
  speed: 1,
  showSeparate: true,
  selected: -1,
  editing: false,
  drag: null,
  meetName: '',
  meetLookup: 'idle',
  meetToken: 0,
  places: null,
  placesState: 'idle',
  placesTab: 'eat',
  placesToken: 0,
  recording: null,
  loading: false,
};

// ---------------------------------------------------------------------------
// status overlay

function setStatus(text, { error = false } = {}) {
  $('status').hidden = false;
  $('status').classList.toggle('error', error);
  $('status-text').textContent = text;
}

function hideStatus() {
  $('status').hidden = true;
}

function setNote(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle('error', error);
}

// ---------------------------------------------------------------------------
// areas: a bundled city, a city boundary from OpenStreetMap, or a box around everyone

const presetMeta = new Map();

async function loadPresetMeta(id) {
  if (!presetMeta.has(id)) {
    presetMeta.set(
      id,
      fetch(`data/${id}.json`).then((r) => {
        if (!r.ok) throw new Error(`Could not load data/${id}.json (${r.status})`);
        return r.json();
      }),
    );
  }
  return presetMeta.get(id);
}

async function loadPreset(id) {
  setStatus(`Loading the ${PRESETS.find((p) => p.id === id)?.name || id} streets`);
  const [meta, buf] = await Promise.all([
    loadPresetMeta(id),
    fetchBytes(dataPath(`${id}.tmpo`)),
  ]);
  const graph = await decodeGraph(buf);
  setCity({ id, name: meta.name, outline: meta.outline, defaults: meta.friends }, graph);
}

/** Is every friend inside a bundled city? */
async function presetFor(friends) {
  for (const p of PRESETS) {
    const meta = await loadPresetMeta(p.id).catch(() => null);
    if (!meta) continue;
    const proj = makeProjection(meta.lon0, meta.lat0);
    const index = new PolygonIndex(meta.outline);
    if (friends.every((f) => index.contains(...proj.fwd(f.lon, f.lat)))) return p.id;
  }
  return null;
}

function autoDetail(km2) {
  if (km2 <= 400) return 'all';
  if (km2 <= 2000) return 'main';
  if (km2 <= AREA_LIMIT.major) return 'major';
  return null;
}

function polygonsAreaKm2(polys, proj) {
  let total = 0;
  for (const poly of polys) {
    const rings = projectPolygons([poly], proj);
    total += ringsArea([rings[0]]);
    for (let i = 1; i < rings.length; i++) total -= ringsArea([rings[i]]);
  }
  return total / 1e6;
}

let worker = null;
let jobId = 0;

function buildInWorker(payload, onProgress) {
  worker ??= new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') onProgress(msg);
      else {
        worker.removeEventListener('message', onMessage);
        if (msg.type === 'done') resolve(finalizeGraph(msg.graph));
        else reject(new Error(msg.message));
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, ...payload });
  });
}

/**
 * Loads the streets of a place and builds the graph: from map tiles, which
 * arrive in seconds, falling back to an Overpass extract if they fail.
 */
async function loadArea(place) {
  const polys = geojsonPolygons(place.geojson);
  const [s, n, w, e] = place.bbox;
  const lon0 = +((w + e) / 2).toFixed(5);
  const lat0 = +((s + n) / 2).toFixed(5);
  const proj = makeProjection(lon0, lat0);
  const km2 = polygonsAreaKm2(polys, proj);
  const detail = autoDetail(km2);
  if (!detail) {
    throw new Error(`That area is about ${Math.round(km2).toLocaleString('en-US')} km², too large to load. Tempo works within one city or region.`);
  }

  const progress = (msg) => {
    if (msg.stage === 'tiles') setStatus(`Loading the map around ${place.label}, ${msg.done} of ${msg.total} tiles`);
    else if (msg.stage === 'connect') setStatus('Connecting the streets');
    else if (msg.stage === 'download') setStatus(`Downloading streets around ${place.label}, ${(msg.bytes / 1e6).toFixed(1)} MB`);
    else if (msg.stage === 'parse') setStatus('Reading the street data');
    else setStatus(`Building the street network, ${Math.round(msg.fraction * 100)}%`);
  };
  setStatus(`Loading the map around ${place.label}`);
  let graph;
  try {
    graph = await buildInWorker({ box: [w, s, e, n], polygons: polys, lon0, lat0 }, progress);
  } catch (err) {
    console.warn('Map tiles failed, asking Overpass instead:', err);
    graph = await buildInWorker({ query: overpassQuery(place, detail), polygons: polys, lon0, lat0 }, progress);
  }

  // follow the shore rather than a boundary out at sea
  let outline = [];
  try {
    outline = landOutline(graph, new PolygonIndex(projectPolygons(polys, proj)));
  } catch (err) {
    console.warn('Could not trace the outline:', err);
  }
  if (!outline.length) {
    const rings = projectPolygons(polys.map((p) => [p[0]]), proj);
    const b = ringsBounds(rings);
    const tol = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) * 0.0007;
    outline = rings.map((r) => simplifyFlat(r, tol)).filter((r) => r.length >= 8);
  }
  setCity({ id: place.id, name: place.label, outline, detail }, graph);
}

function cityPlace(c) {
  return { ...c, id: `osm:${c.osmType}:${c.osmId}` };
}

/** A box around every friend, with some room around the edges. */
function boxPlace(friends, name) {
  const lats = friends.map((f) => f.lat);
  const lons = friends.map((f) => f.lon);
  let s = Math.min(...lats), n = Math.max(...lats), w = Math.min(...lons), e = Math.max(...lons);
  const span = haversine(w, s, e, n) / 1000;
  if (span > MAX_SPAN_KM) {
    throw new Error(`These starting points are about ${Math.round(span)} km apart. Tempo works within one city or region, up to about ${MAX_SPAN_KM} km across.`);
  }
  const midLat = (s + n) / 2;
  const padLat = Math.max((n - s) * 0.2, 1500 / 111320);
  const padLon = Math.max((e - w) * 0.2, 1500 / (111320 * Math.cos((midLat * Math.PI) / 180)));
  s -= padLat; n += padLat; w -= padLon; e += padLon;
  const r = (v) => +v.toFixed(4);
  [s, n, w, e] = [r(s), r(n), r(w), r(e)];
  return {
    id: `box:${s},${w},${n},${e}`,
    osmType: 'box',
    label: name,
    bbox: [s, n, w, e],
    geojson: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
}

function boxFromId(id, name) {
  const [s, w, n, e] = id.slice(4).split(',').map(Number);
  return {
    id,
    osmType: 'box',
    label: name,
    bbox: [s, n, w, e],
    geojson: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = '';
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

/** Picks and loads an area that holds every friend, unless the current one does. */
async function ensureArea(friends) {
  if (state.graph && friends.every(insideArea)) return;
  const preset = await presetFor(friends);
  if (preset) {
    if (state.city?.id !== preset) await loadPreset(preset);
    return;
  }
  if (!isLive()) throw new Error('Only Tokyo\u2019s 23 wards can be loaded right now, so every starting point needs to be there.');
  // the streets in a box around everyone: small, and quick to load from tiles
  const city = mostCommon(friends.map((f) => f.city));
  let name = city || mostCommon(friends.map((f) => f.region));
  if (!name) {
    // links shared before carry no city; name the area from its middle
    const lat = friends.reduce((a, f) => a + f.lat, 0) / friends.length;
    const lon = friends.reduce((a, f) => a + f.lon, 0) / friends.length;
    name = (await placeName(lat, lon).catch(() => null))?.city || 'Your meetup';
  }
  await loadArea(boxPlace(friends, name));
}

function insideArea(f) {
  if (!state.graph || f.lat == null) return false;
  const [x, y] = state.graph.proj.fwd(f.lon, f.lat);
  if (state.outlineIndex && state.outlineIndex.contains(x, y)) return true;
  // parks, airports and stations can sit a few hundred metres from a through
  // street; the trip then starts at the nearest one
  const n = state.graph.grid.nearest(x, y);
  return Math.hypot(state.graph.nodeX[n] - x, state.graph.nodeY[n] - y) < 1000;
}

function setCity(city, graph) {
  city.outlineBounds = ringsBounds(city.outline);
  if (!(city.outlineBounds.maxX > city.outlineBounds.minX)) city.outlineBounds = graph.bounds;
  const b = city.outlineBounds;
  const [w, s] = graph.proj.inv(b.minX, b.minY);
  const [e, n] = graph.proj.inv(b.maxX, b.maxY);
  city.bbox = [w, s, e, n];
  state.city = city;
  state.graph = graph;
  state.outlineIndex = city.outline.length ? new PolygonIndex(city.outline) : null;
  renderer.setCity(city, graph);
}

// ---------------------------------------------------------------------------
// bundled data, used for the preset city and whenever live services are out

async function bundle() {
  const id = PRESETS[0].id;
  return loadBundle(id, await loadPresetMeta(id));
}

const onPreset = () => !!state.city && PRESETS.some((p) => p.id === state.city.id);

/** Starting points by name: live search first, then the bundled list. */
async function findPlace(q, near) {
  if (isLive()) {
    try {
      const found = await geocode(q, near);
      if (found.length) return found;
    } catch (err) {
      if (isLive()) throw err;
    }
  }
  return searchGazetteer(await bundle(), q);
}

/** A short name for a point, from the bundle on the preset city. */
async function nameForPoint(lat, lon, stale) {
  if (onPreset()) return bundledPlaceName(await bundle(), lat, lon);
  return placeName(lat, lon, stale);
}

async function meetLandmark(lat, lon, stale) {
  if (onPreset()) return bundledLandmark(await bundle(), lat, lon, stationName);
  return landmarkName(lat, lon, stale);
}

function showCoverage() {
  const el = $('coverage');
  el.hidden = isLive();
  if (EMBED && WEB_URL && !el.querySelector('a')) {
    el.textContent = 'This version searches Tokyo\u2019s 23 wards. ';
    const a = document.createElement('a');
    a.className = 'link';
    a.href = WEB_URL;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open Tempo on the web for any city';
    el.append(a);
  }
}

// ---------------------------------------------------------------------------
// friends

function newFriend(fields = {}) {
  return {
    name: '',
    query: '',
    place: '',
    detail: '',
    lat: null,
    lon: null,
    node: null,
    city: '',
    region: '',
    country: '',
    alts: [],
    status: 'empty',
    token: 0,
    color: nextColor(),
    ...fields,
  };
}

function nextColor() {
  return LINE_COLORS.find((c) => !state.friends.some((f) => f.color === c)) || LINE_COLORS[state.friends.length % LINE_COLORS.length];
}

function displayName(f) {
  return f.name.trim() || `Friend ${state.friends.indexOf(f) + 1}`;
}

/** Short label for the map: what they typed when it is short, else the geocoder's name. */
function shortPlace(query, label) {
  const q = query.trim();
  return q && q.length <= 28 ? q : label;
}

function located(f) {
  return f.lat != null && f.lon != null && f.status === 'found';
}

function snap(f) {
  const g = state.graph;
  const [x, y] = g.proj.fwd(f.lon, f.lat);
  f.node = g.grid.nearest(x, y);
}

/** Bounds to favour when geocoding: the current map, else where the others are. */
function searchBias() {
  if (state.city) return state.city.bbox || null;
  const done = state.friends.filter(located);
  if (!done.length) return null;
  const lats = done.map((f) => f.lat);
  const lons = done.map((f) => f.lon);
  return [Math.min(...lons) - 0.2, Math.min(...lats) - 0.2, Math.max(...lons) + 0.2, Math.max(...lats) + 0.2];
}

/** Where the other friends are, to rank suggestions near them first. */
function friendsCentre(except) {
  const others = state.friends.filter((f) => f !== except && located(f));
  if (!others.length) return null;
  return [others.reduce((a, f) => a + f.lat, 0) / others.length, others.reduce((a, f) => a + f.lon, 0) / others.length];
}

/** Matches for what was typed: Photon as you type, the bundled list offline. */
async function suggestFor(q, f, signal) {
  if (isLive()) {
    try {
      return await suggest(q, { near: friendsCentre(f), signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('Suggestions failed:', err);
    }
  }
  return searchGazetteer(await bundle(), q, 6);
}

const near = (a, b, metres) =>
  Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180)) < metres;

/**
 * Turns typed text into a place without guessing: one clear match is used,
 * several matches ask the person to choose.
 */
async function resolveFriend(f, { quiet = false } = {}) {
  const q = f.query.trim();
  const token = ++f.token;
  closeSuggestions(f);
  if (!q) {
    Object.assign(f, { status: 'empty', lat: null, lon: null, node: null, place: '', detail: '', alts: [] });
    renderFriends();
    return;
  }
  f.status = 'pending';
  renderFriends();
  try {
    let results = await suggestFor(q, f);
    if (!results.length) results = await findPlace(q, searchBias());
    if (token !== f.token) return;
    if (!results.length) {
      Object.assign(f, { status: 'missing', alts: [] });
    } else if (results.every((r) => near(r, results[0], 300))) {
      useResult(f, results[0]);
      f.alts = [];
    } else {
      Object.assign(f, { status: 'choose', alts: results, lat: null, lon: null, node: null });
    }
  } catch (err) {
    if (token !== f.token) return;
    console.warn('Geocoding failed:', err);
    f.status = 'error';
  }
  renderFriends();
  showCoverage();
  if (!quiet && f.status === 'found') afterMove(f);
}

function pick(f, r) {
  f.token++;
  f.query = r.label;
  useResult(f, r);
  f.alts = [];
  closeSuggestions(f);
  renderFriends();
  // the field keeps its focus, so set what it shows here
  const input = rowOf(f)?.querySelector('.where');
  if (input) input.value = f.query;
  afterMove(f);
}

// ---------------------------------------------------------------------------
// suggestions while typing

function rowOf(f) {
  return $('friends').children[state.friends.indexOf(f)];
}

function closeSuggestions(f) {
  clearTimeout(f.suggestTimer);
  f.suggestAbort?.abort();
  f.suggestions = [];
  f.active = -1;
  const li = rowOf(f);
  if (li) renderSuggestions(li, f);
}

function scheduleSuggestions(f) {
  clearTimeout(f.suggestTimer);
  if (f.query.trim().length < 3) {
    closeSuggestions(f);
    return;
  }
  f.suggestTimer = setTimeout(() => loadSuggestions(f), isLive() ? 250 : 60);
}

async function loadSuggestions(f) {
  const q = f.query.trim();
  f.suggestAbort?.abort();
  const ctl = new AbortController();
  f.suggestAbort = ctl;
  try {
    const results = await suggestFor(q, f, ctl.signal);
    if (ctl.signal.aborted || f.query.trim() !== q || f.status === 'found') return;
    f.suggestions = results;
    f.active = results.length ? 0 : -1;
  } catch (err) {
    if (err.name === 'AbortError') return;
    f.suggestions = [];
  }
  const li = rowOf(f);
  if (li && document.activeElement === li.querySelector('.where')) renderSuggestions(li, f);
}

function renderSuggestions(li, f) {
  const ul = li.querySelector('.suggest');
  const input = li.querySelector('.where');
  const list = f.suggestions || [];
  ul.innerHTML = '';
  list.forEach((r, k) => {
    const item = document.createElement('li');
    item.id = `${ul.id}-${k}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(k === f.active));
    item.dataset.k = k;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = r.label;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = r.sub ?? r.detail;
    item.append(label, sub);
    ul.appendChild(item);
  });
  ul.hidden = !list.length;
  input.setAttribute('aria-expanded', String(!!list.length));
  if (f.active >= 0 && list.length) input.setAttribute('aria-activedescendant', `${ul.id}-${f.active}`);
  else input.removeAttribute('aria-activedescendant');
}

function useResult(f, r) {
  Object.assign(f, {
    status: 'found',
    lat: r.lat,
    lon: r.lon,
    place: shortPlace(f.query, r.label),
    detail: r.detail,
    city: r.city,
    region: r.region,
    country: r.country,
    node: null,
  });
}

/** A friend has new coordinates: update straight away when they are on this map. */
function afterMove(f) {
  if (!located(f)) return;
  if (insideArea(f)) {
    commitEdit();
  } else {
    setNote('find-note', `${f.place || displayName(f)} is outside this map. Find where to meet loads the area around everyone.`);
  }
}

function fillPlaceName(f) {
  const token = ++f.token;
  const stale = () => f.token !== token || !state.friends.includes(f);
  nameForPoint(f.lat, f.lon, stale)
    .then((r) => {
      if (stale() || !r.label) return;
      f.place = r.label;
      f.query = r.label;
      f.detail = '';
      if (r.city) f.city = r.city;
      renderFriends();
      draw();
      writeHash();
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// solving

let separateTimer = 0;
let placesTimer = 0;

function compute() {
  const g = state.graph;
  state.active = state.friends.filter((f) => located(f) && insideArea(f));
  for (const f of state.active) snap(f);
  clearTimeout(separateTimer);
  clearTimeout(placesTimer);
  if (state.active.length < MIN_FRIENDS) {
    state.result = null;
    state.timeline = null;
    renderer.result = null;
    renderer.friends = state.active;
    renderResult();
    renderPlaces();
    return;
  }
  state.result = solveTogether(g, state.active.map((f) => f.node));
  renderer.setResult(state.result, state.active);
  rebuildTimeline();
  renderResult();
  requestMeetName();
  writeHash();
  // the one-by-one floods are only needed for playback; compute them when idle
  separateTimer = setTimeout(ensureSeparate, 150);
  placesTimer = setTimeout(loadPlaces, 500);
}

function ensureSeparate() {
  const res = state.result;
  if (!res || !state.showSeparate || res.separate.length) return;
  const atEnd = state.timeline && state.t >= state.timeline.duration - 1e-3;
  res.separate = separateFloods(state.graph, state.active.map((f) => f.node));
  renderer.setResult(res, state.active);
  rebuildTimeline();
  if (atEnd) state.t = state.timeline.duration;
  draw();
}

function rebuildTimeline() {
  if (!state.result) return;
  const old = state.timeline;
  const frac = old ? state.t / old.duration : 0;
  state.timeline = buildTimeline(state.result, state.active.map((f) => ({ name: displayName(f) })), {
    separate: state.showSeparate,
    speed: state.speed,
  });
  state.t = Math.min(state.timeline.duration, frac * state.timeline.duration);
  $('scrub').max = state.timeline.duration;
}

function meetLonLat() {
  const g = state.graph;
  const m = state.result.meet;
  return g.proj.inv(g.nodeX[m], g.nodeY[m]);
}

function requestMeetName() {
  const res = state.result;
  const token = ++state.meetToken;
  state.meetName = '';
  if (!res || res.meet < 0) return;
  const [lon, lat] = meetLonLat();
  state.meetLookup = 'loading';
  renderResult();
  meetLandmark(lat, lon, () => token !== state.meetToken)
    .then((name) => {
      if (token !== state.meetToken) return;
      state.meetName = name;
      state.meetLookup = 'done';
      renderResult();
      draw();
    })
    .catch((err) => {
      if (token !== state.meetToken) return;
      if (err.message !== 'stale') console.warn('Could not name the meeting point:', err);
      state.meetLookup = 'failed';
      renderResult();
    });
}

// ---------------------------------------------------------------------------
// things to do

async function loadPlaces() {
  const res = state.result;
  if (!res || res.meet < 0) return;
  const token = ++state.placesToken;
  const [lon, lat] = meetLonLat();
  state.placesState = 'loading';
  state.places = null;
  renderPlaces();
  const walk = dijkstra(state.graph, res.meet).dist;
  const show = (candidates) => {
    if (token !== state.placesToken) return;
    state.places = rankCandidates(candidates, { graph: state.graph, walk });
    state.placesState = 'done';
    renderPlaces();
    draw();
  };

  // the preset city carries its own places
  if (onPreset()) {
    try {
      show(bundledPlacesNear(await bundle(), lat, lon, 1200, lang));
    } catch (err) {
      failPlaces(token, err);
    }
    return;
  }

  // elsewhere: the map tiles' places at once, then Overpass's richer ones
  // (cuisines, landmarks) merged in if they arrive
  let fromTiles = [];
  let richer = false;
  const tilesJob = placesFromTiles(lat, lon).then((c) => {
    fromTiles = c;
    if (!richer) show(c);
  });
  const overpassJob = overpass(placesQuery(lat, lon, 1200)).then((d) => {
    richer = true;
    show([...candidatesFrom(d.elements || [], lang), ...fromTiles]);
  });
  const outcomes = await Promise.allSettled([tilesJob, overpassJob]);
  if (outcomes.every((o) => o.status === 'rejected')) failPlaces(token, outcomes[0].reason);
}

function failPlaces(token, err) {
  if (token !== state.placesToken) return;
  console.warn('Could not load places:', err);
  state.placesState = 'error';
  renderPlaces();
  draw();
}

/** Named places from the poi layer of the z14 tiles around a point. */
async function placesFromTiles(lat, lon, radius = 1200) {
  if (!isLive()) throw new Error('offline');
  const dLat = radius / 111320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const tiles = await fetchTiles([lon - dLon, lat - dLat, lon + dLon, lat + dLat], 14);
  for (const t of tiles) t.layer = decodeLayer(t.bytes, 'poi', 1);
  return candidatesFromTiles(tiles, tileLonLat, lang);
}

function renderPlaces() {
  const box = $('todo');
  if (!state.result || state.result.meet < 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const [lon, lat] = meetLonLat();
  $('todo-map').href = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=16/${lat.toFixed(5)}/${lon.toFixed(5)}`;

  const tabs = $('tabs');
  tabs.innerHTML = '';
  for (const c of CATEGORIES) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.setAttribute('role', 'tab');
    b.dataset.tab = c.id;
    b.setAttribute('aria-selected', String(state.placesTab === c.id));
    b.textContent = c.label;
    if (state.places) {
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = state.places[c.id].length;
      b.appendChild(n);
    }
    tabs.appendChild(b);
  }

  const list = $('places');
  list.innerHTML = '';
  if (state.placesState === 'loading') {
    setNote('places-note', 'Looking for places within a short walk');
    return;
  }
  if (state.placesState === 'error') {
    $('places-note').innerHTML = 'Could not reach the OpenStreetMap place search. <button class="link" id="places-retry">Try again</button>';
    $('places-note').classList.add('error');
    return;
  }
  const items = state.places ? state.places[state.placesTab] : [];
  if (!items.length) {
    setNote('places-note', 'Nothing of this kind is mapped within a short walk. The lit streets nearby may have more.');
    return;
  }
  setNote('places-note', 'Walking times from the meeting point, along the streets');
  for (const p of items) {
    const li = document.createElement('li');
    li.innerHTML = `<a href="${p.url}" target="_blank" rel="noopener"><span class="name"></span><span class="kind"></span><span class="walk">${p.minutes} min</span></a>`;
    li.querySelector('.name').textContent = p.name;
    li.querySelector('.kind').textContent = p.kind;
    list.appendChild(li);
  }
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  state.placesTab = b.dataset.tab;
  renderPlaces();
});

$('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const ids = CATEGORIES.map((c) => c.id);
  const i = ids.indexOf(state.placesTab);
  state.placesTab = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
  renderPlaces();
  $('tabs').querySelector(`[data-tab="${state.placesTab}"]`)?.focus();
});

$('places-note').addEventListener('click', (e) => {
  if (e.target.id === 'places-retry') loadPlaces();
});

// ---------------------------------------------------------------------------
// playback

let lastFrame = 0;

function picks() {
  if (!state.places) return [];
  return CATEGORIES.map((c) => ({ label: c.label, top: state.places[c.id][0] }))
    .filter((p) => p.top)
    .map((p) => ({ label: p.label, name: p.top.name, minutes: p.top.minutes }));
}

function draw() {
  const selectedFriend = state.friends[state.selected];
  const ui = { selected: state.active.indexOf(selectedFriend), meetName: state.meetName, picks: picks() };
  if (state.editing || !state.timeline) {
    if (selectedFriend && !state.drag) ui.hint = `Click the map to move ${displayName(selectedFriend)}`;
    renderer.draw(null, 0, ui);
  } else {
    renderer.draw(state.timeline, state.t, ui);
  }
  updateTransport();
}

function play() {
  if (!state.timeline || state.loading) return;
  ensureSeparate();
  if (state.t >= state.timeline.duration - 1e-3) state.t = 0;
  state.editing = false;
  state.playing = true;
  lastFrame = performance.now();
  requestAnimationFrame(tick);
  updateTransport();
}

function pause() {
  state.playing = false;
  updateTransport();
}

function tick(now) {
  if (!state.playing) return;
  // rAF timestamps can predate a long task that ran just before play()
  const dt = Math.max(0, Math.min(0.1, (now - lastFrame) / 1000));
  lastFrame = now;
  state.t = Math.min(state.timeline.duration, state.t + dt);
  draw();
  if (state.t >= state.timeline.duration) {
    state.playing = false;
    updateTransport();
    onEnded();
  } else {
    requestAnimationFrame(tick);
  }
}

function seek(t) {
  state.t = Math.max(0, Math.min(state.timeline.duration, t));
  state.editing = false;
  draw();
}

function updateTransport() {
  $('play').classList.toggle('playing', state.playing);
  $('play').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  $('play').disabled = !state.timeline;
  if (state.timeline) {
    $('scrub').value = state.t;
    $('time').textContent = `${state.t.toFixed(1)} s`;
  }
}

// ---------------------------------------------------------------------------
// panel

const ICONS = {
  remove: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/**
 * Updates the friends list in place, so the field being typed in keeps its
 * focus. Rows are rebuilt only when friends are added or removed.
 */
function renderFriends() {
  const list = $('friends');
  if (list.children.length !== state.friends.length) {
    list.innerHTML = '';
    state.friends.forEach(() => {
      const li = document.createElement('li');
      li.className = 'friend';
      li.innerHTML = `
        <button class="line-chip"></button>
        <input class="name" type="text" placeholder="Name" maxlength="18" autocomplete="off">
        <input class="where" type="text" placeholder="Starting point" maxlength="80" autocomplete="off" enterkeyhint="search" role="combobox" aria-autocomplete="list" aria-expanded="false">
        <button class="icon remove">${ICONS.remove}</button>
        <p class="status"></p>
        <ul class="alts" hidden></ul>
        <ul class="suggest" role="listbox" hidden></ul>`;
      list.appendChild(li);
    });
  }
  state.friends.forEach((f, i) => {
    const li = list.children[i];
    li.dataset.i = i;
    li.style.setProperty('--c', f.color);
    li.classList.toggle('selected', state.selected === i);
    li.classList.toggle('missing', f.status === 'missing' || f.status === 'error');
    const name = displayName(f);
    const chip = li.querySelector('.line-chip');
    chip.setAttribute('aria-label', `Move ${name} on the map`);
    chip.setAttribute('aria-pressed', String(state.selected === i));
    chip.disabled = !located(f) || !insideArea(f);
    const nameInput = li.querySelector('.name');
    nameInput.setAttribute('aria-label', `Friend ${i + 1} name`);
    nameInput.placeholder = `Friend ${i + 1}`;
    if (document.activeElement !== nameInput && nameInput.value !== f.name) nameInput.value = f.name;
    const where = li.querySelector('.where');
    where.setAttribute('aria-label', `${name}'s starting point`);
    const suggestList = li.querySelector('.suggest');
    suggestList.id = `suggest-${i}`;
    suggestList.setAttribute('aria-label', `Places matching ${name}'s starting point`);
    where.setAttribute('aria-controls', suggestList.id);
    if (document.activeElement !== where && where.value !== f.query) where.value = f.query;
    const remove = li.querySelector('.remove');
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.disabled = state.friends.length <= MIN_FRIENDS;

    // always one line tall, so buttons below never move while a lookup runs
    const status = li.querySelector('.status');
    status.innerHTML = '';
    const text = document.createElement('span');
    if (f.status === 'pending') text.textContent = 'Looking up';
    else if (f.status === 'missing')
      text.textContent = isLive()
        ? 'No match. Try adding the city.'
        : WEB_URL
          ? 'Not found in Tokyo. The web version works in any city.'
          : 'Not found. Try a station or neighbourhood in Tokyo.';
    else if (f.status === 'error') text.textContent = 'The place search is not answering. Try again in a moment.';
    else if (f.status === 'found') text.textContent = f.detail && f.detail !== f.query ? f.detail : '';
    else if (f.status === 'choose') text.textContent = `${f.alts.length} places match. Choose one`;
    else if (f.status === 'typing') text.textContent = 'Choose a match from the list';
    else text.textContent = 'Street, station or place';
    status.appendChild(text);
    if (f.status === 'found' && f.alts.length) {
      const alt = document.createElement('button');
      alt.className = 'link alt-toggle';
      alt.textContent = 'Not this one';
      status.appendChild(alt);
    }
    li.classList.toggle('choosing', f.status === 'choose');
    const alts = li.querySelector('.alts');
    if (f.status === 'choose') {
      alts.innerHTML = '';
      f.alts.forEach((r, k) => {
        const item = document.createElement('li');
        const b = document.createElement('button');
        b.dataset.k = k;
        b.className = 'choice';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = r.label;
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = r.sub ?? r.detail;
        b.append(label, sub);
        item.appendChild(b);
        alts.appendChild(item);
      });
      alts.hidden = false;
    } else if (alts.querySelector('.choice')) {
      alts.hidden = true;
      alts.innerHTML = '';
    }
    renderSuggestions(li, f);
  });
  $('add-friend').disabled = state.friends.length >= MAX_FRIENDS;
  $('friend-count').textContent = `${state.friends.length} of ${MAX_FRIENDS}`;
}

function toggleAlts(li, f) {
  const ul = li.querySelector('.alts');
  if (!ul.hidden) {
    ul.hidden = true;
    return;
  }
  ul.innerHTML = '';
  for (const r of f.alts) {
    const item = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = r.detail;
    b.addEventListener('click', () => {
      const previous = { label: f.place, detail: f.detail, lat: f.lat, lon: f.lon, city: f.city, region: f.region, country: f.country };
      useResult(f, r);
      f.alts = [previous, ...f.alts.filter((a) => a !== r)];
      ul.hidden = true;
      renderFriends();
      afterMove(f);
    });
    item.appendChild(b);
    ul.appendChild(item);
  }
  ul.hidden = false;
}

function renderResult() {
  const res = state.result;
  const card = $('result');
  if (!res || res.meet < 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('meet-name').textContent = state.meetName
    ? `Around ${state.meetName}`
    : state.meetLookup === 'loading'
      ? 'Finding a name for the spot'
      : 'The fairest spot for everyone';
  const longest = Math.max(...res.paths.map((p) => p.length));
  $('meet-zone').textContent = `On the lit streets nobody travels more than ${(res.zoneLimit / 1000).toFixed(1)} km. At the centre the longest trip is ${(longest / 1000).toFixed(1)} km.`;

  const trips = $('trips');
  trips.innerHTML = '';
  state.active.forEach((f, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', f.color);
    if ((res.paths[i].length / 1000).toFixed(1) === (longest / 1000).toFixed(1)) li.classList.add('longest');
    li.innerHTML = '<span class="chip"></span><span class="who"><strong></strong> <span></span></span><b></b>';
    li.querySelector('strong').textContent = displayName(f);
    li.querySelector('.who span').textContent = f.place ? `from ${f.place}` : '';
    li.querySelector('b').textContent = `${(res.paths[i].length / 1000).toFixed(1)} km`;
    trips.appendChild(li);
  });

  $('roads-sep').textContent = res.roadsSeparate.toLocaleString('en-US');
  $('roads-tog').textContent = res.roadsTogether.toLocaleString('en-US');
  $('bar-sep').style.width = '100%';
  $('bar-tog').style.width = `${(100 * res.roadsTogether) / res.roadsSeparate}%`;
  const saved = 1 - res.roadsTogether / res.roadsSeparate;
  $('saving').textContent = `${Math.round(saved * 100)}% fewer, because the search stops as soon as all ${state.active.length} floods reach the same junction`;
}

function selectFriend(i) {
  state.selected = state.selected === i ? -1 : i;
  state.editing = state.selected >= 0;
  if (state.editing) pause();
  $('stage-box').classList.toggle('placing', state.selected >= 0);
  renderFriends();
  draw();
}

/** Recompute after a change and show the final frame. */
function commitEdit() {
  setNote('find-note', '');
  compute();
  if (state.timeline) state.t = state.timeline.duration;
  state.editing = false;
  renderFriends();
  draw();
}

function addFriend() {
  if (state.friends.length >= MAX_FRIENDS) return;
  state.friends.push(newFriend());
  renderFriends();
  $('friends').lastElementChild.querySelector('.name').focus();
}

function removeFriend(i) {
  if (state.friends.length <= MIN_FRIENDS) return;
  const [f] = state.friends.splice(i, 1);
  state.selected = -1;
  $('stage-box').classList.remove('placing');
  renderFriends();
  if (state.active.includes(f)) commitEdit();
  else writeHash();
}

/** The main action: look up anything new, load the area, solve and play. */
async function findMeeting() {
  if (state.loading) return;
  pause();
  setNote('find-note', '');
  const pending = state.friends.filter((f) => f.query.trim() && f.status !== 'found' && f.status !== 'choose');
  for (const f of pending) await resolveFriend(f, { quiet: true });
  const unsure = state.friends.filter((f) => f.status === 'choose');
  if (unsure.length) {
    setNote('find-note', `Choose which place you mean for ${unsure.map(displayName).join(', ')}`, true);
    rowOf(unsure[0])?.querySelector('.choice')?.focus();
    return;
  }
  const ready = state.friends.filter(located);
  if (ready.length < MIN_FRIENDS) {
    setNote('find-note', 'Add at least two starting points that can be found on the map', true);
    return;
  }
  const missing = state.friends.filter((f) => f.query.trim() && !located(f));
  state.loading = true;
  $('find').disabled = true;
  try {
    await ensureArea(ready);
    state.selected = -1;
    state.t = 0;
    state.timeline = null;
    compute();
    hideStatus();
    state.loading = false;
    renderFriends();
    writeHash();
    if (missing.length) setNote('find-note', `Left out ${missing.map(displayName).join(', ')}, whose starting point was not found`);
    // on phones the stage sits below the form
    if (matchMedia('(max-width: 880px)').matches) $('stage-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
    play();
  } catch (err) {
    console.error(err);
    state.loading = false;
    hideStatus();
    setNote('find-note', err.message, true);
    draw();
  } finally {
    $('find').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// stage interaction

function stagePoint(e) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * STAGE_W, ((e.clientY - r.top) / r.height) * STAGE_H];
}

function hitFriend(sx, sy) {
  if (!renderer.geo) return -1;
  let best = -1;
  let bestD = 44;
  state.active.forEach((f) => {
    const d = Math.hypot(renderer.geo.nx[f.node] - sx, renderer.geo.ny[f.node] - sy);
    if (d < bestD) {
      bestD = d;
      best = state.friends.indexOf(f);
    }
  });
  return best;
}

function moveFriend(i, sx, sy) {
  const g = state.graph;
  const [x, y] = renderer.toWorld(sx, sy);
  const f = state.friends[i];
  f.node = g.grid.nearest(x, y);
  [f.lon, f.lat] = g.proj.inv(g.nodeX[f.node], g.nodeY[f.node]);
  f.status = 'found';
  f.alts = [];
}

canvas.addEventListener('pointerdown', (e) => {
  if (state.recording || state.loading || !state.graph) return;
  const [sx, sy] = stagePoint(e);
  const hit = hitFriend(sx, sy);
  if (hit >= 0) {
    pause();
    state.drag = { i: hit, id: e.pointerId, moved: false };
    state.selected = hit;
    state.editing = true;
    canvas.setPointerCapture(e.pointerId);
    $('stage-box').classList.add('dragging');
    renderFriends();
    draw();
    return;
  }
  if (state.selected >= 0) {
    moveFriend(state.selected, sx, sy);
    const f = state.friends[state.selected];
    commitEdit();
    fillPlaceName(f);
  }
});

canvas.addEventListener('pointermove', (e) => {
  const [sx, sy] = stagePoint(e);
  if (state.drag && state.drag.id === e.pointerId) {
    state.drag.moved = true;
    moveFriend(state.drag.i, sx, sy);
    draw();
    return;
  }
  $('stage-box').classList.toggle('grab', hitFriend(sx, sy) >= 0);
});

function endDrag(e) {
  if (!state.drag || state.drag.id !== e.pointerId) return;
  const { i, moved } = state.drag;
  state.drag = null;
  $('stage-box').classList.remove('dragging');
  if (moved) {
    state.selected = -1;
    $('stage-box').classList.remove('placing');
    const f = state.friends[i];
    commitEdit();
    fillPlaceName(f);
  } else {
    // a click on a marker selects it, so the next click on the map moves it
    $('stage-box').classList.toggle('placing', state.selected >= 0);
    renderFriends();
    draw();
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------------------
// panel events

$('friends').addEventListener('click', (e) => {
  const li = e.target.closest('.friend');
  if (!li) return;
  const i = +li.dataset.i;
  const f = state.friends[i];
  if (e.target.closest('.remove')) return removeFriend(i);
  if (e.target.closest('.line-chip')) return selectFriend(i);
  if (e.target.closest('.alt-toggle')) return toggleAlts(li, f);
  const choice = e.target.closest('.choice');
  if (choice) return pick(f, f.alts[+choice.dataset.k]);
});

// a suggestion is picked on mousedown, before the field loses focus
$('friends').addEventListener('mousedown', (e) => {
  const option = e.target.closest('.suggest [role="option"]');
  if (!option) return;
  e.preventDefault();
  const f = state.friends[+e.target.closest('.friend').dataset.i];
  pick(f, f.suggestions[+option.dataset.k]);
});

$('friends').addEventListener('focusout', (e) => {
  if (!e.target.classList.contains('where')) return;
  const f = state.friends[+e.target.closest('.friend').dataset.i];
  if (f) closeSuggestions(f);
});

$('friends').addEventListener('input', (e) => {
  const li = e.target.closest('.friend');
  if (!li) return;
  const f = state.friends[+li.dataset.i];
  if (e.target.classList.contains('name')) {
    f.name = e.target.value;
    rebuildTimeline();
    draw();
    renderResult();
    writeHash();
  } else if (e.target.classList.contains('where')) {
    f.query = e.target.value;
    f.token++; // whatever was being looked up is out of date
    const typed = f.query.trim() ? 'typing' : 'empty';
    if (f.status !== typed) {
      Object.assign(f, { status: typed, lat: null, lon: null, node: null, alts: [] });
      renderFriends();
    }
    scheduleSuggestions(f);
  }
});

// text left without choosing from the list is looked up when the field is left
$('friends').addEventListener('change', (e) => {
  if (!e.target.classList.contains('where')) return;
  const f = state.friends[+e.target.closest('.friend').dataset.i];
  if (f.status === 'found' && e.target.value === f.query) return;
  resolveFriend(f);
});

$('friends').addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('where')) return;
  const li = e.target.closest('.friend');
  const f = state.friends[+li.dataset.i];
  const open = f.suggestions && f.suggestions.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) {
      if (f.query.trim().length >= 3) loadSuggestions(f);
      return;
    }
    e.preventDefault();
    const n = f.suggestions.length;
    f.active = (f.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderSuggestions(li, f);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && f.active >= 0) pick(f, f.suggestions[f.active]);
    else e.target.blur();
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    closeSuggestions(f);
  }
});

$('add-friend').addEventListener('click', addFriend);
$('find').addEventListener('click', findMeeting);
$('example').addEventListener('click', () => loadExample());

$('play').addEventListener('click', () => (state.playing ? pause() : play()));

$('scrub').addEventListener('input', (e) => {
  if (!state.timeline || state.recording) return;
  // read before pause(), which syncs the slider back to the current time
  const frac = +e.target.value / state.timeline.duration;
  pause();
  ensureSeparate();
  seek(frac * state.timeline.duration);
});

$('speed').addEventListener('change', (e) => {
  state.speed = +e.target.value;
  if (state.result) {
    rebuildTimeline();
    draw();
  }
});

$('show-separate').addEventListener('change', (e) => {
  state.showSeparate = e.target.checked;
  if (!state.result) return;
  pause();
  ensureSeparate();
  rebuildTimeline();
  state.t = 0;
  draw();
});

$('share').addEventListener('click', async () => {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    setNote('record-note', 'Link copied. It opens these starting points on this map.');
  } catch {
    setNote('record-note', location.href);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, button')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    state.playing ? pause() : play();
  } else if (e.key === 'Escape' && state.selected >= 0) {
    selectFriend(state.selected);
  }
});

// ---------------------------------------------------------------------------
// recording

if (!recordingSupported()) {
  $('record').disabled = true;
  setNote('record-note', 'This browser cannot record the canvas to video');
}

$('record').addEventListener('click', async () => {
  if (state.recording) {
    finishRecording();
    return;
  }
  if (!state.timeline) return;
  pause();
  ensureSeparate();
  state.t = 0;
  state.selected = -1;
  $('stage-box').classList.remove('placing');
  draw();
  try {
    state.recording = new CanvasRecorder(canvas, 60);
  } catch (err) {
    setNote('record-note', `Could not start recording: ${err.message}`, true);
    return;
  }
  state.recording.start();
  $('record').textContent = 'Stop recording';
  $('record').classList.add('recording');
  setNote('record-note', 'Recording. Keep this tab visible until it finishes.');
  play();
});

function onEnded() {
  if (state.recording) setTimeout(finishRecording, 500);
}

async function finishRecording() {
  const rec = state.recording;
  if (!rec) return;
  state.recording = null;
  pause();
  const blob = await rec.stop();
  $('record').textContent = 'Record video';
  $('record').classList.remove('recording');
  const name = `tempo-${state.city.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'meetup'}.${rec.ext}`;
  if (EMBED) return saveThroughViewer(blob, name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  $('record-note').classList.remove('error');
  $('record-note').innerHTML = `Saved <a class="link" href="${url}" download="${name}">${name}</a>, ${(blob.size / 1e6).toFixed(1)} MB at 1080 × 1920`;
}

/** In an artifact the viewer saves files for the page, after asking. */
async function saveThroughViewer(blob, name) {
  const downloads = await window.claude?.use?.('downloads');
  if (!downloads) {
    setNote('record-note', 'Saving files is not available in this view.', true);
    return;
  }
  try {
    await downloads.save({ filename: name, data: blob });
    setNote('record-note', `Saved ${name}, ${(blob.size / 1e6).toFixed(1)} MB at 1080 × 1920`);
  } catch (err) {
    if (err.code === 'declined') setNote('record-note', 'Not saved');
    else setNote('record-note', `Could not save the video (${err.code || err.message}).`, true);
  }
}

// ---------------------------------------------------------------------------
// shareable links: #area=tokyo&name=Tokyo&f=name,place,lat,lon;...

function writeHash() {
  if (!state.city || state.loading || EMBED) return;
  const parts = [`area=${encodeURIComponent(state.city.id)}`, `name=${encodeURIComponent(state.city.name)}`];
  const list = state.friends.filter(located);
  parts.push(
    'f=' + list.map((f) => [f.name, f.query || f.place || '', f.lat.toFixed(5), f.lon.toFixed(5)].map(encodeURIComponent).join(',')).join(';'),
  );
  history.replaceState(null, '', `#${parts.join('&')}`);
}

function readHash() {
  const out = {};
  for (const kv of location.hash.slice(1).split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  let friends = null;
  if (out.f) {
    friends = out.f
      .split(';')
      .map((s) => s.split(',').map(decodeURIComponent))
      .filter((a) => a.length === 4 && isFinite(+a[2]) && isFinite(+a[3]))
      .slice(0, MAX_FRIENDS)
      .map(([name, query, lat, lon], i) => ({
        name,
        query,
        place: shortPlace(query, query),
        lat: +lat,
        lon: +lon,
        status: 'found',
        color: LINE_COLORS[i],
      }));
    if (friends.length < MIN_FRIENDS) friends = null;
  }
  const area = out.area || out.city; // "city" was used by earlier links
  return { area: area ? decodeURIComponent(area) : null, name: out.name ? decodeURIComponent(out.name) : '', friends };
}

// ---------------------------------------------------------------------------
// start

async function loadFonts() {
  const faces = [`500 60px ${FONT_SANS}`, `400 32px ${FONT_SANS}`, `500 52px ${FONT_MONO}`, `400 22px ${FONT_SANS}`];
  const timeout = new Promise((r) => setTimeout(r, 2500));
  try {
    await Promise.race([Promise.all(faces.map((f) => document.fonts.load(f))), timeout]);
  } catch {
    /* system fonts are fine */
  }
}

function setFriends(list) {
  state.friends.length = 0;
  list.forEach((f, i) => state.friends.push(newFriend({ ...f, color: f.color || LINE_COLORS[i % LINE_COLORS.length] })));
  state.selected = -1;
}

async function loadExample() {
  pause();
  state.loading = true;
  try {
    await loadPreset('tokyo');
    const meta = await loadPresetMeta('tokyo');
    setFriends(meta.friends.map((f) => ({ name: f.name, query: f.place, place: f.place, lat: f.lat, lon: f.lon, status: 'found' })));
    state.t = 0;
    state.timeline = null;
    compute();
    renderFriends();
    hideStatus();
    state.loading = false;
    writeHash();
    play();
  } catch (err) {
    state.loading = false;
    setStatus(err.message, { error: true });
  }
}

async function start() {
  // two empty rows to type into, even if nothing else loads
  setFriends([{}, {}]);
  renderFriends();
  if (EMBED) {
    // links here cannot carry the meetup, and saving goes through the viewer
    $('share').hidden = true;
    window.claude?.use?.('downloads').then((d) => {
      if (!d) {
        $('record').hidden = true;
        setNote('record-note', 'Recording a video is not available in this view.');
      }
    });
  }
  showCoverage();
  setStatus('Loading');
  await loadFonts();
  const hash = readHash();
  if (!hash.friends) return loadExample();

  setFriends(hash.friends);
  renderFriends();
  state.loading = true;
  try {
    if (hash.area && PRESETS.some((p) => p.id === hash.area)) await loadPreset(hash.area);
    else if (hash.area && hash.area.startsWith('box:')) await loadArea(boxFromId(hash.area, hash.name || 'Your meetup'));
    else if (hash.area && hash.area.startsWith('osm:')) {
      const [, type, id] = hash.area.split(':');
      setStatus('Looking up the area');
      await loadArea(cityPlace(await lookupCity(type, id)));
    } else await ensureArea(state.friends.filter(located));
    state.t = 0;
    compute();
    hideStatus();
    state.loading = false;
    renderFriends();
    play();
  } catch (err) {
    console.error(err);
    state.loading = false;
    hideStatus();
    setNote('find-note', `Could not open this link: ${err.message}`, true);
    await loadExample();
  }
}

// opt-in hook for automated tests: ?debug
if (new URLSearchParams(location.search).has('debug')) window.__tempo = { state, renderer };

start();
