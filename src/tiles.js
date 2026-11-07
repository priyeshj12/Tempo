// Streets from vector map tiles (OpenFreeMap, OpenMapTiles schema).
//
// Tiles come from a CDN and arrive in a second or two, where a custom
// Overpass extract of the same area can take a minute. The price is that
// tiles simplify lines and cut them at tile edges, so junctions are rebuilt
// here: ends that meet are merged, ends that touch a road are snapped onto
// it, and roads that cross at street level are split. Bridges and tunnels
// only connect at their ends.

export const TILEJSON = 'https://tiles.openfreemap.org/planet';

// OpenMapTiles transportation classes walked or driven on to meet someone.
const CLASSES = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'minor']);

const MAX_TILES = 96;

// ---------------------------------------------------------------------------
// tile maths

export function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}

export function tileLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/** Tiles covering a [west, south, east, north] box at zoom z. */
export function tilesForBox([w, s, e, n], z) {
  const [x0, y0] = tileXY(w, n, z);
  const [x1, y1] = tileXY(e, s, z);
  const out = [];
  for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
    for (let y = Math.floor(y0); y <= Math.floor(y1); y++) out.push({ z, x, y });
  }
  return out;
}

/** The most detailed zoom (14 at most) that covers the box in few enough tiles. */
export function chooseZoom(box, maxTiles = MAX_TILES) {
  for (let z = 14; z > 9; z--) if (tilesForBox(box, z).length <= maxTiles) return z;
  return 9;
}

// ---------------------------------------------------------------------------
// a small protobuf reader for Mapbox Vector Tiles

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  varint() {
    let v = 0;
    let mul = 1;
    let b;
    do {
      b = this.buf[this.pos++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unknown wire type ${wire}`);
  }

  bytes() {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string() {
    return new TextDecoder().decode(this.bytes());
  }
}

function readValue(buf) {
  const r = new Reader(buf);
  let v = null;
  while (r.pos < buf.length) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1) v = r.string();
    else if (field === 2) {
      v = new DataView(buf.buffer, buf.byteOffset + r.pos, 4).getFloat32(0, true);
      r.pos += 4;
    } else if (field === 3) {
      v = new DataView(buf.buffer, buf.byteOffset + r.pos, 8).getFloat64(0, true);
      r.pos += 8;
    } else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) {
      const z = r.varint();
      v = z % 2 ? -(z + 1) / 2 : z / 2;
    } else if (field === 7) v = !!r.varint();
    else r.skip(wire);
  }
  return v;
}

function packed(buf) {
  const r = new Reader(buf);
  const out = [];
  while (r.pos < buf.length) out.push(r.varint());
  return out;
}

/** Line geometry commands -> [[x0, y0, x1, y1, ...], ...] in tile units. */
function decodeLines(cmds) {
  const lines = [];
  let line = null;
  let x = 0;
  let y = 0;
  for (let i = 0; i < cmds.length; ) {
    const c = cmds[i++];
    const id = c & 7;
    const count = c >> 3;
    if (id === 7) continue;
    for (let k = 0; k < count; k++) {
      const dx = cmds[i++];
      const dy = cmds[i++];
      x += dx % 2 ? -(dx + 1) / 2 : dx / 2;
      y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
      if (id === 1) {
        line = [x, y];
        lines.push(line);
      } else if (line) {
        line.push(x, y);
      }
    }
  }
  return lines.filter((l) => l.length >= 4);
}

/** Point geometry commands -> [x0, y0, x1, y1, ...] in tile units. */
function decodePoints(cmds) {
  const out = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < cmds.length; ) {
    const c = cmds[i++];
    const count = c >> 3;
    for (let k = 0; k < count; k++) {
      const dx = cmds[i++];
      const dy = cmds[i++];
      x += dx % 2 ? -(dx + 1) / 2 : dx / 2;
      y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
      out.push(x, y);
    }
  }
  return out;
}

/** Decodes one layer of a tile: lines (type 2) or points (type 1). */
export function decodeLayer(bytes, name, type = 2) {
  const r = new Reader(bytes);
  while (r.pos < bytes.length) {
    const tag = r.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) {
      r.skip(tag & 7);
      continue;
    }
    const layer = r.bytes();
    const lr = new Reader(layer);
    let layerName = '';
    let extent = 4096;
    const keys = [];
    const values = [];
    const raw = [];
    while (lr.pos < layer.length) {
      const t = lr.varint();
      const f = t >> 3;
      if (f === 1) layerName = lr.string();
      else if (f === 2) raw.push(lr.bytes());
      else if (f === 3) keys.push(lr.string());
      else if (f === 4) values.push(readValue(lr.bytes()));
      else if (f === 5) extent = lr.varint();
      else lr.skip(t & 7);
    }
    if (layerName !== name) continue;
    const features = [];
    const wanted = type;
    for (const fb of raw) {
      const fr = new Reader(fb);
      let type = 0;
      let tags = [];
      let geom = [];
      while (fr.pos < fb.length) {
        const t = fr.varint();
        const f = t >> 3;
        if (f === 2) tags = packed(fr.bytes());
        else if (f === 3) type = fr.varint();
        else if (f === 4) geom = packed(fr.bytes());
        else fr.skip(t & 7);
      }
      if (type !== wanted) continue;
      const props = {};
      for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      // lines and polygon rings share one encoding; points have their own
      features.push(type === 1 ? { props, points: decodePoints(geom) } : { props, lines: decodeLines(geom) });
    }
    return { extent, features };
  }
  return { extent: 4096, features: [] };
}

// ---------------------------------------------------------------------------
// from tiles to a set of connected polylines

/** Cuts a polyline to the box [0, E] x [0, E]; returns the pieces inside. */
function clipLine(pts, E) {
  const out = [];
  let cur = null;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    let x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3];
    // Liang-Barsky
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    let ok = true;
    for (const [p, q] of [[-dx, x0], [dx, E - x0], [-dy, y0], [dy, E - y0]]) {
      if (p === 0) {
        if (q < 0) ok = false;
      } else {
        const t = q / p;
        if (p < 0) {
          if (t > t1) ok = false;
          else if (t > t0) t0 = t;
        } else if (t < t0) ok = false;
        else if (t < t1) t1 = t;
      }
    }
    if (!ok) {
      cur = null;
      continue;
    }
    const ax = x0 + dx * t0, ay = y0 + dy * t0, bx = x0 + dx * t1, by = y0 + dy * t1;
    if (!cur || t0 > 0) {
      cur = [ax, ay];
      out.push(cur);
    }
    cur.push(bx, by);
    if (t1 < 1) cur = null;
  }
  return out.filter((l) => l.length >= 4);
}

/**
 * Turns decoded tiles into connected polylines in projected metres.
 *
 * @param {Array} tiles  [{z, x, y, layer: {extent, features}}]
 * @param {object} proj  projection from geo.makeProjection
 * @returns {{ways: number[][], nodes: Float64Array}}  ways are lists of node
 *          indices into nodes ([x0, y0, x1, y1, ...]); shared indices are junctions
 */
export function connectTiles(tiles, proj) {
  // 1. polylines in metres, cut to their tile so neighbours meet at the seam
  const lines = [];
  let pixel = 0.5;
  for (const t of tiles) {
    const E = t.layer.extent;
    for (const f of t.layer.features) {
      const cls = f.props.class;
      if (!CLASSES.has(cls)) continue;
      const brunnel = f.props.brunnel === 'bridge' || f.props.brunnel === 'tunnel';
      const level = f.props.layer || 0;
      for (const raw of f.lines) {
        for (const piece of clipLine(raw, E)) {
          const pts = new Array(piece.length);
          for (let i = 0; i < piece.length; i += 2) {
            const [lon, lat] = tileLonLat(t.x + piece[i] / E, t.y + piece[i + 1] / E, t.z);
            const [px, py] = proj.fwd(lon, lat);
            pts[i] = px;
            pts[i + 1] = py;
          }
          lines.push({ pts, brunnel, level });
        }
      }
    }
    // size of one tile pixel in metres, for the snapping tolerance
    const [lonA, latA] = tileLonLat(t.x, t.y, t.z);
    const [lonB] = tileLonLat(t.x + 1, t.y, t.z);
    const [ax] = proj.fwd(lonA, latA);
    const [bx] = proj.fwd(lonB, latA);
    pixel = Math.max(pixel, Math.abs(bx - ax) / E);
  }
  const tol = Math.max(1, pixel * 2.5);

  // 2. merge line ends that sit within tol of each other (tile seams, junctions)
  const cell = Math.max(tol * 4, 20);
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const ends = [];
  lines.forEach((l, li) => {
    ends.push({ li, at: 0 }, { li, at: l.pts.length - 2 });
  });
  const endGrid = new Map();
  ends.forEach((e, ei) => {
    const k = key(lines[e.li].pts[e.at], lines[e.li].pts[e.at + 1]);
    if (!endGrid.has(k)) endGrid.set(k, []);
    endGrid.get(k).push(ei);
  });
  const parent = ends.map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  ends.forEach((e, ei) => {
    const x = lines[e.li].pts[e.at];
    const y = lines[e.li].pts[e.at + 1];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const ej of endGrid.get(`${i},${j}`) || []) {
          if (ej <= ei) continue;
          const o = ends[ej];
          if (Math.hypot(lines[o.li].pts[o.at] - x, lines[o.li].pts[o.at + 1] - y) <= tol) {
            const a = find(ei);
            const b = find(ej);
            if (a !== b) parent[a] = b;
          }
        }
      }
    }
  });
  const sum = new Map();
  ends.forEach((e, ei) => {
    const r = find(ei);
    const s = sum.get(r) || [0, 0, 0];
    s[0] += lines[e.li].pts[e.at];
    s[1] += lines[e.li].pts[e.at + 1];
    s[2]++;
    sum.set(r, s);
  });
  const clustered = new Uint8Array(ends.length);
  ends.forEach((e, ei) => {
    const s = sum.get(find(ei));
    lines[e.li].pts[e.at] = s[0] / s[2];
    lines[e.li].pts[e.at + 1] = s[1] / s[2];
    if (s[2] > 1) clustered[ei] = 1;
  });

  // 3. index segments
  const segs = []; // [lineIndex, pointIndex]
  const segGrid = new Map();
  lines.forEach((l, li) => {
    for (let i = 0; i + 3 < l.pts.length; i += 2) {
      const si = segs.length;
      segs.push(li, i);
      const x0 = Math.min(l.pts[i], l.pts[i + 2]) - tol;
      const x1 = Math.max(l.pts[i], l.pts[i + 2]) + tol;
      const y0 = Math.min(l.pts[i + 1], l.pts[i + 3]) - tol;
      const y1 = Math.max(l.pts[i + 1], l.pts[i + 3]) + tol;
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
          const k = `${cx},${cy}`;
          if (!segGrid.has(k)) segGrid.set(k, []);
          segGrid.get(k).push(si / 2);
        }
      }
    }
  });
  // extra points to insert into segments: segment index -> [t, x, y][]
  const inserts = new Map();
  const addInsert = (s, t, x, y) => {
    if (!inserts.has(s)) inserts.set(s, []);
    inserts.get(s).push([t, x, y]);
  };
  const segPts = (s) => {
    const li = segs[s * 2];
    const i = segs[s * 2 + 1];
    const p = lines[li].pts;
    return [p[i], p[i + 1], p[i + 2], p[i + 3], li, i];
  };

  // 4. a lone end touching another road is snapped onto it (T-junctions whose
  //    shared point the tiles simplified away)
  ends.forEach((e, ei) => {
    if (clustered[ei]) return;
    const l = lines[e.li];
    const x = l.pts[e.at];
    const y = l.pts[e.at + 1];
    let best = null;
    let bestD = tol;
    for (const s of segGrid.get(key(x, y)) || []) {
      const [ax, ay, bx, by, li, i] = segPts(s);
      if (li === e.li && (i === e.at || i + 2 === e.at || i === e.at - 2)) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-12;
      let t = ((x - ax) * dx + (y - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d = Math.hypot(px - x, py - y);
      if (d <= bestD) {
        bestD = d;
        best = [s, t, px, py];
      }
    }
    if (best) {
      const [s, t, px, py] = best;
      l.pts[e.at] = px;
      l.pts[e.at + 1] = py;
      addInsert(s, t, px, py);
    }
  });

  // 5. roads crossing at street level meet there
  const seen = new Set();
  for (const [k, list] of segGrid) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const s1 = list[a];
        const s2 = list[b];
        const [ax, ay, bx, by, l1, i1] = segPts(s1);
        const [cx, cy, dx, dy, l2, i2] = segPts(s2);
        if (l1 === l2 && Math.abs(i1 - i2) <= 2) continue;
        const L1 = lines[l1];
        const L2 = lines[l2];
        if (L1.brunnel || L2.brunnel || L1.level !== L2.level) continue;
        const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
        const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
        if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) continue;
        const px = ax + t * rx;
        const py = ay + t * ry;
        if (key(px, py) !== k) continue; // count each crossing in one cell only
        const pair = s1 < s2 ? `${s1}:${s2}` : `${s2}:${s1}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        addInsert(s1, t, px, py);
        addInsert(s2, u, px, py);
      }
    }
  }

  // 6. rebuild lines with the extra points and give every point an id
  const ids = new Map();
  const coords = [];
  const q = (v) => Math.round(v * 20); // 5 cm
  const idOf = (x, y) => {
    const k = `${q(x)},${q(y)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = coords.length / 2;
      ids.set(k, id);
      coords.push(x, y);
    }
    return id;
  };
  const ways = [];
  let s = 0;
  lines.forEach((l) => {
    const way = [idOf(l.pts[0], l.pts[1])];
    for (let i = 0; i + 3 < l.pts.length; i += 2, s++) {
      const extra = inserts.get(s);
      if (extra) {
        extra.sort((a, b) => a[0] - b[0]);
        for (const [, x, y] of extra) way.push(idOf(x, y));
      }
      way.push(idOf(l.pts[i + 2], l.pts[i + 3]));
    }
    const dedup = way.filter((v, i) => i === 0 || v !== way[i - 1]);
    if (dedup.length >= 2) ways.push(dedup);
  });
  return { ways, nodes: Float64Array.from(coords), tolerance: tol };
}

/** Overpass-shaped elements, so the usual graph builder can take them. */
export function toElements({ ways, nodes }, proj) {
  const els = [];
  for (let i = 0; i < nodes.length / 2; i++) {
    const [lon, lat] = proj.inv(nodes[i * 2], nodes[i * 2 + 1]);
    els.push({ type: 'node', id: i, lon, lat });
  }
  ways.forEach((w, i) => els.push({ type: 'way', id: i, nodes: w }));
  return els;
}

let templateJob = null;

/** The tile URL template of the current map build, looked up once. */
function tileTemplate() {
  templateJob ??= fetch(TILEJSON)
    .then((res) => {
      if (!res.ok) throw new Error(`Map tiles answered ${res.status}`);
      return res.json();
    })
    .then((j) => j.tiles[0]);
  templateJob.catch(() => (templateJob = null));
  return templateJob;
}

/** Downloads the tiles for a box, a few at a time. */
export async function fetchTiles(box, z, { onProgress = () => {}, template = null, concurrency = 12 } = {}) {
  const url = template || (await tileTemplate());
  const list = tilesForBox(box, z);
  let done = 0;
  let next = 0;
  let failed = 0;
  let lastError = null;
  const one = async (t) => {
    const res = await fetch(url.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y));
    if (res.status === 204 || res.status === 404) return new Uint8Array(0);
    if (!res.ok) throw new Error(`Map tiles answered ${res.status}`);
    return gunzipIfNeeded(new Uint8Array(await res.arrayBuffer()));
  };
  const work = async () => {
    while (next < list.length) {
      const t = list[next++];
      // one retry, then go on without the tile rather than lose them all
      try {
        t.bytes = await one(t).catch(() => one(t));
      } catch (err) {
        failed++;
        lastError = err;
        t.bytes = new Uint8Array(0);
      }
      onProgress(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, work));
  if (failed === list.length) throw lastError || new Error('Map tiles could not be loaded');
  return list;
}

async function gunzipIfNeeded(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
