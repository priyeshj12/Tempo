import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { finalizeGraph, encodeGraph, decodeGraph } from '../src/graph.js';
import { dijkstra, meetSearch, solve, tracePath } from '../src/search.js';
import { buildGraph } from '../src/graph.js';
import { makeProjection, PolygonIndex, simplifyFlat, landOutline, ringsArea } from '../src/geo.js';

// deterministic PRNG
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function randomGraph(n, extra, seed) {
  const r = rng(seed);
  const nodeX = new Float32Array(n);
  const nodeY = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    nodeX[i] = Math.round(r() * 1000);
    nodeY[i] = Math.round(r() * 1000);
  }
  const U = [];
  const V = [];
  // spanning tree keeps it connected, then random extra edges
  for (let i = 1; i < n; i++) {
    U.push(i);
    V.push(Math.floor(r() * i));
  }
  for (let i = 0; i < extra; i++) {
    const a = Math.floor(r() * n);
    const b = Math.floor(r() * n);
    if (a !== b) {
      U.push(a);
      V.push(b);
    }
  }
  const m = U.length;
  const edgeLen = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    edgeLen[e] = Math.hypot(nodeX[U[e]] - nodeX[V[e]], nodeY[U[e]] - nodeY[V[e]]) + 1;
  }
  return finalizeGraph({
    lon0: 0,
    lat0: 0,
    nodeX,
    nodeY,
    edgeU: Uint32Array.from(U),
    edgeV: Uint32Array.from(V),
    edgeLen,
    geomStart: new Uint32Array(m + 1),
    geomXY: new Float32Array(0),
  });
}

test('meetSearch finds the node minimising the longest trip', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const g = randomGraph(300, 400, seed);
    const r = rng(seed * 7);
    const k = 2 + (seed % 5);
    const sources = Array.from({ length: k }, () => Math.floor(r() * g.nNodes));
    const full = sources.map((s) => dijkstra(g, s).dist);
    let best = Infinity;
    for (let v = 0; v < g.nNodes; v++) {
      let worst = 0;
      for (const d of full) worst = Math.max(worst, d[v]);
      best = Math.min(best, worst);
    }
    const res = meetSearch(g, sources);
    assert.ok(Math.abs(res.radius - best) < 1e-3, `seed ${seed}: ${res.radius} vs ${best}`);
    // reported distances to the meeting point are the true shortest ones
    for (let i = 0; i < k; i++) {
      assert.ok(Math.abs(res.dist[i][res.meet] - full[i][res.meet]) < 1e-3);
      const path = tracePath(g, res.pred[i], res.meet);
      assert.ok(Math.abs(path.length - full[i][res.meet]) < 1e-2);
    }
  }
});

test('searching together checks fewer roads than one by one', () => {
  const g = randomGraph(2000, 3000, 42);
  const res = solve(g, [5, 500, 1000, 1500]);
  assert.equal(res.roadsSeparate, 4 * g.nEdges);
  assert.ok(res.roadsTogether < res.roadsSeparate);
  assert.ok(res.firstCross <= res.radius);
  for (const f of res.together) assert.ok(f.maxRadius <= res.radius + 1e-6);
});

test('buildGraph splits ways at intersections and clips to a polygon', () => {
  const proj = makeProjection(0, 0);
  // a plus sign: two ways crossing at node 3, plus a far-away disconnected way
  const deg = 1 / 111195; // ~1 m in degrees at the equator
  const els = [
    { type: 'node', id: 1, lon: -100 * deg, lat: 0 },
    { type: 'node', id: 2, lon: -50 * deg, lat: 0 },
    { type: 'node', id: 3, lon: 0, lat: 0 },
    { type: 'node', id: 4, lon: 100 * deg, lat: 0 },
    { type: 'node', id: 5, lon: 0, lat: 100 * deg },
    { type: 'node', id: 6, lon: 0, lat: -100 * deg },
    { type: 'node', id: 7, lon: 5000 * deg, lat: 0 },
    { type: 'node', id: 8, lon: 5100 * deg, lat: 0 },
    { type: 'way', id: 10, nodes: [1, 2, 3, 4] },
    { type: 'way', id: 11, nodes: [5, 3, 6] },
    { type: 'way', id: 12, nodes: [7, 8] },
  ];
  const g = buildGraph(els, { proj });
  assert.equal(g.nNodes, 5); // 1, 3, 4, 5, 6; the far way is a separate component
  assert.equal(g.nEdges, 4);
  const total = g.edgeLen.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 400) < 1);

  // clip away everything east of x = 50 m
  const clip = new PolygonIndex([[-1000, -1000, 50, -1000, 50, 1000, -1000, 1000, -1000, -1000]]);
  const c = buildGraph(els, { proj, clip });
  assert.equal(c.nEdges, 3);
});

test('binary encoding round-trips', async () => {
  const g = randomGraph(500, 600, 3);
  const back = await decodeGraph(encodeGraph(g));
  assert.equal(back.nNodes, g.nNodes);
  assert.equal(back.nEdges, g.nEdges);
  for (let i = 0; i < g.nNodes; i++) assert.ok(Math.abs(back.nodeX[i] - g.nodeX[i]) <= 0.05);
  assert.deepEqual(Array.from(back.edgeU), Array.from(g.edgeU));
  const a = meetSearch(g, [1, 100, 200]);
  const b = meetSearch(back, [1, 100, 200]);
  assert.equal(a.meet, b.meet);
});

test('simplifyFlat keeps the end points', () => {
  const pts = [0, 0, 1, 0.01, 2, 0, 3, 5, 4, 0];
  const s = simplifyFlat(pts, 0.5);
  assert.deepEqual(s.slice(0, 2), [0, 0]);
  assert.deepEqual(s.slice(-2), [4, 0]);
  assert.equal(s.length, 8);
});

test('landOutline traces a road grid and respects the boundary', () => {
  // 21 x 21 street grid, 100 m blocks, over a 2 km square
  const n = 21;
  const nodeX = new Float32Array(n * n);
  const nodeY = new Float32Array(n * n);
  const U = [];
  const V = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      nodeX[j * n + i] = i * 100;
      nodeY[j * n + i] = j * 100;
      if (i) { U.push(j * n + i - 1); V.push(j * n + i); }
      if (j) { U.push((j - 1) * n + i); V.push(j * n + i); }
    }
  }
  const g = finalizeGraph({
    lon0: 0, lat0: 0, nodeX, nodeY,
    edgeU: Uint32Array.from(U), edgeV: Uint32Array.from(V),
    edgeLen: new Float32Array(U.length).fill(100),
    geomStart: new Uint32Array(U.length + 1), geomXY: new Float32Array(0),
  });
  const rings = landOutline(g);
  assert.equal(rings.length, 1);
  const area = ringsArea(rings);
  assert.ok(area > 2000 * 2000 * 0.85 && area < 2200 * 2200, `area ${area}`);

  // a boundary covering the left half halves the outline
  const half = new PolygonIndex([[-500, -500, 1000, -500, 1000, 2500, -500, 2500, -500, -500]]);
  const clipped = ringsArea(landOutline(g, half));
  assert.ok(clipped < area * 0.65, `clipped ${clipped} vs ${area}`);
});

const tokyo = new URL('../data/tokyo.tmpo', import.meta.url);
test('Tokyo preset: four friends meet', { skip: !existsSync(tokyo) }, async () => {
  const meta = JSON.parse(readFileSync(new URL('../data/tokyo.json', import.meta.url)));
  const g = await decodeGraph(readFileSync(tokyo));
  const sources = meta.friends.map((f) => {
    const [x, y] = g.proj.fwd(f.lon, f.lat);
    return g.grid.nearest(x, y);
  });
  const t = performance.now();
  const res = solve(g, sources);
  const ms = performance.now() - t;
  const [lon, lat] = g.proj.inv(g.nodeX[res.meet], g.nodeY[res.meet]);
  console.log(
    `  ${g.nEdges} roads; meet at ${lat.toFixed(5)}, ${lon.toFixed(5)};`,
    `trips ${res.paths.map((p) => (p.length / 1000).toFixed(1)).join(' / ')} km;`,
    `roads one by one ${res.roadsSeparate}, together ${res.roadsTogether}; ${ms.toFixed(0)} ms`,
  );
  assert.ok(res.meet >= 0);
  assert.ok(res.roadsTogether < res.roadsSeparate / 1.5);
});
