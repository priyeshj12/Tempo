import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { finalizeGraph, encodeGraph, decodeGraph } from '../src/graph.js';
import { dijkstra, meetSearch, solve, tracePath } from '../src/search.js';
import { buildGraph } from '../src/graph.js';
import { makeProjection, PolygonIndex, simplifyFlat, landOutline, ringsArea } from '../src/geo.js';
import { classify, rankPlaces, rankByTrip, quality, STARS_PER_EXTRA_KM } from '../src/places.js';
import { makeBundle, searchGazetteer, bundledPlaceName, bundledLandmark, bundledPlacesNear } from '../src/offline.js';
import { connectTiles, toElements, tileLonLat } from '../src/tiles.js';

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

test('the meeting zone holds every node within the slack, and nothing else', () => {
  for (let seed = 3; seed <= 12; seed++) {
    const g = randomGraph(400, 600, seed);
    const r = rng(seed * 11);
    const k = 2 + (seed % 9); // up to 10 friends
    const sources = Array.from({ length: k }, () => Math.floor(r() * g.nNodes));
    const full = sources.map((s) => dijkstra(g, s).dist);
    const plain = meetSearch(g, sources);
    const res = meetSearch(g, sources, { slack: () => 150 });
    assert.equal(res.meet, plain.meet);
    assert.ok(Math.abs(res.zoneLimit - (plain.radius + 150)) < 1e-6);
    const expected = [];
    for (let v = 0; v < g.nNodes; v++) {
      let worst = 0;
      for (const d of full) worst = Math.max(worst, d[v]);
      if (worst <= res.zoneLimit + 1e-9) expected.push(v);
    }
    assert.deepEqual(Array.from(res.zone), expected, `seed ${seed}`);
    assert.ok(res.zone.includes(res.meet));
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

test('places are classified into the four groups', () => {
  assert.deepEqual(classify({ name: 'Ichiran', amenity: 'restaurant', cuisine: 'ramen;noodle' }), { category: 'eat', kind: 'Ramen' });
  assert.deepEqual(classify({ name: 'Blue Bottle', amenity: 'cafe', cuisine: 'coffee_shop' }), { category: 'eat', kind: 'Café' });
  assert.deepEqual(classify({ name: 'Port Bowl', leisure: 'bowling_alley' }), { category: 'activity', kind: 'Bowling' });
  assert.deepEqual(classify({ name: 'B-Pump', leisure: 'sports_centre', sport: 'climbing' }), { category: 'activity', kind: 'Climbing' });
  assert.deepEqual(classify({ name: 'Mori Art Museum', tourism: 'museum' }), { category: 'sightseeing', kind: 'Museum' });
  assert.deepEqual(classify({ name: 'Zojoji', amenity: 'place_of_worship', religion: 'buddhist', wikidata: 'Q1' }), { category: 'sightseeing', kind: 'Temple' });
  assert.deepEqual(classify({ name: 'Shiba Park', leisure: 'park' }), { category: 'chill', kind: 'Park' });
  assert.deepEqual(classify({ name: 'The Pub', amenity: 'pub' }), { category: 'chill', kind: 'Pub' });
  // small plaques and unnamed things are left out
  assert.equal(classify({ name: 'Stone', historic: 'memorial' }), null);
  assert.equal(classify({ amenity: 'restaurant' }), null);
  assert.equal(classify({ name: 'Gym', leisure: 'sports_centre' }), null);
});

test('places are ranked by walking distance on the road graph', () => {
  // a straight street from x = 0 to x = 2000 m along the equator
  const n = 21;
  const nodeX = Float32Array.from({ length: n }, (_, i) => i * 100);
  const nodeY = new Float32Array(n);
  const U = [], V = [];
  for (let i = 1; i < n; i++) { U.push(i - 1); V.push(i); }
  const g = finalizeGraph({
    lon0: 0, lat0: 0, nodeX, nodeY,
    edgeU: Uint32Array.from(U), edgeV: Uint32Array.from(V),
    edgeLen: new Float32Array(U.length).fill(100),
    geomStart: new Uint32Array(U.length + 1), geomXY: new Float32Array(0),
  });
  const walk = dijkstra(g, 0).dist;
  const at = (x) => g.proj.inv(x, 20);
  const el = (id, x, tags) => { const [lon, lat] = at(x); return { type: 'node', id, lat, lon, tags }; };
  const groups = rankPlaces([
    el(1, 1500, { name: 'Far Noodles', amenity: 'restaurant', cuisine: 'ramen' }),
    el(2, 300, { name: 'Near Noodles', amenity: 'restaurant', cuisine: 'ramen' }),
    el(3, 600, { name: 'Mid Noodles', amenity: 'restaurant', cuisine: 'ramen' }),
    el(4, 900, { name: 'Café', amenity: 'cafe' }),
    el(5, 900, { name: 'Park', leisure: 'park' }),
    el(6, 800, { name: 'Famous Park', leisure: 'park', wikidata: 'Q2' }),
  ], { graph: g, walk });
  // nearest first, and at most two places of the same kind of food
  assert.deepEqual(groups.eat.map((p) => p.name), ['Near Noodles', 'Mid Noodles', 'Café']);
  assert.equal(groups.eat[0].minutes, 4);
  // a well known park beats a slightly closer plain one
  assert.deepEqual(groups.chill.map((p) => p.name), ['Famous Park', 'Park']);
  assert.deepEqual(groups.activity, []);
});

test('a better place a little further away beats a plain one at the meeting point', () => {
  // a 10 km street with two friends at its ends; the fairest spot is the middle
  const n = 101;
  const nodeX = Float32Array.from({ length: n }, (_, i) => i * 100);
  const U = [], V = [];
  for (let i = 1; i < n; i++) { U.push(i - 1); V.push(i); }
  const g = finalizeGraph({
    lon0: 0, lat0: 0, nodeX, nodeY: new Float32Array(n),
    edgeU: Uint32Array.from(U), edgeV: Uint32Array.from(V),
    edgeLen: new Float32Array(U.length).fill(100),
    geomStart: new Uint32Array(U.length + 1), geomXY: new Float32Array(0),
  });
  const trips = [dijkstra(g, 0).dist, dijkstra(g, n - 1).dist];
  const at = (x) => { const [lon, lat] = g.proj.inv(x, 0); return { lat, lon }; };
  const groups = rankByTrip([
    { category: 'eat', name: 'Plain Diner', rating: 4.0, reviews: 120, ...at(5000) },
    { category: 'eat', name: 'Great Bistro', rating: 4.8, reviews: 3000, ...at(6000) },
    { category: 'eat', name: 'Far Legend', rating: 5.0, reviews: 9000, ...at(9900) },
    { category: 'chill', name: 'Park', notable: true, park: true, area: 80000, ...at(5200) },
  ], { graph: g, trips, fairest: 5000 });
  assert.deepEqual(groups.eat.map((p) => p.name), ['Great Bistro', 'Plain Diner']);
  const bistro = groups.eat[0];
  assert.deepEqual(bistro.km.map((k) => +k.toFixed(1)), [6, 4]);
  assert.ok(Math.abs(bistro.extra - 1) < 1e-6);
  assert.ok(Math.abs(bistro.score - (bistro.fun - STARS_PER_EXTRA_KM)) < 1e-9);
  assert.equal(groups.chill[0].name, 'Park');
  // rating counts more when many people rated it
  assert.ok(quality({ rating: 4.6, reviews: 2000 }) > quality({ rating: 4.9, reviews: 5 }));
});

test('offline search finds stations, spelling variants and nearby names', () => {
  const b = makeBundle('x', { name: 'Testville', country: 'Nowhere' }, {
    kinds: ['chill\tPark', 'eat\tRamen'],
    items: [
      [3500100, 13900100, 0, '中央公園', 'Central Park', 4 | 1, 'w1', 50000],
      [3500000, 13900000, 1, 'ラーメン', '', 2, 'n2', 0],
    ],
  }, {
    items: [
      [3500000, 13900000, 's', '中目黒', 'Naka-meguro', ''],
      [3500050, 13900050, 's', '中目黒', 'Naka-meguro', ''], // same station, another line
      [3502000, 13902000, 'n', '中目黒一丁目', 'Nakameguro 1', ''],
      [3510000, 13910000, 'l', '東京タワー', 'Tokyo Tower', ''],
    ],
  });
  const naka = searchGazetteer(b, 'Nakameguro station');
  assert.equal(naka[0].label, 'Naka-meguro');
  assert.equal(naka[0].detail, 'Naka-meguro, station in Testville');
  assert.equal(naka.filter((r) => r.label === 'Naka-meguro').length, 1);
  assert.equal(searchGazetteer(b, '東京タワー')[0].label, 'Tokyo Tower');
  assert.deepEqual(searchGazetteer(b, 'Paris'), []);
  assert.equal(bundledPlaceName(b, 35.0201, 139.0201).label, 'Nakameguro 1');
  assert.equal(bundledLandmark(b, 35.0001, 139.0001, (n) => `${n} Station`), 'Naka-meguro Station');
  const near = bundledPlacesNear(b, 35, 139, 500);
  assert.deepEqual(near.map((p) => [p.id, p.category, p.kind, p.name]), [
    ['way/1', 'chill', 'Park', 'Central Park'],
    ['node/2', 'eat', 'Ramen', 'ラーメン'],
  ]);
  assert.equal(near[0].notable && near[0].park, true);
});

test('streets from map tiles are joined at junctions and seams, not at bridges', () => {
  const z = 14, x = 8414, y = 5384; // central Amsterdam
  const [lon0, lat0] = tileLonLat(x + 1, y + 0.5, z);
  const proj = makeProjection(lon0, lat0);
  const road = (pts, props = {}) => ({ props: { class: 'minor', ...props }, lines: [pts] });
  const tiles = [
    {
      z, x, y,
      layer: {
        extent: 4096,
        features: [
          road([100, 2000, 4150, 2000]), // A: runs past the tile edge, junction points simplified away
          road([2000, 100, 2000, 1999.4]), // B: ends just short of A (a T-junction)
          road([3000, 1000, 3000, 3000]), // C: crosses A at street level
          road([1000, 1000, 1000, 3000], { brunnel: 'bridge' }), // D: a bridge over A
        ],
      },
    },
    { z, x: x + 1, y, layer: { extent: 4096, features: [road([-60, 2000, 2000, 2000])] } }, // A continues
  ];
  const g = buildGraph(toElements(connectTiles(tiles, proj), proj), { proj });
  const at = (tx, px, py) => proj.fwd(...tileLonLat(tx + px / 4096, y + py / 4096, z));
  const node = (p) => g.grid.nearest(...p);
  const metresPerPx = Math.hypot(...[0, 1].map((k) => at(x, 4096, 0)[k] - at(x, 0, 0)[k])) / 4096;

  // B to C goes along A: 1900 + 1000 + 1000 px
  const bc = dijkstra(g, node(at(x, 2000, 100))).dist[node(at(x, 3000, 3000))];
  assert.ok(Math.abs(bc / metresPerPx - 3900) < 40, `B to C ${bc / metresPerPx} px`);
  // A carries on across the seam into the next tile
  const across = dijkstra(g, node(at(x, 100, 2000))).dist[node(at(x + 1, 2000, 2000))];
  assert.ok(Math.abs(across / metresPerPx - 5996) < 40, `across the seam ${across / metresPerPx} px`);
  // the bridge does not join A, so it is a separate piece and left out
  const d = at(x, 1000, 1000);
  const n = node(d);
  assert.ok(Math.hypot(g.nodeX[n] - d[0], g.nodeY[n] - d[1]) > 300);
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
