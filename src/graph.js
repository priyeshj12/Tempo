// Road graph: building it from OSM data, (de)serialising it, and spatial lookup.
//
// Vertices are intersections and dead ends. Each edge is one stretch of road
// between two vertices, with its true length and a simplified polyline for
// drawing. This is what the app counts as one "road".

import { makeProjection, simplifyFlat } from './geo.js';

const MAGIC = 0x4f504d54; // "TMPO"
const VERSION = 1;

/**
 * Build a graph from Overpass-style elements.
 *
 * @param {Array} elements  [{type:'node', id, lat, lon}, {type:'way', nodes:[ids]}]
 * @param {object} opts
 * @param {object} opts.proj         projection from geo.makeProjection
 * @param {object} [opts.clip]       PolygonIndex; nodes outside are dropped
 * @param {number} [opts.simplify]   Douglas-Peucker tolerance in metres
 * @param {function} [opts.progress] called with a 0..1 fraction
 */
export function buildGraph(elements, { proj, clip = null, simplify = 2.5, progress = null }) {
  // 1. index nodes
  const idToIdx = new Map();
  let nNodes = 0;
  for (const el of elements) if (el.type === 'node') nNodes++;
  const px = new Float64Array(nNodes);
  const py = new Float64Array(nNodes);
  const inside = new Uint8Array(nNodes);
  let k = 0;
  for (const el of elements) {
    if (el.type !== 'node') continue;
    const [x, y] = proj.fwd(el.lon, el.lat);
    px[k] = x;
    py[k] = y;
    inside[k] = clip ? (clip.contains(x, y) ? 1 : 0) : 1;
    idToIdx.set(el.id, k++);
  }
  progress?.(0.25);

  // 2. find vertices: shared nodes, way ends, and nodes next to a clipped gap
  const ways = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.nodes || el.nodes.length < 2) continue;
    const idx = [];
    for (const id of el.nodes) {
      const i = idToIdx.get(id);
      if (i !== undefined) idx.push(i);
    }
    if (idx.length >= 2) ways.push(idx);
  }
  const uses = new Uint8Array(nNodes);
  const forced = new Uint8Array(nNodes);
  for (const w of ways) {
    forced[w[0]] = forced[w[w.length - 1]] = 1;
    for (let i = 0; i < w.length; i++) {
      if (uses[w[i]] < 255) uses[w[i]]++;
      if (inside[w[i]] && ((i > 0 && !inside[w[i - 1]]) || (i < w.length - 1 && !inside[w[i + 1]]))) {
        forced[w[i]] = 1;
      }
    }
  }
  const vertexOf = new Int32Array(nNodes).fill(-1);
  let nV = 0;
  const vx = [];
  const vy = [];
  const vertex = (i) => {
    if (vertexOf[i] < 0) {
      vertexOf[i] = nV++;
      vx.push(px[i]);
      vy.push(py[i]);
    }
    return vertexOf[i];
  };
  progress?.(0.4);

  // 3. split ways into edges
  const eu = [];
  const ev = [];
  const elen = [];
  const egeom = [];
  for (const w of ways) {
    let start = -1;
    let pts = null;
    let len = 0;
    for (let i = 0; i < w.length; i++) {
      const n = w[i];
      if (!inside[n]) {
        start = -1;
        continue;
      }
      if (start < 0) {
        start = n;
        pts = [px[n], py[n]];
        len = 0;
        continue;
      }
      const lx = pts[pts.length - 2];
      const ly = pts[pts.length - 1];
      len += Math.hypot(px[n] - lx, py[n] - ly);
      pts.push(px[n], py[n]);
      if (uses[n] > 1 || forced[n]) {
        if (n !== start && len > 0) {
          eu.push(vertex(start));
          ev.push(vertex(n));
          elen.push(len);
          egeom.push(pts);
        }
        start = n;
        pts = [px[n], py[n]];
        len = 0;
      }
    }
  }
  progress?.(0.6);

  // 4. keep the largest connected component
  const parent = new Int32Array(nV);
  for (let i = 0; i < nV; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let e = 0; e < eu.length; e++) {
    const a = find(eu[e]);
    const b = find(ev[e]);
    if (a !== b) parent[a] = b;
  }
  const size = new Int32Array(nV);
  let best = -1;
  for (let i = 0; i < nV; i++) {
    const r = find(i);
    size[r]++;
    if (best < 0 || size[r] > size[best]) best = r;
  }
  const remap = new Int32Array(nV).fill(-1);
  let nKeep = 0;
  for (let i = 0; i < nV; i++) if (find(i) === best) remap[i] = nKeep++;

  const nodeX = new Float32Array(nKeep);
  const nodeY = new Float32Array(nKeep);
  for (let i = 0; i < nV; i++) {
    if (remap[i] >= 0) {
      nodeX[remap[i]] = vx[i];
      nodeY[remap[i]] = vy[i];
    }
  }

  const keptEdges = [];
  for (let e = 0; e < eu.length; e++) if (remap[eu[e]] >= 0) keptEdges.push(e);
  const nE = keptEdges.length;
  const edgeU = new Uint32Array(nE);
  const edgeV = new Uint32Array(nE);
  const edgeLen = new Float32Array(nE);
  const geomStart = new Uint32Array(nE + 1);
  const interior = [];
  for (let j = 0; j < nE; j++) {
    const e = keptEdges[j];
    edgeU[j] = remap[eu[e]];
    edgeV[j] = remap[ev[e]];
    edgeLen[j] = elen[e];
    const s = simplifyFlat(egeom[e], simplify);
    geomStart[j] = interior.length / 2;
    for (let i = 2; i < s.length - 2; i++) interior.push(s[i]);
  }
  geomStart[nE] = interior.length / 2;
  progress?.(0.9);

  return finalizeGraph({
    lon0: proj.lon0,
    lat0: proj.lat0,
    nodeX,
    nodeY,
    edgeU,
    edgeV,
    edgeLen,
    geomStart,
    geomXY: Float32Array.from(interior),
  });
}

/** Adds adjacency (CSR), bounds and a nearest-node grid to raw arrays. */
export function finalizeGraph(g) {
  const nNodes = g.nodeX.length;
  const nEdges = g.edgeU.length;
  const deg = new Uint32Array(nNodes + 1);
  for (let e = 0; e < nEdges; e++) {
    deg[g.edgeU[e] + 1]++;
    deg[g.edgeV[e] + 1]++;
  }
  for (let i = 0; i < nNodes; i++) deg[i + 1] += deg[i];
  const adjStart = deg;
  const fill = adjStart.slice(0, nNodes);
  const adjEdge = new Uint32Array(nEdges * 2);
  for (let e = 0; e < nEdges; e++) {
    adjEdge[fill[g.edgeU[e]]++] = e;
    adjEdge[fill[g.edgeV[e]]++] = e;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < nNodes; i++) {
    const x = g.nodeX[i], y = g.nodeY[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const graph = {
    ...g,
    nNodes,
    nEdges,
    adjStart,
    adjEdge,
    bounds: { minX, minY, maxX, maxY },
    proj: makeProjection(g.lon0, g.lat0),
  };
  graph.grid = new NodeGrid(graph);
  return graph;
}

/** The other end of edge e, seen from node n. */
export function otherEnd(g, e, n) {
  return g.edgeU[e] === n ? g.edgeV[e] : g.edgeU[e];
}

/** Bucket grid for nearest-vertex queries. */
export class NodeGrid {
  constructor(g, cell = 250) {
    const { minX, minY, maxX, maxY } = g.bounds;
    this.g = g;
    this.cell = cell;
    this.minX = minX;
    this.minY = minY;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    this.rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    const n = this.cols * this.rows;
    const count = new Uint32Array(n + 1);
    const cellOf = new Uint32Array(g.nNodes);
    for (let i = 0; i < g.nNodes; i++) {
      const c = this.cellIndex(g.nodeX[i], g.nodeY[i]);
      cellOf[i] = c;
      count[c + 1]++;
    }
    for (let i = 0; i < n; i++) count[i + 1] += count[i];
    const fill = count.slice(0, n);
    this.start = count;
    this.items = new Uint32Array(g.nNodes);
    for (let i = 0; i < g.nNodes; i++) this.items[fill[cellOf[i]]++] = i;
  }

  cellIndex(x, y) {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
    return cy * this.cols + cx;
  }

  nearest(x, y) {
    const { g, cell, cols, rows } = this;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - this.minX) / cell)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((y - this.minY) / cell)));
    let best = -1;
    let bestD = Infinity;
    const maxRing = Math.max(cols, rows);
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let j = cy - ring; j <= cy + ring; j++) {
        if (j < 0 || j >= rows) continue;
        for (let i = cx - ring; i <= cx + ring; i++) {
          if (i < 0 || i >= cols) continue;
          if (Math.max(Math.abs(i - cx), Math.abs(j - cy)) !== ring) continue;
          const c = j * cols + i;
          for (let p = this.start[c]; p < this.start[c + 1]; p++) {
            const n = this.items[p];
            const d = (g.nodeX[n] - x) ** 2 + (g.nodeY[n] - y) ** 2;
            if (d < bestD) {
              bestD = d;
              best = n;
            }
          }
        }
      }
      // anything in a further ring is at least ring * cell away
      if (best >= 0 && ring * cell >= Math.sqrt(bestD)) break;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Binary format
//
//   u32 magic, u32 version, u32 nNodes, u32 nEdges, u32 nGeom, u32 x3 reserved
//   f64 lon0, f64 lat0
//   i32 nodeX[nNodes]  (decimetres)     i32 nodeY[nNodes]
//   u32 edgeU[nEdges]                   u32 edgeV[nEdges]
//   f32 edgeLen[nEdges] (metres)
//   u16 geomCount[nEdges] (+ padding to 4 bytes)
//   i16 geom[2 * nGeom]: interior points as whole-metre deltas from the
//                        previous point, starting at node U
//
// The file may be gzipped; decodeGraph sniffs for that.

export function encodeGraph(g) {
  const nNodes = g.nNodes;
  const nEdges = g.nEdges;

  // Interior points as integer-metre deltas. A delta that does not fit in an
  // i16 is split by inserting extra collinear points.
  const counts = new Uint16Array(nEdges);
  const deltas = [];
  for (let e = 0; e < nEdges; e++) {
    let lx = Math.round(g.nodeX[g.edgeU[e]]);
    let ly = Math.round(g.nodeY[g.edgeU[e]]);
    let c = 0;
    for (let p = g.geomStart[e]; p < g.geomStart[e + 1]; p++) {
      const x = Math.round(g.geomXY[p * 2]);
      const y = Math.round(g.geomXY[p * 2 + 1]);
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x - lx), Math.abs(y - ly)) / 32000));
      let qx = lx;
      let qy = ly;
      for (let s = 1; s <= steps; s++) {
        const ix = s === steps ? x : Math.round(lx + ((x - lx) * s) / steps);
        const iy = s === steps ? y : Math.round(ly + ((y - ly) * s) / steps);
        deltas.push(ix - qx, iy - qy);
        qx = ix;
        qy = iy;
        c++;
      }
      lx = x;
      ly = y;
    }
    if (c > 65535) throw new Error('edge has too many points');
    counts[e] = c;
  }
  const nGeom = deltas.length / 2;

  const pad4 = (n) => (n + 3) & ~3;
  const size =
    48 + nNodes * 8 + nEdges * 12 + pad4(nEdges * 2) + nGeom * 4;
  const buf = new ArrayBuffer(size);
  const head = new Uint32Array(buf, 0, 8);
  head.set([MAGIC, VERSION, nNodes, nEdges, nGeom]);
  new Float64Array(buf, 32, 2).set([g.lon0, g.lat0]);
  let off = 48;
  const nx = new Int32Array(buf, off, nNodes); off += nNodes * 4;
  const ny = new Int32Array(buf, off, nNodes); off += nNodes * 4;
  for (let i = 0; i < nNodes; i++) {
    nx[i] = Math.round(g.nodeX[i] * 10);
    ny[i] = Math.round(g.nodeY[i] * 10);
  }
  new Uint32Array(buf, off, nEdges).set(g.edgeU); off += nEdges * 4;
  new Uint32Array(buf, off, nEdges).set(g.edgeV); off += nEdges * 4;
  new Float32Array(buf, off, nEdges).set(g.edgeLen); off += nEdges * 4;
  new Uint16Array(buf, off, nEdges).set(counts); off += pad4(nEdges * 2);
  new Int16Array(buf, off, nGeom * 2).set(deltas);
  return new Uint8Array(buf);
}

export async function decodeGraph(input) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  // copy so the views below are aligned
  const buf = bytes.byteOffset % 8 === 0 ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes.slice().buffer;
  const head = new Uint32Array(buf, 0, 8);
  if (head[0] !== MAGIC) throw new Error('Not a Tempo graph file');
  if (head[1] !== VERSION) throw new Error(`Unsupported graph version ${head[1]}`);
  const [, , nNodes, nEdges, nGeom] = head;
  const [lon0, lat0] = new Float64Array(buf, 32, 2);
  const pad4 = (n) => (n + 3) & ~3;
  let off = 48;
  const nx = new Int32Array(buf, off, nNodes); off += nNodes * 4;
  const ny = new Int32Array(buf, off, nNodes); off += nNodes * 4;
  const edgeU = new Uint32Array(buf, off, nEdges); off += nEdges * 4;
  const edgeV = new Uint32Array(buf, off, nEdges); off += nEdges * 4;
  const edgeLen = new Float32Array(buf, off, nEdges); off += nEdges * 4;
  const counts = new Uint16Array(buf, off, nEdges); off += pad4(nEdges * 2);
  const deltas = new Int16Array(buf, off, nGeom * 2);

  const nodeX = new Float32Array(nNodes);
  const nodeY = new Float32Array(nNodes);
  for (let i = 0; i < nNodes; i++) {
    nodeX[i] = nx[i] / 10;
    nodeY[i] = ny[i] / 10;
  }
  const geomStart = new Uint32Array(nEdges + 1);
  const geomXY = new Float32Array(nGeom * 2);
  let p = 0;
  for (let e = 0; e < nEdges; e++) {
    geomStart[e] = p;
    let x = Math.round(nodeX[edgeU[e]]);
    let y = Math.round(nodeY[edgeU[e]]);
    for (let c = 0; c < counts[e]; c++, p++) {
      x += deltas[p * 2];
      y += deltas[p * 2 + 1];
      geomXY[p * 2] = x;
      geomXY[p * 2 + 1] = y;
    }
  }
  geomStart[nEdges] = p;
  return finalizeGraph({ lon0, lat0, nodeX, nodeY, edgeU, edgeV, edgeLen, geomStart, geomXY });
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    // Node.js (build script / tests)
    const zlib = await import('node:zlib');
    return new Uint8Array(zlib.gunzipSync(bytes));
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Transferable plain object for postMessage. */
export function graphTransfer(g) {
  const raw = {
    lon0: g.lon0,
    lat0: g.lat0,
    nodeX: g.nodeX,
    nodeY: g.nodeY,
    edgeU: g.edgeU,
    edgeV: g.edgeV,
    edgeLen: g.edgeLen,
    geomStart: g.geomStart,
    geomXY: g.geomXY,
  };
  const transfer = [raw.nodeX, raw.nodeY, raw.edgeU, raw.edgeV, raw.edgeLen, raw.geomStart, raw.geomXY].map((a) => a.buffer);
  return { raw, transfer };
}
