// Geometry helpers shared by the browser app, the worker and the build script.

const EARTH_RADIUS = 6371008.8;
const DEG = Math.PI / 180;

/**
 * Local equirectangular projection in metres around (lon0, lat0).
 * x grows east, y grows north. Accurate to well under 1% across a city.
 */
export function makeProjection(lon0, lat0) {
  const kx = EARTH_RADIUS * Math.cos(lat0 * DEG) * DEG;
  const ky = EARTH_RADIUS * DEG;
  return {
    lon0,
    lat0,
    fwd: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
    inv: (x, y) => [x / kx + lon0, y / ky + lat0],
  };
}

/** Great-circle distance in metres. */
export function haversine(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Douglas-Peucker on a flat [x0, y0, x1, y1, ...] array.
 * Returns a new flat array that always keeps the first and last point.
 */
export function simplifyFlat(pts, tol) {
  const n = pts.length / 2;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack = [0, n - 1];
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    const ax = pts[first * 2], ay = pts[first * 2 + 1];
    const bx = pts[last * 2], by = pts[last * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = pts[i * 2], py = pts[i * 2 + 1];
      let d;
      if (len2 === 0) {
        d = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push(first, idx, idx, last);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/**
 * Converts GeoJSON-like polygon coordinates ([[[lon, lat], ...], ...] per
 * polygon) into projected flat rings: [[x0, y0, x1, y1, ...], ...].
 */
export function projectPolygons(polygons, proj) {
  const rings = [];
  for (const poly of polygons) {
    for (const ring of poly) {
      const flat = new Array(ring.length * 2);
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = proj.fwd(ring[i][0], ring[i][1]);
        flat[i * 2] = x;
        flat[i * 2 + 1] = y;
      }
      rings.push(flat);
    }
  }
  return rings;
}

/** GeoJSON geometry (Polygon or MultiPolygon) -> list of polygons. */
export function geojsonPolygons(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

export function ringsBounds(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < minX) minX = r[i];
      if (r[i] > maxX) maxX = r[i];
      if (r[i + 1] < minY) minY = r[i + 1];
      if (r[i + 1] > maxY) maxY = r[i + 1];
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Signed area of flat rings using the shoelace formula (even-odd sum). */
export function ringsArea(rings) {
  let total = 0;
  for (const r of rings) {
    let a = 0;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      a += (r[j] + r[i]) * (r[j + 1] - r[i + 1]);
    }
    total += a / 2;
  }
  return Math.abs(total);
}

/**
 * Fast point-in-polygon for many queries against the same rings (even-odd
 * rule, so holes and multipolygons just work). Edges are bucketed into
 * horizontal bands so each query only tests a handful of edges.
 */
export class PolygonIndex {
  constructor(rings, bands = 512) {
    const b = ringsBounds(rings);
    this.minY = b.minY;
    this.maxY = b.maxY;
    this.minX = b.minX;
    this.maxX = b.maxX;
    this.bands = bands;
    this.bandH = (b.maxY - b.minY) / bands || 1;
    const buckets = Array.from({ length: bands }, () => []);
    for (const r of rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const x1 = r[j], y1 = r[j + 1], x2 = r[i], y2 = r[i + 1];
        if (y1 === y2) continue;
        const lo = this.band(Math.min(y1, y2));
        const hi = this.band(Math.max(y1, y2));
        for (let k = lo; k <= hi; k++) buckets[k].push(x1, y1, x2, y2);
      }
    }
    this.buckets = buckets.map((a) => Float64Array.from(a));
  }

  band(y) {
    const k = Math.floor((y - this.minY) / this.bandH);
    return k < 0 ? 0 : k >= this.bands ? this.bands - 1 : k;
  }

  contains(x, y) {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
    const e = this.buckets[this.band(y)];
    let inside = false;
    for (let i = 0; i < e.length; i += 4) {
      const x1 = e[i], y1 = e[i + 1], x2 = e[i + 2], y2 = e[i + 3];
      if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
  }
}

/**
 * Outline of where the roads actually are, inside an administrative
 * boundary. Admin boundaries of coastal cities often run far out to sea;
 * this hugs the shore instead. Roads are rasterised onto a coarse grid, the
 * grid is closed (dilate then erode) and holes are filled, then the edge is
 * traced with marching squares and smoothed.
 *
 * @param {object} g          graph (nodeX/nodeY/geomXY/bounds)
 * @param {object} [admin]    PolygonIndex of the boundary, optional
 * @returns {number[][]}      flat rings, largest first
 */
export function landOutline(g, admin = null, cellsAcross = 220) {
  const { minX, minY, maxX, maxY } = g.bounds;
  const size = Math.max(maxX - minX, maxY - minY);
  const cell = size / cellsAcross;
  const pad = 4;
  const W = Math.ceil((maxX - minX) / cell) + pad * 2 + 1;
  const H = Math.ceil((maxY - minY) / cell) + pad * 2 + 1;
  const x0 = minX - pad * cell;
  const y0 = minY - pad * cell;
  let grid = new Uint8Array(W * H);
  const mark = (x, y) => {
    grid[Math.floor((y - y0) / cell) * W + Math.floor((x - x0) / cell)] = 1;
  };
  for (let i = 0; i < g.nNodes; i++) mark(g.nodeX[i], g.nodeY[i]);
  for (let i = 0; i < g.geomXY.length; i += 2) mark(g.geomXY[i], g.geomXY[i + 1]);
  // fill along long straight edges so bridges do not leave gaps
  for (let e = 0; e < g.nEdges; e++) {
    const pts = [g.nodeX[g.edgeU[e]], g.nodeY[g.edgeU[e]]];
    for (let p = g.geomStart[e]; p < g.geomStart[e + 1]; p++) pts.push(g.geomXY[p * 2], g.geomXY[p * 2 + 1]);
    pts.push(g.nodeX[g.edgeV[e]], g.nodeY[g.edgeV[e]]);
    for (let k = 2; k < pts.length; k += 2) {
      const d = Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
      const steps = Math.floor(d / cell);
      for (let s = 1; s < steps; s++) {
        mark(pts[k - 2] + ((pts[k] - pts[k - 2]) * s) / steps, pts[k - 1] + ((pts[k + 1] - pts[k - 1]) * s) / steps);
      }
    }
  }
  const occupied = grid.slice();

  const morph = (src, dilate) => {
    const out = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const n = src[i - W - 1] + src[i - W] + src[i - W + 1] + src[i - 1] + src[i] + src[i + 1] + src[i + W - 1] + src[i + W] + src[i + W + 1];
        out[i] = dilate ? (n > 0 ? 1 : 0) : n === 9 ? 1 : 0;
      }
    }
    return out;
  };
  const r = 3;
  for (let k = 0; k < r; k++) grid = morph(grid, true);
  for (let k = 0; k < r; k++) grid = morph(grid, false);

  if (admin) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (grid[i] && !occupied[i] && !admin.contains(x0 + (x + 0.5) * cell, y0 + (y + 0.5) * cell)) grid[i] = 0;
      }
    }
  }

  // fill holes: anything not reachable from the border is inside
  const outside = new Uint8Array(W * H);
  const stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const i = stack.pop();
    if (outside[i] || grid[i]) continue;
    outside[i] = 1;
    const x = i % W;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (i >= W) stack.push(i - W);
    if (i < W * (H - 1)) stack.push(i + W);
  }
  for (let i = 0; i < W * H; i++) grid[i] = outside[i] ? 0 : 1;

  // marching squares over cell centres
  const segs = new Map();
  const key = (x, y) => `${x},${y}`;
  const add = (a, b) => {
    // edge points are on a half-cell lattice; store as doubled ints
    if (!segs.has(key(...a))) segs.set(key(...a), []);
    segs.get(key(...a)).push(b);
  };
  const v = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? grid[y * W + x] : 0);
  for (let y = -1; y < H; y++) {
    for (let x = -1; x < W; x++) {
      const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
      const code = a | (b << 1) | (c << 2) | (d << 3);
      if (code === 0 || code === 15) continue;
      // midpoints of the four sides, doubled: bottom, right, top, left
      const B = [2 * x + 1, 2 * y], R = [2 * x + 2, 2 * y + 1], T = [2 * x + 1, 2 * y + 2], L = [2 * x, 2 * y + 1];
      // directed so the filled side is on the left
      switch (code) {
        case 1: add(L, B); break;
        case 2: add(B, R); break;
        case 3: add(L, R); break;
        case 4: add(R, T); break;
        case 5: add(L, T); add(R, B); break;
        case 6: add(B, T); break;
        case 7: add(L, T); break;
        case 8: add(T, L); break;
        case 9: add(T, B); break;
        case 10: add(B, L); add(T, R); break;
        case 11: add(T, R); break;
        case 12: add(R, L); break;
        case 13: add(R, B); break;
        case 14: add(B, L); break;
      }
    }
  }

  const rings = [];
  for (const [start, nexts] of segs) {
    while (nexts.length) {
      const pts = [];
      let k = start;
      let p = start.split(',').map(Number);
      for (let guard = 0; guard < 1e6; guard++) {
        pts.push(x0 + (p[0] / 2 + 0.5) * cell, y0 + (p[1] / 2 + 0.5) * cell);
        const list = segs.get(k);
        if (!list || !list.length) break;
        p = list.pop();
        k = key(...p);
        if (k === start) break;
      }
      if (pts.length >= 8) rings.push(pts);
    }
  }

  const smoothed = rings.map((ring) => simplifyFlat(chaikin(chaikin(ring)), cell * 0.25));
  smoothed.sort((a, b) => ringsArea([b]) - ringsArea([a]));
  const biggest = smoothed.length ? ringsArea([smoothed[0]]) : 0;
  return smoothed.filter((ring) => ringsArea([ring]) > biggest * 0.004);
}

/** One round of Chaikin corner cutting on a closed flat ring. */
function chaikin(ring) {
  const n = ring.length / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2], ay = ring[i * 2 + 1], bx = ring[j * 2], by = ring[j * 2 + 1];
    out.push(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, 0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by);
  }
  out.push(out[0], out[1]);
  return out;
}

/** Ring approximating a circle, as projected flat coordinates. */
export function circleRing(cx, cy, radius, steps = 96) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
  }
  out.push(out[0], out[1]);
  return out;
}
