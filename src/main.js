import { decodeGraph, finalizeGraph } from './graph.js';
import { makeProjection, projectPolygons, geojsonPolygons, ringsBounds, ringsArea, simplifyFlat, landOutline, PolygonIndex } from './geo.js';
import { solveTogether, separateFloods } from './search.js';
import { buildTimeline } from './timeline.js';
import { Renderer, STAGE_W, STAGE_H, FONT_SANS, FONT_MONO } from './renderer.js';
import { searchCities, lookupCity, searchPlaces, neighbourhoodName, landmarkName, overpassQuery } from './osm.js';
import { CanvasRecorder, recordingSupported } from './recorder.js';

const COLORS = ['#ff4fa3', '#34e3b0', '#4d7cff', '#ff7a5c', '#b56cff', '#ffd23f'];
const NAMES = ['Alex', 'Sam', 'Maya', 'Leo', 'Nina', 'Omar'];
const MIN_FRIENDS = 2;
const MAX_FRIENDS = 6;
const PRESETS = [{ id: 'tokyo', name: 'Tokyo', subtitle: '23 special wards' }];
// Largest area (km²) we will ask Overpass for at each level of detail.
const AREA_LIMIT = { all: 1500, main: 5000, major: 15000 };

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const renderer = new Renderer(canvas);

const state = {
  city: null,
  graph: null,
  friends: [],
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
  meetToken: 0,
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

// ---------------------------------------------------------------------------
// cities

async function loadPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  setStatus(`Loading the ${preset ? preset.name : id} road network…`);
  const [meta, buf] = await Promise.all([
    fetch(`data/${id}.json`).then((r) => {
      if (!r.ok) throw new Error(`Could not load data/${id}.json (${r.status})`);
      return r.json();
    }),
    fetch(`data/${id}.tmpo`).then((r) => {
      if (!r.ok) throw new Error(`Could not load data/${id}.tmpo (${r.status})`);
      return r.arrayBuffer();
    }),
  ]);
  const graph = await decodeGraph(buf);
  setCity(
    { id, name: meta.name, subtitle: meta.subtitle, outline: meta.outline, defaults: meta.friends },
    graph,
  );
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

async function loadOsmCity(place, detailChoice) {
  const polys = geojsonPolygons(place.geojson);
  const [s, n, w, e] = place.bbox;
  const lon0 = +((w + e) / 2).toFixed(5);
  const lat0 = +((s + n) / 2).toFixed(5);
  const proj = makeProjection(lon0, lat0);
  const km2 = polygonsAreaKm2(polys, proj);
  const detail = detailChoice === 'auto' ? autoDetail(km2) : detailChoice;
  if (!detail || km2 > AREA_LIMIT[detail]) {
    throw new Error(
      `${place.label} covers about ${Math.round(km2).toLocaleString()} km², which is too much to download${
        detail && detail !== 'major' ? ' at this level of detail. Try "Major roads"' : '. Try a smaller city or a district'
      }.`,
    );
  }

  const label = { all: 'all streets', main: 'main roads', major: 'major roads' }[detail];
  setStatus(`Downloading ${label} for ${place.label}…`);
  const graph = await buildInWorker(
    { query: overpassQuery(place, detail), polygons: polys, lon0, lat0 },
    (msg) => {
      if (msg.stage === 'download') setStatus(`Downloading ${label} for ${place.label}… ${(msg.bytes / 1e6).toFixed(1)} MB`);
      else if (msg.stage === 'parse') setStatus('Reading the road data…');
      else setStatus(`Building the road graph… ${Math.round(msg.fraction * 100)}%`);
    },
  );

  // Follow the shore rather than an admin line out at sea; fall back to the
  // boundary's outer rings (holes read better as plain dark gaps).
  let outline = [];
  try {
    outline = landOutline(graph, new PolygonIndex(projectPolygons(polys, proj)));
  } catch (err) {
    console.warn('Could not trace the city outline:', err);
  }
  if (!outline.length) {
    const rings = projectPolygons(polys.map((p) => [p[0]]), proj);
    const b = ringsBounds(rings);
    const tol = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) * 0.0007;
    outline = rings.map((r) => simplifyFlat(r, tol)).filter((r) => r.length >= 8);
  }
  setCity(
    {
      id: `osm:${place.osmType}:${place.osmId}`,
      name: place.label,
      subtitle: `${graph.nEdges.toLocaleString()} roads · ${label}`,
      outline,
      osm: place,
      detail,
    },
    graph,
  );
}

function setCity(city, graph) {
  city.outlineBounds = ringsBounds(city.outline);
  // the outline may be missing or tiny for odd places; fall back to the roads
  if (!(city.outlineBounds.maxX > city.outlineBounds.minX)) city.outlineBounds = graph.bounds;
  const b = city.outlineBounds;
  const [w, s] = graph.proj.inv(b.minX, b.minY);
  const [e, n] = graph.proj.inv(b.maxX, b.maxY);
  city.bbox = [w, s, e, n];
  state.city = city;
  state.graph = graph;
  renderer.setCity(city, graph);
  renderCityOptions();
}

// ---------------------------------------------------------------------------
// friends

function snapFriend(f) {
  const g = state.graph;
  const [x, y] = g.proj.fwd(f.lon, f.lat);
  f.node = g.grid.nearest(x, y);
  [f.lon, f.lat] = g.proj.inv(g.nodeX[f.node], g.nodeY[f.node]);
}

function nextColor() {
  return COLORS.find((c) => !state.friends.some((f) => f.color === c)) || COLORS[state.friends.length % COLORS.length];
}

function nextName() {
  return NAMES.find((n) => !state.friends.some((f) => f.name === n)) || `Friend ${state.friends.length + 1}`;
}

/** Spread friends around the city when it has no defaults of its own. */
function spreadFriends(count, names) {
  const b = state.city.outlineBounds;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const rx = ((b.maxX - b.minX) / 2) * 0.6;
  const ry = ((b.maxY - b.minY) / 2) * 0.6;
  const g = state.graph;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / count + Math.PI / 4;
    const node = g.grid.nearest(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    const [lon, lat] = g.proj.inv(g.nodeX[node], g.nodeY[node]);
    out.push({ name: names[i] || NAMES[i], place: '', lon, lat, node, color: COLORS[i] });
  }
  return out;
}

function setFriends(list) {
  state.friends.length = 0;
  for (const f of list) state.friends.push(f);
  state.friends.forEach((f, i) => {
    f.color ||= COLORS[i % COLORS.length];
    snapFriend(f);
  });
  state.selected = -1;
}

function fillPlaceNames(friends) {
  for (const f of friends) {
    if (f.place) continue;
    const token = (f.placeToken = (f.placeToken || 0) + 1);
    const stale = () => f.placeToken !== token || !state.friends.includes(f);
    neighbourhoodName(f.lat, f.lon, stale)
      .then((name) => {
        if (stale() || !name) return;
        f.place = name;
        renderFriends();
        draw();
        writeHash();
      })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// solving

let separateTimer = 0;

function compute() {
  const g = state.graph;
  const sources = state.friends.map((f) => f.node);
  state.result = solveTogether(g, sources);
  renderer.setResult(state.result, state.friends);
  rebuildTimeline();
  renderResult();
  requestMeetName();
  writeHash();
  // the one-by-one floods are only needed for playback; compute them when idle
  clearTimeout(separateTimer);
  separateTimer = setTimeout(ensureSeparate, 120);
}

function ensureSeparate() {
  const res = state.result;
  if (!res || !state.showSeparate || res.separate.length) return;
  const atEnd = state.timeline && state.t >= state.timeline.duration - 1e-3;
  res.separate = separateFloods(state.graph, state.friends.map((f) => f.node));
  renderer.setResult(res, state.friends);
  rebuildTimeline();
  if (atEnd) state.t = state.timeline.duration;
  draw();
}

function rebuildTimeline() {
  const old = state.timeline;
  const frac = old ? state.t / old.duration : 0;
  state.timeline = buildTimeline(state.result, state.friends, {
    separate: state.showSeparate,
    speed: state.speed,
  });
  state.t = Math.min(state.timeline.duration, frac * state.timeline.duration);
  $('scrub').max = state.timeline.duration;
}

function requestMeetName() {
  const res = state.result;
  const token = ++state.meetToken;
  state.meetName = '';
  if (!res || res.meet < 0) return;
  const g = state.graph;
  const [lon, lat] = g.proj.inv(g.nodeX[res.meet], g.nodeY[res.meet]);
  state.meetLookup = 'loading';
  renderResult();
  landmarkName(lat, lon, () => token !== state.meetToken)
    .then((name) => {
      if (token !== state.meetToken) return;
      state.meetName = name;
      state.meetLookup = 'done';
      renderResult();
      draw();
    })
    .catch((err) => {
      if (token !== state.meetToken) return;
      console.warn('Could not name the meeting point:', err);
      state.meetLookup = 'failed';
      renderResult();
    });
}

// ---------------------------------------------------------------------------
// playback

let lastFrame = 0;

function draw() {
  const ui = { selected: state.selected, meetName: state.meetName };
  if (state.editing || !state.timeline) {
    if (state.selected >= 0 && !state.drag) ui.hint = `Click the map to move ${state.friends[state.selected].name}`;
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
  if (state.timeline) {
    $('scrub').value = state.t;
    $('time').textContent = `${state.t.toFixed(1)}s`;
  }
}

// ---------------------------------------------------------------------------
// panel

function renderCityOptions() {
  const sel = $('city');
  sel.innerHTML = '';
  for (const p of PRESETS) sel.add(new Option(`${p.name} · ${p.subtitle}`, p.id));
  if (state.city && !PRESETS.some((p) => p.id === state.city.id)) {
    sel.add(new Option(`${state.city.name} · ${state.city.subtitle}`, state.city.id));
  }
  if (state.city) sel.value = state.city.id;
}

const ICONS = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/**
 * Updates the friends list in place, so open place searches and the field
 * being typed in survive background updates. Rows are only rebuilt when
 * friends are added or removed.
 */
function renderFriends() {
  const list = $('friends');
  if (list.children.length !== state.friends.length) {
    list.innerHTML = '';
    state.friends.forEach(() => {
      const li = document.createElement('li');
      li.className = 'friend';
      li.innerHTML = `
        <button class="swatch"></button>
        <div class="fields">
          <input class="name" type="text" aria-label="Name" maxlength="18">
          <input class="place" type="text" aria-label="Place label" placeholder="Place" maxlength="32">
        </div>
        <button class="icon locate">${ICONS.search}</button>
        <button class="icon remove">${ICONS.remove}</button>`;
      list.appendChild(li);
    });
  }
  state.friends.forEach((f, i) => {
    const li = list.children[i];
    li.dataset.i = i;
    li.classList.toggle('selected', state.selected === i);
    li.style.setProperty('--c', f.color);
    const swatch = li.querySelector('.swatch');
    swatch.title = `Select ${f.name} to move them on the map`;
    swatch.setAttribute('aria-pressed', String(state.selected === i));
    for (const [cls, value] of [['name', f.name], ['place', f.place || '']]) {
      const input = li.querySelector(`input.${cls}`);
      if (document.activeElement !== input && input.value !== value) input.value = value;
    }
    li.querySelector('.locate').title = `Find a place for ${f.name}`;
    const remove = li.querySelector('.remove');
    remove.title = `Remove ${f.name}`;
    remove.disabled = state.friends.length <= MIN_FRIENDS;
  });
  $('add-friend').disabled = state.friends.length >= MAX_FRIENDS || !state.graph;
}

function renderResult() {
  const res = state.result;
  const card = $('result-card');
  if (!res || res.meet < 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const g = state.graph;
  const [lon, lat] = g.proj.inv(g.nodeX[res.meet], g.nodeY[res.meet]);
  const name = $('meet-name');
  name.classList.toggle('loading', !state.meetName);
  name.textContent = state.meetName || (state.meetLookup === 'loading' ? 'Finding a name…' : 'Unnamed spot');
  const osm = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}`;
  const longest = Math.max(...res.paths.map((p) => p.length));
  $('meet-where').innerHTML = `${lat.toFixed(4)}, ${lon.toFixed(4)} · <a href="${osm}" target="_blank" rel="noopener">open map</a> · longest trip ${(longest / 1000).toFixed(1)} km`;

  $('trips').innerHTML = state.friends
    .map(
      (f, i) =>
        `<li style="--c:${f.color}"><span class="dot"></span><span class="who">${escapeHtml(f.name)}</span><b>${(res.paths[i].length / 1000).toFixed(1)} km</b></li>`,
    )
    .join('');
  $('roads-sep').textContent = res.roadsSeparate.toLocaleString('en-US');
  $('roads-tog').textContent = res.roadsTogether.toLocaleString('en-US');
  $('bar-sep').style.width = '100%';
  $('bar-tog').style.width = `${(100 * res.roadsTogether) / res.roadsSeparate}%`;
  const saved = 1 - res.roadsTogether / res.roadsSeparate;
  $('saving').textContent = `Searching together checked ${Math.round(saved * 100)}% fewer roads and stopped as soon as all ${state.friends.length} floods met.`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function selectFriend(i) {
  state.selected = state.selected === i ? -1 : i;
  if (state.selected >= 0) {
    pause();
    state.editing = true;
  } else {
    state.editing = false;
  }
  $('stage-box').classList.toggle('placing', state.selected >= 0);
  renderFriends();
  draw();
}

function commitEdit(moved = []) {
  for (const f of moved) f.place = '';
  compute();
  state.t = state.timeline.duration;
  state.editing = false;
  renderFriends();
  draw();
  fillPlaceNames(moved);
}

function addFriend() {
  if (state.friends.length >= MAX_FRIENDS || !state.graph) return;
  const b = state.city.outlineBounds;
  const g = state.graph;
  // a little off-centre so it does not land on the meeting point
  const node = g.grid.nearest((b.minX + b.maxX) / 2 + (b.maxX - b.minX) * 0.15, (b.minY + b.maxY) / 2 - (b.maxY - b.minY) * 0.2);
  const [lon, lat] = g.proj.inv(g.nodeX[node], g.nodeY[node]);
  const f = { name: nextName(), place: '', lon, lat, node, color: nextColor() };
  state.friends.push(f);
  commitEdit([f]);
  selectFriend(state.friends.length - 1);
}

function removeFriend(i) {
  if (state.friends.length <= MIN_FRIENDS) return;
  state.friends.splice(i, 1);
  state.selected = -1;
  $('stage-box').classList.remove('placing');
  commitEdit();
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
  let bestD = 48;
  state.friends.forEach((f, i) => {
    const d = Math.hypot(renderer.geo.nx[f.node] - sx, renderer.geo.ny[f.node] - sy);
    if (d < bestD) {
      bestD = d;
      best = i;
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
    commitEdit([state.friends[state.selected]]);
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
    commitEdit([state.friends[i]]);
  } else {
    // a click on a marker selects it
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
  if (e.target.closest('.remove')) return removeFriend(i);
  if (e.target.closest('.locate')) return togglePlaceSearch(li, i);
  if (e.target.closest('input') || e.target.closest('.place-search')) return;
  selectFriend(i);
});

$('friends').addEventListener('input', (e) => {
  const li = e.target.closest('.friend');
  if (!li) return;
  const f = state.friends[+li.dataset.i];
  if (e.target.classList.contains('name')) f.name = e.target.value || '?';
  else if (e.target.classList.contains('place')) {
    f.place = e.target.value;
    f.placeToken = (f.placeToken || 0) + 1; // typed by hand; ignore pending lookups
  } else return;
  draw();
  writeHash();
});

$('friends').addEventListener('change', (e) => {
  if (e.target.classList.contains('name')) renderResult();
});

function togglePlaceSearch(li, i) {
  const open = li.querySelector('.place-search');
  if (open) {
    open.remove();
    return;
  }
  const box = document.createElement('form');
  box.className = 'place-search';
  box.innerHTML = `<input type="search" placeholder="Search a place in ${escapeHtml(state.city.name)}…" aria-label="Search a place"><ul class="results" hidden></ul>`;
  li.appendChild(box);
  const input = box.querySelector('input');
  const results = box.querySelector('.results');
  input.focus();
  box.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    results.hidden = false;
    results.innerHTML = '<li class="empty">Searching…</li>';
    try {
      const found = await searchPlaces(q, state.city.bbox);
      if (!found.length) {
        results.innerHTML = '<li class="empty">Nothing found in this city.</li>';
        return;
      }
      results.innerHTML = '';
      for (const p of found) {
        const item = document.createElement('li');
        item.innerHTML = `<button type="button">${escapeHtml(p.label)}<small>${escapeHtml(p.detail)}</small></button>`;
        item.querySelector('button').addEventListener('click', () => {
          const f = state.friends[i];
          f.lat = p.lat;
          f.lon = p.lon;
          f.placeToken = (f.placeToken || 0) + 1; // drop any pending automatic label
          snapFriend(f);
          box.remove();
          commitEdit();
          f.place = p.label;
          renderFriends();
          draw();
          writeHash();
        });
        results.appendChild(item);
      }
    } catch (err) {
      results.innerHTML = `<li class="empty">Search failed: ${escapeHtml(err.message)}</li>`;
    }
  });
}

$('add-friend').addEventListener('click', addFriend);

$('city').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (PRESETS.some((p) => p.id === id)) await switchCity(() => loadPreset(id));
});

$('city-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('city-q').value.trim();
  if (!q) return;
  const list = $('city-results');
  list.hidden = false;
  list.innerHTML = '<li class="empty">Searching…</li>';
  try {
    const found = await searchCities(q);
    if (!found.length) {
      list.innerHTML = '<li class="empty">No city with a boundary found. Try another spelling.</li>';
      return;
    }
    list.innerHTML = '';
    for (const c of found) {
      const item = document.createElement('li');
      item.innerHTML = `<button type="button">${escapeHtml(c.label)}<small>${escapeHtml(c.detail)}</small></button>`;
      item.querySelector('button').addEventListener('click', () => {
        list.hidden = true;
        switchCity(() => loadOsmCity(c, $('detail').value));
      });
      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = `<li class="empty">Search failed: ${escapeHtml(err.message)}</li>`;
  }
});

async function switchCity(load, friends = null) {
  pause();
  const prev = { city: state.city, graph: state.graph };
  const names = state.friends.map((f) => f.name);
  state.loading = true;
  $('city-note').textContent = '';
  $('city-note').classList.remove('error');
  try {
    await load();
    if (friends) setFriends(friends);
    else if (state.city.defaults) setFriends(state.city.defaults.map((f) => ({ ...f })));
    else setFriends(spreadFriends(Math.max(MIN_FRIENDS, names.length || 4), names));
    state.t = 0;
    state.timeline = null;
    compute();
    renderFriends();
    fillPlaceNames(state.friends);
    hideStatus();
    state.loading = false;
    writeHash();
    play();
  } catch (err) {
    console.error(err);
    state.loading = false;
    if (prev.city) {
      // stay on the previous city
      state.city = prev.city;
      state.graph = prev.graph;
      renderer.setCity(prev.city, prev.graph);
      renderer.setResult(state.result, state.friends);
      renderCityOptions();
      hideStatus();
      draw();
      $('city-note').textContent = err.message;
      $('city-note').classList.add('error');
    } else {
      setStatus(err.message, { error: true });
    }
  }
}

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
    $('record-note').textContent = 'Link copied. It opens this city with these friends.';
  } catch {
    $('record-note').textContent = location.href;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
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
  $('record-note').textContent = 'Video recording is not supported in this browser.';
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
    $('record-note').textContent = `Could not start recording: ${err.message}`;
    return;
  }
  state.recording.start();
  $('record').textContent = 'Stop recording';
  $('record').classList.add('recording');
  $('record-note').textContent = 'Recording… keep this tab visible until it finishes.';
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
  const name = `tempo-${state.city.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${rec.ext}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  $('record-note').innerHTML = `Saved <a href="${url}" download="${name}">${name}</a> (${(blob.size / 1e6).toFixed(1)} MB, 1080×1920).`;
}

// ---------------------------------------------------------------------------
// shareable links: #city=tokyo&f=name,place,lat,lon;...

function writeHash() {
  if (!state.city || state.loading) return;
  const parts = [`city=${encodeURIComponent(state.city.id)}`];
  if (state.city.detail) parts.push(`detail=${state.city.detail}`);
  parts.push(
    'f=' +
      state.friends
        .map((f) => [f.name, f.place || '', f.lat.toFixed(5), f.lon.toFixed(5)].map(encodeURIComponent).join(','))
        .join(';'),
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
      .map(([name, place, lat, lon], i) => ({ name, place, lat: +lat, lon: +lon, color: COLORS[i] }));
    if (friends.length < MIN_FRIENDS) friends = null;
  }
  return { city: out.city ? decodeURIComponent(out.city) : null, detail: out.detail, friends };
}

// ---------------------------------------------------------------------------
// start

async function loadFonts() {
  const faces = [`900 68px ${FONT_SANS}`, `800 62px ${FONT_SANS}`, `700 36px ${FONT_SANS}`, `600 32px ${FONT_SANS}`, `500 23px ${FONT_SANS}`, `700 52px ${FONT_MONO}`];
  const timeout = new Promise((r) => setTimeout(r, 2500));
  try {
    await Promise.race([Promise.all(faces.map((f) => document.fonts.load(f))), timeout]);
  } catch {
    /* system fonts are fine */
  }
}

async function start() {
  renderCityOptions();
  renderFriends();
  setStatus('Loading…');
  await loadFonts();
  const hash = readHash();
  if (hash.city && hash.city.startsWith('osm:')) {
    const [, type, id] = hash.city.split(':');
    await switchCity(async () => {
      setStatus('Looking up the city…');
      const place = await lookupCity(type, id);
      await loadOsmCity(place, hash.detail || 'auto');
    }, hash.friends);
    if (!state.graph) {
      // fall back to the bundled city
      await switchCity(() => loadPreset(PRESETS[0].id));
    }
  } else {
    const id = PRESETS.some((p) => p.id === hash.city) ? hash.city : PRESETS[0].id;
    await switchCity(() => loadPreset(id), hash.friends);
  }
}

start();
