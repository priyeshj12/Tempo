// Shortest-path searches over the road graph.
//
// "One by one": a full Dijkstra from each friend. Without knowing where they
// will meet, every search has to flood the whole city.
//
// "All at once": the searches run interleaved, always expanding whichever
// frontier is globally closest. The first node that every search has settled
// is the meeting point that minimises the longest trip (the fairest place),
// and the search can stop right there.

/** Binary min-heap of (float key, int value) pairs. */
export class MinHeap {
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
  }

  push(key, val) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      const v = new Int32Array(this.size * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    const keys = this.keys;
    const vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Removes the smallest entry; its key is left in this.topKey. */
  pop() {
    const keys = this.keys;
    const vals = this.vals;
    const val = vals[0];
    this.topKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n];
      const v = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = v;
    }
    return val;
  }
}

/**
 * Full single-source Dijkstra.
 * @returns {{dist: Float64Array, pred: Int32Array}} pred holds the edge used
 *          to reach each node (-1 for the source and unreachable nodes).
 */
export function dijkstra(g, source) {
  const n = g.nNodes;
  const dist = new Float64Array(n).fill(Infinity);
  const pred = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(Math.max(1024, n >> 2));
  const { adjStart, adjEdge, edgeU, edgeV, edgeLen } = g;
  dist[source] = 0;
  heap.push(0, source);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const du = dist[u];
    for (let p = adjStart[u]; p < adjStart[u + 1]; p++) {
      const e = adjEdge[p];
      const v = edgeU[e] === u ? edgeV[e] : edgeU[e];
      const nd = du + edgeLen[e];
      if (nd < dist[v]) {
        dist[v] = nd;
        pred[v] = e;
        heap.push(nd, v);
      }
    }
  }
  return { dist, pred };
}

/**
 * Simultaneous search from all sources. The first node settled by every one
 * of them is the meeting point. With `slack`, the floods carry on a little
 * further to find the meeting zone: every node where the longest trip is at
 * most `radius + slack(radius)`.
 *
 * @param {object} [opts]
 * @param {function} [opts.slack]  radius -> extra metres for the zone
 * @returns {{
 *   meet: number,            node index of the meeting point (-1 if none)
 *   radius: number,          the longest trip to it, in metres
 *   firstCross: number,      radius at which two floods first touched
 *   zone: Uint32Array,       nodes within the zone limit (includes meet)
 *   zoneLimit: number,       longest trip allowed inside the zone
 *   dist: Float64Array[],    per source; Infinity beyond what it settled
 *   pred: Int32Array[],
 * }}
 */
export function meetSearch(g, sources, { slack = null } = {}) {
  const k = sources.length;
  const n = g.nNodes;
  const dist = sources.map(() => new Float64Array(n).fill(Infinity));
  const pred = sources.map(() => new Int32Array(n).fill(-1));
  const done = sources.map(() => new Uint8Array(n));
  const settledBy = new Uint8Array(n);
  const heap = new MinHeap(Math.max(1024, n));
  const { adjStart, adjEdge, edgeU, edgeV, edgeLen } = g;

  for (let i = 0; i < k; i++) {
    dist[i][sources[i]] = 0;
    heap.push(0, sources[i] * k + i);
  }

  let meet = -1;
  let radius = Infinity;
  let firstCross = Infinity;
  let limit = Infinity;
  while (heap.size) {
    if (heap.keys[0] > limit) break;
    const item = heap.pop();
    const d = heap.topKey;
    const u = (item / k) | 0;
    const i = item - u * k;
    const doneI = done[i];
    if (doneI[u]) continue;
    doneI[u] = 1;
    const c = ++settledBy[u];
    if (c === 2 && firstCross === Infinity) firstCross = d;
    if (c === k && meet < 0) {
      meet = u;
      radius = d;
      limit = d + (slack ? Math.max(0, slack(d)) : 0);
      if (!slack) break;
    }
    const distI = dist[i];
    const predI = pred[i];
    for (let p = adjStart[u]; p < adjStart[u + 1]; p++) {
      const e = adjEdge[p];
      const v = edgeU[e] === u ? edgeV[e] : edgeU[e];
      const nd = d + edgeLen[e];
      if (nd < distI[v]) {
        distI[v] = nd;
        predI[v] = e;
        heap.push(nd, v * k + i);
      }
    }
  }
  if (k === 1) firstCross = 0;

  // Only settled distances are final; forget tentative ones.
  for (let i = 0; i < k; i++) {
    const di = dist[i];
    const doneI = done[i];
    for (let v = 0; v < n; v++) if (!doneI[v]) di[v] = Infinity;
  }

  const zone = [];
  if (meet >= 0) {
    for (let v = 0; v < n; v++) {
      if (settledBy[v] !== k) continue;
      let worst = 0;
      for (let i = 0; i < k; i++) if (dist[i][v] > worst) worst = dist[i][v];
      if (worst <= limit) zone.push(v);
    }
  }
  return { meet, radius, firstCross, zone: Uint32Array.from(zone), zoneLimit: meet >= 0 ? limit : Infinity, dist, pred };
}

/** Extra distance that still counts as "about as fair": 6%, 250 m to 1.5 km. */
export function zoneSlack(radius) {
  return Math.min(1500, Math.max(250, radius * 0.06));
}

/** Node sequence and polyline (flat x,y) from source to target via pred edges. */
export function tracePath(g, pred, target) {
  const edges = [];
  let v = target;
  while (pred[v] >= 0) {
    const e = pred[v];
    edges.push(e);
    v = g.edgeU[e] === v ? g.edgeV[e] : g.edgeU[e];
  }
  edges.reverse();
  // walk forward from the source, emitting each edge in travel direction
  const pts = [g.nodeX[v], g.nodeY[v]];
  let at = v;
  let length = 0;
  for (const e of edges) {
    const forward = g.edgeU[e] === at;
    const s = g.geomStart[e];
    const t = g.geomStart[e + 1];
    if (forward) {
      for (let p = s; p < t; p++) pts.push(g.geomXY[p * 2], g.geomXY[p * 2 + 1]);
    } else {
      for (let p = t - 1; p >= s; p--) pts.push(g.geomXY[p * 2], g.geomXY[p * 2 + 1]);
    }
    at = forward ? g.edgeV[e] : g.edgeU[e];
    pts.push(g.nodeX[at], g.nodeY[at]);
    length += g.edgeLen[e];
  }
  return { edges, pts, length };
}

/**
 * Everything the animation needs to replay one flood.
 *
 * An edge is entered when the flood first reaches either end (t0) and fully
 * covered when the fronts coming from both ends meet (t1). Edges beyond the
 * cutoff radius are never entered.
 */
export class Flood {
  constructor(g, dist, cutoff = Infinity) {
    this.g = g;
    this.dist = dist;
    this.cutoff = cutoff;
    const m = g.nEdges;
    const t0 = new Float32Array(m);
    const t1 = new Float32Array(m);
    let entered = 0;
    let maxT = 0;
    for (let e = 0; e < m; e++) {
      const du = dist[g.edgeU[e]];
      const dv = dist[g.edgeV[e]];
      const L = g.edgeLen[e];
      const a = Math.min(du, dv);
      t0[e] = a;
      let done;
      if (du === Infinity || dv === Infinity) done = a + L;
      else done = Math.max(Math.max(du, dv), (du + dv + L) / 2);
      t1[e] = done;
      if (a <= cutoff) {
        entered++;
        const end = Math.min(done, cutoff);
        if (end > maxT) maxT = end;
      }
    }
    this.t0 = t0;
    this.t1 = t1;
    this.maxRadius = Math.min(maxT, cutoff);
    this.entered = entered;

    this.byT0 = sortedEdges(t0, cutoff);
    this.t0Sorted = gather(t0, this.byT0);
    this.byT1 = sortedEdges(t1, cutoff);
    this.t1Sorted = gather(t1, this.byT1);
  }

  /** Number of roads the flood has entered by radius r. */
  countAt(r) {
    return upperBound(this.t0Sorted, Math.min(r, this.cutoff));
  }
}

const ID_BITS = 2 ** 21;

/** Edge ids with time <= cutoff, ordered by time. */
function sortedEdges(times, cutoff) {
  let n = 0;
  for (let e = 0; e < times.length; e++) if (times[e] <= cutoff) n++;
  const ids = new Uint32Array(n);
  if (times.length < ID_BITS) {
    // Pack (time in cm, id) into one float so the native numeric sort does
    // the work without a comparator callback.
    const keys = new Float64Array(n);
    let k = 0;
    for (let e = 0; e < times.length; e++) {
      if (times[e] <= cutoff) keys[k++] = Math.round(times[e] * 100) * ID_BITS + e;
    }
    keys.sort();
    for (let i = 0; i < n; i++) ids[i] = keys[i] % ID_BITS;
    return ids;
  }
  let k = 0;
  for (let e = 0; e < times.length; e++) if (times[e] <= cutoff) ids[k++] = e;
  ids.sort((a, b) => times[a] - times[b]);
  return ids;
}

function gather(times, ids) {
  const out = new Float32Array(ids.length);
  for (let i = 0; i < ids.length; i++) out[i] = times[ids[i]];
  return out;
}

/** Index of the first element greater than x in a sorted array. */
export function upperBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The "all at once" search plus everything needed to show its result.
 * `separate` starts empty; fill it with separateFloods() before animating
 * the one-by-one phase.
 */
export function solveTogether(g, sources) {
  const meet = meetSearch(g, sources, { slack: zoneSlack });
  const together = sources.map((_, i) => new Flood(g, meet.dist[i], meet.radius));
  const paths = meet.meet >= 0 ? sources.map((_, i) => tracePath(g, meet.pred[i], meet.meet)) : [];

  // streets of the meeting zone: both ends inside it
  const inZone = new Uint8Array(g.nNodes);
  for (const v of meet.zone) inZone[v] = 1;
  const zoneEdges = [];
  for (let e = 0; e < g.nEdges; e++) if (inZone[g.edgeU[e]] && inZone[g.edgeV[e]]) zoneEdges.push(e);

  return {
    meet: meet.meet,
    radius: meet.radius,
    firstCross: meet.firstCross,
    zone: meet.zone,
    zoneLimit: meet.zoneLimit,
    zoneEdges: Uint32Array.from(zoneEdges),
    together,
    separate: [],
    paths,
    roadsTogether: together.reduce((a, f) => a + f.entered, 0),
    // The graph is one connected component, so a full search from anyone
    // enters every road.
    roadsSeparate: sources.length * g.nEdges,
  };
}

/** The "one by one" searches: a full flood from each source. */
export function separateFloods(g, sources) {
  return sources.map((s) => new Flood(g, dijkstra(g, s).dist));
}

/** Runs both strategies for a set of source nodes. */
export function solve(g, sources) {
  const res = solveTogether(g, sources);
  res.separate = separateFloods(g, sources);
  res.roadsSeparate = res.separate.reduce((a, f) => a + f.entered, 0);
  return res;
}
