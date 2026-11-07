// Draws the 9:16 stage: road network, floods, markers, routes and captions.
// Everything is painted on one canvas so it can be recorded as a video.

export const STAGE_W = 1080;
export const STAGE_H = 1920;
const MAP = { x: 50, y: 330, w: 980, h: 1300 };

export const FONT_SANS = '"Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO = '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace';

// Ink ramp for a city at night; streets in dim sodium light.
const INK_DEEP = '#07080d';
const INK_CARD = 'rgba(17, 20, 28, 0.94)';
const TEXT1 = '#eef0f5';
const TEXT2 = '#a3a9b8';
const TEXT3 = '#7a8296';
const HAIRLINE = 'rgba(238, 240, 245, 0.12)';
export const ACCENT = '#f2a541';
const BASE_ROAD = 'rgba(232, 168, 92, 0.22)';
const OUTLINE = 'rgba(242, 165, 65, 0.5)';

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(rgb, to, t) {
  return rgb.map((c, i) => Math.round(c + (to[i] - c) * t));
}

const rgba = (rgb, a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x) => {
  x = clamp01(x);
  return x * x * (3 - 2 * x);
};
// one ease-out curve for everything, close to cubic-bezier(0.22, 1, 0.36, 1)
const easeOut = (x) => 1 - (1 - clamp01(x)) ** 4;

function makeLayer() {
  const c = document.createElement('canvas');
  c.width = STAGE_W;
  c.height = STAGE_H;
  return c;
}

/**
 * Screen-space copy of the graph geometry for one fit.
 */
class ScreenGeometry {
  constructor(g, view) {
    const { s, ox, oy } = view;
    this.g = g;
    this.nx = new Float32Array(g.nNodes);
    this.ny = new Float32Array(g.nNodes);
    for (let i = 0; i < g.nNodes; i++) {
      this.nx[i] = ox + g.nodeX[i] * s;
      this.ny[i] = oy - g.nodeY[i] * s;
    }
    const m = g.geomXY.length / 2;
    this.gx = new Float32Array(m);
    this.gy = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      this.gx[i] = ox + g.geomXY[i * 2] * s;
      this.gy[i] = oy - g.geomXY[i * 2 + 1] * s;
    }
    // screen length of each edge polyline, for partial drawing
    this.len = new Float32Array(g.nEdges);
    for (let e = 0; e < g.nEdges; e++) {
      let px = this.nx[g.edgeU[e]];
      let py = this.ny[g.edgeU[e]];
      let L = 0;
      for (let p = g.geomStart[e]; p < g.geomStart[e + 1]; p++) {
        L += Math.hypot(this.gx[p] - px, this.gy[p] - py);
        px = this.gx[p];
        py = this.gy[p];
      }
      L += Math.hypot(this.nx[g.edgeV[e]] - px, this.ny[g.edgeV[e]] - py);
      this.len[e] = L;
    }
  }

  addEdge(path, e) {
    const g = this.g;
    path.moveTo(this.nx[g.edgeU[e]], this.ny[g.edgeU[e]]);
    for (let p = g.geomStart[e]; p < g.geomStart[e + 1]; p++) path.lineTo(this.gx[p], this.gy[p]);
    path.lineTo(this.nx[g.edgeV[e]], this.ny[g.edgeV[e]]);
  }

  /** Adds the first `len` screen pixels of edge e, walking from U (or from V). */
  addPartial(path, e, fromU, len) {
    if (len <= 0) return;
    const g = this.g;
    const s = g.geomStart[e];
    const t = g.geomStart[e + 1];
    const count = t - s + 2;
    const px = (i) => {
      const k = fromU ? i : count - 1 - i;
      if (k === 0) return [this.nx[g.edgeU[e]], this.ny[g.edgeU[e]]];
      if (k === count - 1) return [this.nx[g.edgeV[e]], this.ny[g.edgeV[e]]];
      return [this.gx[s + k - 1], this.gy[s + k - 1]];
    };
    let [ax, ay] = px(0);
    path.moveTo(ax, ay);
    let left = len;
    for (let i = 1; i < count; i++) {
      const [bx, by] = px(i);
      const d = Math.hypot(bx - ax, by - ay);
      if (d >= left) {
        const f = d > 0 ? left / d : 0;
        path.lineTo(ax + (bx - ax) * f, ay + (by - ay) * f);
        return;
      }
      path.lineTo(bx, by);
      left -= d;
      ax = bx;
      ay = by;
    }
  }
}

/**
 * Replays one Flood onto a layer, incrementally, as the radius grows.
 */
class FloodPlayer {
  constructor(flood, geo, color) {
    this.flood = flood;
    this.geo = geo;
    this.rgb = hexToRgb(color);
    this.reset();
  }

  reset() {
    this.r = -1;
    this.commitPtr = 0;
    this.enterPtr = 0;
    this.active = [];
    this.finalized = false;
  }

  /** Commits fully covered edges up to radius r onto ctx. */
  advance(ctx, r, alpha = 0.85) {
    const f = this.flood;
    r = Math.min(r, f.cutoff);
    if (r <= this.r) return;
    const path = new Path2D();
    let any = false;
    while (this.commitPtr < f.byT1.length && f.t1Sorted[this.commitPtr] <= r) {
      this.geo.addEdge(path, f.byT1[this.commitPtr++]);
      any = true;
    }
    while (this.enterPtr < f.byT0.length && f.t0Sorted[this.enterPtr] <= r) {
      this.active.push(f.byT0[this.enterPtr++]);
    }
    const t1 = f.t1;
    this.active = this.active.filter((e) => t1[e] > r);
    if (any) {
      ctx.strokeStyle = rgba(this.rgb, alpha);
      ctx.lineWidth = 1.5;
      ctx.stroke(path);
    }
    this.r = r;
  }

  /** Draws the edges still being flooded at the cutoff, permanently. */
  finalize(ctx, alpha = 0.85) {
    if (this.finalized) return;
    this.finalized = true;
    const path = new Path2D();
    this.addActive(path, this.flood.cutoff);
    ctx.strokeStyle = rgba(this.rgb, alpha);
    ctx.lineWidth = 1.5;
    ctx.stroke(path);
  }

  addActive(path, r) {
    const { dist, g } = { dist: this.flood.dist, g: this.flood.g };
    const geo = this.geo;
    for (const e of this.active) {
      const L = g.edgeLen[e];
      const k = geo.len[e] / (L || 1);
      const du = dist[g.edgeU[e]];
      const dv = dist[g.edgeV[e]];
      const a = du === Infinity ? 0 : Math.min(L, Math.max(0, r - du));
      const b = dv === Infinity ? 0 : Math.min(L, Math.max(0, r - dv));
      if (a + b >= L) {
        geo.addEdge(path, e);
      } else {
        geo.addPartial(path, e, true, a * k);
        geo.addPartial(path, e, false, b * k);
      }
    }
  }

  /**
   * Bright wavefront: the active edges plus recently covered ones. The crisp
   * core goes on ctx; the halo goes on a quarter-resolution glow context that
   * is later scaled up, which blurs it for free.
   */
  drawBand(ctx, glowCtx, r, width, strength = 1) {
    if (strength <= 0.01) return;
    const f = this.flood;
    r = Math.min(r, f.cutoff);
    const buckets = 3;
    const paths = Array.from({ length: buckets }, () => new Path2D());
    const lo = r - width;
    // recently completed edges, newest first
    for (let i = this.commitPtr - 1; i >= 0; i--) {
      const t = f.t1Sorted[i];
      if (t <= lo) break;
      const age = (r - t) / width;
      const b = Math.min(buckets - 1, Math.floor(age * buckets));
      this.geo.addEdge(paths[b], f.byT1[i]);
    }
    this.addActive(paths[0], r);

    const core = rgba(mix(this.rgb, [255, 255, 255], 0.7), 1);
    glowCtx.strokeStyle = rgba(mix(this.rgb, [255, 255, 255], 0.2), 1);
    glowCtx.lineWidth = 7;
    ctx.strokeStyle = core;
    ctx.lineWidth = 1.8;
    for (let b = buckets - 1; b >= 0; b--) {
      const k = (1 - b / buckets) * strength;
      glowCtx.globalAlpha = 0.55 * k;
      glowCtx.stroke(paths[b]);
      ctx.globalAlpha = 0.9 * k;
      ctx.stroke(paths[b]);
    }
  }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = STAGE_W;
    canvas.height = STAGE_H;
    this.ctx = canvas.getContext('2d');
    this.base = makeLayer();
    this.layerA = makeLayer();
    this.layerB = makeLayer();
    this.glow = document.createElement('canvas');
    this.glow.width = STAGE_W / 4;
    this.glow.height = STAGE_H / 4;
    this.view = null;
    this.nameOf = (f) => f.name;
  }

  /** New city: fit, precompute screen geometry and paint the base layer. */
  setCity(city, graph) {
    this.city = city;
    this.graph = graph;
    const b = city.outlineBounds;
    const s = Math.min(MAP.w / (b.maxX - b.minX), MAP.h / (b.maxY - b.minY));
    const ox = MAP.x + MAP.w / 2 - ((b.minX + b.maxX) / 2) * s;
    const oy = MAP.y + MAP.h / 2 + ((b.minY + b.maxY) / 2) * s;
    this.view = { s, ox, oy };
    this.geo = new ScreenGeometry(graph, this.view);
    this.bandWidth = 0.028 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
    this.paintBase();
    this.result = null;
    this.players = null;
  }

  toScreen(x, y) {
    const { s, ox, oy } = this.view;
    return [ox + x * s, oy - y * s];
  }

  toWorld(sx, sy) {
    const { s, ox, oy } = this.view;
    return [(sx - ox) / s, (oy - sy) / s];
  }

  paintBase() {
    const ctx = this.base.getContext('2d');
    ctx.clearRect(0, 0, STAGE_W, STAGE_H);
    const outline = new Path2D();
    for (const ring of this.city.outline) {
      for (let i = 0; i < ring.length; i += 2) {
        const [x, y] = this.toScreen(ring[i], ring[i + 1]);
        if (i === 0) outline.moveTo(x, y);
        else outline.lineTo(x, y);
      }
      outline.closePath();
    }
    ctx.fillStyle = 'rgba(238, 240, 245, 0.015)';
    ctx.fill(outline, 'evenodd');

    const roads = new Path2D();
    for (let e = 0; e < this.graph.nEdges; e++) this.geo.addEdge(roads, e);
    ctx.lineCap = 'round';
    ctx.strokeStyle = BASE_ROAD;
    ctx.lineWidth = 1.1;
    ctx.stroke(roads);

    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2;
    ctx.stroke(outline);
  }

  /** New solution to animate. */
  setResult(result, friends) {
    this.result = result;
    this.friends = friends;
    const geo = this.geo;
    this.players = {
      separate: result.separate.map((f, i) => new FloodPlayer(f, geo, friends[i].color)),
      together: result.together.map((f, i) => new FloodPlayer(f, geo, friends[i].color)),
    };
    this.routes = result.paths.map((p) => this.screenRoute(p));
    this.target = null;
    this.resetLayers();
  }

  /** A path in metres as a polyline on the stage, with its length. */
  screenRoute(p) {
    const pts = [];
    let len = 0;
    for (let i = 0; i < p.pts.length; i += 2) {
      const [x, y] = this.toScreen(p.pts[i], p.pts[i + 1]);
      if (pts.length) len += Math.hypot(x - pts[pts.length - 2], y - pts[pts.length - 1]);
      pts.push(x, y);
    }
    return { pts, len };
  }

  /**
   * A place the friends could go instead: its routes replace the ones to
   * the meeting point in the finished picture. null clears it.
   */
  setTarget(t) {
    if (!t || !this.geo) {
      this.target = null;
      return;
    }
    this.target = { ...t, routes: t.paths.map((p) => this.screenRoute(p)), x: this.geo.nx[t.node], y: this.geo.ny[t.node] };
  }

  /** Where the sign above a chosen place goes. */
  targetSign(ctx) {
    const t = this.target;
    ctx.save();
    ctx.font = `500 28px ${FONT_SANS}`;
    const w = ctx.measureText(t.name).width + 32;
    ctx.restore();
    const h = 48;
    return { x: Math.max(16, Math.min(STAGE_W - 16 - w, t.x - w / 2)), y: t.y - 36 - h, w, h };
  }

  drawTarget(ctx, st) {
    const t = this.target;
    const k = easeOut(st.routes);
    ctx.save();
    for (const [r, c] of [[24, INK_DEEP], [19, ACCENT], [7, INK_DEEP]]) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * k, 0, Math.PI * 2);
      ctx.fill();
    }
    const sign = this.targetSign(ctx);
    ctx.globalAlpha = clamp01(st.routes * 1.5);
    ctx.beginPath();
    ctx.roundRect(sign.x, sign.y, sign.w, sign.h, 8);
    ctx.fillStyle = INK_CARD;
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `500 28px ${FONT_SANS}`;
    ctx.fillStyle = TEXT1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.name, sign.x + 16, sign.y + sign.h / 2 + 1);
    ctx.restore();
  }

  resetLayers() {
    this.layerA.getContext('2d').clearRect(0, 0, STAGE_W, STAGE_H);
    this.layerB.getContext('2d').clearRect(0, 0, STAGE_W, STAGE_H);
    this.lastT = -1;
    this.layerOwner = null;
    if (this.players) {
      for (const p of this.players.separate) p.reset();
      for (const p of this.players.together) p.reset();
    }
  }

  /**
   * Brings the flood layers to time t. Moving backwards replays from zero.
   */
  syncLayers(tl, t) {
    if (!this.players) return;
    if (t < this.lastT) this.resetLayers();
    const ctxA = this.layerA.getContext('2d');
    const ctxB = this.layerB.getContext('2d');
    const together = tl.segments.find((s) => s.kind === 'together');
    for (const seg of tl.segments) {
      if (seg.t0 > t) break;
      if (seg.t1 <= this.lastT) continue;
      // the together phase starts from clear layers, so earlier floods need not be drawn
      if ((seg.kind === 'separate' || seg.kind === 'gap') && together && t >= together.t0) continue;
      const p = clamp01((t - seg.t0) / (seg.t1 - seg.t0));
      if (seg.kind === 'separate') {
        if (this.layerOwner !== seg) {
          // previous search moves to the fading layer
          ctxB.clearRect(0, 0, STAGE_W, STAGE_H);
          ctxB.drawImage(this.layerA, 0, 0);
          ctxA.clearRect(0, 0, STAGE_W, STAGE_H);
          this.layerOwner = seg;
        }
        this.players.separate[seg.index].advance(ctxA, seg.rMax * p);
      } else if (seg.kind === 'gap') {
        if (this.layerOwner !== seg) {
          ctxB.clearRect(0, 0, STAGE_W, STAGE_H);
          ctxB.drawImage(this.layerA, 0, 0);
          ctxA.clearRect(0, 0, STAGE_W, STAGE_H);
          this.layerOwner = seg;
        }
      } else if (seg.kind === 'together') {
        if (this.layerOwner !== seg) {
          ctxB.clearRect(0, 0, STAGE_W, STAGE_H);
          ctxA.clearRect(0, 0, STAGE_W, STAGE_H);
          this.layerOwner = seg;
        }
        ctxA.save();
        ctxA.globalCompositeOperation = 'lighter';
        ctxA.lineCap = 'round';
        for (const pl of this.players.together) pl.advance(ctxA, seg.rMax * p, 0.55);
        if (p >= 1) for (const pl of this.players.together) pl.finalize(ctxA, 0.55);
        ctxA.restore();
      }
    }
    this.lastT = t;
  }

  /**
   * Paints one frame.
   * @param {object} tl     timeline from timeline.js
   * @param {number} t      seconds
   * @param {object} ui     { selected, placing, hover, meetName, editing }
   */
  draw(tl, t, ui = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = INK_DEEP;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    if (!this.view) {
      ctx.restore();
      return;
    }
    const st = tl ? tl.at(t) : null;
    if (tl) this.syncLayers(tl, t);

    // base map
    ctx.globalAlpha = st ? smooth(st.baseIn) : 1;
    ctx.drawImage(this.base, 0, 0);
    ctx.globalAlpha = 1;

    if (st) {
      if (st.fadeB > 0.001) {
        ctx.globalAlpha = st.fadeB;
        ctx.drawImage(this.layerB, 0, 0);
      }
      ctx.globalAlpha = st.dimA;
      ctx.drawImage(this.layerA, 0, 0);
      ctx.globalAlpha = 1;

      // wavefronts
      const bands =
        st.phase === 'separate' ? [this.players.separate[st.index]] : st.bandFade > 0 ? this.players.together : [];
      if (bands.length) {
        const g = this.glow.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, this.glow.width, this.glow.height);
        g.setTransform(0.25, 0, 0, 0.25, 0, 0);
        g.globalCompositeOperation = 'lighter';
        g.lineCap = 'round';
        g.lineJoin = 'round';
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        for (const pl of bands) pl.drawBand(ctx, g, st.radius, this.bandWidth, st.bandFade);
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.glow, 0, 0, STAGE_W, STAGE_H);
        ctx.restore();
      }

      if (st.meetIn > 0) this.drawZone(ctx, st.meetIn);
      if (st.routes > 0) this.drawRoutes(ctx, st.routes);
    }

    this.drawFriends(ctx, st, ui);
    if (st && st.meetIn > 0) this.drawMeet(ctx, st, ui.meetName);
    if (st && this.target && st.routes > 0) this.drawTarget(ctx, st);
    this.drawCaptions(ctx, st, ui);
    ctx.restore();
  }

  /** Streets where every trip stays close to the fairest, lit in amber. */
  drawZone(ctx, k) {
    const edges = this.result.zoneEdges;
    if (!edges || !edges.length) return;
    const path = new Path2D();
    for (const e of edges) this.geo.addEdge(path, e);
    ctx.save();
    ctx.globalAlpha = smooth(k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK_DEEP;
    ctx.lineWidth = 9;
    ctx.stroke(path);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 4.5;
    ctx.stroke(path);
    ctx.restore();
  }

  /** Each friend's route as a flat transit line with a dark casing. */
  drawRoutes(ctx, progress) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    (this.target ? this.target.routes : this.routes).forEach((route, i) => {
      const path = new Path2D();
      const target = route.len * smooth(progress);
      const p = route.pts;
      path.moveTo(p[0], p[1]);
      let acc = 0;
      for (let k = 2; k < p.length; k += 2) {
        const d = Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
        if (acc + d >= target) {
          const f = d > 0 ? (target - acc) / d : 0;
          path.lineTo(p[k - 2] + (p[k] - p[k - 2]) * f, p[k - 1] + (p[k + 1] - p[k - 1]) * f);
          break;
        }
        path.lineTo(p[k], p[k + 1]);
        acc += d;
      }
      ctx.strokeStyle = INK_DEEP;
      ctx.lineWidth = 17;
      ctx.stroke(path);
      ctx.strokeStyle = this.friends[i].color;
      ctx.lineWidth = 10;
      ctx.stroke(path);
    });
    ctx.restore();
  }

  meetScreen() {
    const m = this.result.meet;
    return [this.geo.nx[m], this.geo.ny[m]];
  }

  /** Where the station sign under the meeting point goes. */
  meetSign(ctx, name) {
    const [x, y] = this.meetScreen();
    ctx.save();
    ctx.font = `500 30px ${FONT_SANS}`;
    const label = name || 'Fairest point';
    const w = ctx.measureText(label).width + 32;
    ctx.restore();
    const h = 52;
    return { label, x: Math.max(16, Math.min(STAGE_W - 16 - w, x - w / 2)), y: y + 40, w, h };
  }

  /** The meeting point, drawn like an interchange where every line arrives. */
  drawMeet(ctx, st, name) {
    const [x, y] = this.meetScreen();
    const k = easeOut(st.meetIn);
    ctx.save();
    ctx.globalAlpha = clamp01(st.meetIn * 1.5);
    for (const [r, c] of [[30, INK_DEEP], [25, TEXT1], [17, INK_DEEP], [9, TEXT1]]) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x, y, r * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const sign = this.meetSign(ctx, name);
    ctx.save();
    ctx.globalAlpha = clamp01((st.meetIn - 0.3) / 0.7);
    ctx.fillStyle = TEXT1;
    ctx.beginPath();
    ctx.roundRect(sign.x, sign.y, sign.w, sign.h, 8);
    ctx.fill();
    ctx.font = `500 30px ${FONT_SANS}`;
    ctx.fillStyle = INK_DEEP;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(sign.label, sign.x + 16, sign.y + sign.h / 2 + 1);
    ctx.restore();
  }

  drawFriends(ctx, st, ui) {
    if (!this.friends || !this.geo) return;
    const showDist = st && st.routes >= 0.98 && this.result;
    const shown = [];
    this.friends.forEach((f, i) => {
      if (f.node == null || f.node < 0) return;
      const x = this.geo.nx[f.node];
      const y = this.geo.ny[f.node];
      const pop = st ? easeOut(st.pop[i] ?? 1) : 1;
      if (pop <= 0.001) return;
      const selected = ui.selected === i;
      if (selected) {
        ctx.save();
        ctx.strokeStyle = TEXT1;
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, 28, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      drawTerminus(ctx, x, y, 16 * pop, f.color);
      shown.push({ f, i, x, y, rad: selected ? 30 : 20 });
    });

    // station-name plates, placed so they avoid each other and the markers
    const H = 44;
    const PAD = 12;
    const CHIP = 6;
    const taken = shown.map((m) => ({ x: m.x - m.rad, y: m.y - m.rad, w: m.rad * 2, h: m.rad * 2, owner: m.i }));
    if (st && st.meetIn > 0 && this.result && this.result.meet >= 0) {
      const [mx, my] = this.meetScreen();
      const sign = this.meetSign(ctx, ui.meetName);
      taken.push({ x: mx - 32, y: my - 32, w: 64, h: 64, owner: -1 }, { ...sign, owner: -1 });
      if (this.target) {
        taken.push({ x: this.target.x - 26, y: this.target.y - 26, w: 52, h: 52, owner: -1 }, { ...this.targetSign(ctx), owner: -1 });
      }
    }
    ctx.save();
    for (const m of shown) {
      const { f, i, x, y, rad } = m;
      const name = this.nameOf(f);
      const trip = this.target ? this.target.km[i] : this.result?.paths[i].length / 1000;
      const detail = showDist ? `${trip.toFixed(1)} km` : f.place || '';
      ctx.font = `500 25px ${FONT_SANS}`;
      const wName = ctx.measureText(name).width;
      ctx.font = showDist ? `500 23px ${FONT_MONO}` : `400 23px ${FONT_SANS}`;
      const wDetail = detail ? ctx.measureText(detail).width : 0;
      const w = PAD + CHIP + 10 + wName + (detail ? 10 + wDetail : 0) + PAD;
      const spots = [
        [x, y - rad - 8 - H / 2],
        [x, y + rad + 8 + H / 2],
        [x + rad + 8 + w / 2, y],
        [x - rad - 8 - w / 2, y],
        [x, y - rad - 16 - H * 1.5],
        [x, y + rad + 16 + H * 1.5],
      ];
      let best = null;
      let bestOverlap = Infinity;
      for (const [cx0, cy] of spots) {
        const cx = Math.max(16 + w / 2, Math.min(STAGE_W - 16 - w / 2, cx0));
        const r = { x: cx - w / 2, y: cy - H / 2, w, h: H };
        let overlap = 0;
        for (const o of taken) {
          if (o.owner === i) continue;
          const ox = Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x);
          const oy = Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y);
          if (ox > 0 && oy > 0) overlap += ox * oy;
        }
        if (overlap < bestOverlap) {
          bestOverlap = overlap;
          best = r;
        }
        if (overlap === 0) break;
      }
      taken.push({ ...best, owner: i });

      ctx.globalAlpha = clamp01((st ? st.pop[i] ?? 1 : 1) * 1.4 - 0.4);
      ctx.beginPath();
      ctx.roundRect(best.x, best.y, best.w, best.h, 8);
      ctx.fillStyle = INK_CARD;
      ctx.fill();
      ctx.strokeStyle = HAIRLINE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.roundRect(best.x + PAD, best.y + 11, CHIP, H - 22, 2);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const ty = best.y + H / 2 + 1;
      let tx = best.x + PAD + CHIP + 10;
      ctx.font = `500 25px ${FONT_SANS}`;
      ctx.fillStyle = TEXT1;
      ctx.fillText(name, tx, ty);
      if (detail) {
        tx += wName + 10;
        ctx.font = showDist ? `500 23px ${FONT_MONO}` : `400 23px ${FONT_SANS}`;
        ctx.fillStyle = TEXT2;
        ctx.fillText(detail, tx, ty);
      }
    }
    ctx.restore();
  }

  /** Bottom of the drawn map, in stage pixels. */
  mapBottom() {
    return this.view.oy - this.city.outlineBounds.minY * this.view.s;
  }

  /** One suggestion per kind of outing, in the space under the map. */
  drawPicks(ctx, picks, alpha) {
    const top = Math.max(this.mapBottom() + 40, 1480);
    if (top + 88 > 1640) return;
    const L = 56;
    const colW = (STAGE_W - L * 2 - 24 * (picks.length - 1)) / picks.length;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    picks.forEach((p, i) => {
      const x = L + i * (colW + 24);
      ctx.font = `400 22px ${FONT_SANS}`;
      ctx.fillStyle = TEXT3;
      ctx.fillText(p.label, x, top + 22);
      ctx.font = `500 26px ${FONT_SANS}`;
      ctx.fillStyle = TEXT1;
      ctx.fillText(ellipsize(ctx, p.name, colW), x, top + 58);
      ctx.font = `400 22px ${FONT_MONO}`;
      ctx.fillStyle = TEXT2;
      ctx.fillText(ellipsize(ctx, p.detail || '', colW), x, top + 88);
    });
    ctx.restore();
  }

  drawCaptions(ctx, st, ui) {
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const L = 56;
    const R = STAGE_W - 56;

    ctx.font = `500 30px ${FONT_SANS}`;
    ctx.fillStyle = TEXT2;
    ctx.fillText('Tempo', L, 104);

    const friends = this.friends || [];
    if (!st || st.phase === 'intro') {
      ctx.font = `500 60px ${FONT_SANS}`;
      ctx.fillStyle = TEXT1;
      fitText(ctx, `Where should ${friends.length} friends meet?`, L, 196, R - L);
      ctx.font = `400 32px ${FONT_SANS}`;
      ctx.fillStyle = TEXT2;
      fitText(ctx, ui.hint || namesLine(friends.map(this.nameOf)), L, 252, R - L);
    } else {
      // the one figure that matters, in the accent
      const roads = st.roads.toLocaleString('en-US');
      ctx.font = `500 52px ${FONT_MONO}`;
      const figW = Math.max(ctx.measureText(roads).width, 170);
      ctx.textAlign = 'right';
      ctx.fillStyle = ACCENT;
      ctx.fillText(roads, R, 196);
      ctx.font = `400 24px ${FONT_SANS}`;
      ctx.fillStyle = TEXT3;
      ctx.fillText('roads checked', R, 232);
      ctx.textAlign = 'left';
      ctx.font = `500 60px ${FONT_SANS}`;
      ctx.fillStyle = TEXT1;
      fitText(ctx, st.title, L, 196, R - L - figW - 32);
      let sub = st.subtitle;
      if (sub === '@meet' && this.target && st.routes > 0) sub = `Going to ${this.target.name}`;
      else if (sub === '@meet') sub = ui.meetName ? `Meet around ${ui.meetName}` : 'The fairest spot for everyone';
      ctx.font = `400 32px ${FONT_SANS}`;
      ctx.fillStyle = TEXT2;
      fitText(ctx, sub, L, 276, R - L);
    }

    if (st && st.routes > 0.5 && ui.picks && ui.picks.length) this.drawPicks(ctx, ui.picks, clamp01((st.routes - 0.5) * 2));

    if (this.city) {
      // legend for the lit streets, once they show
      if (st && st.meetIn > 0.5 && this.result && Number.isFinite(this.result.zoneLimit)) {
        ctx.globalAlpha = clamp01((st.meetIn - 0.5) * 2);
        ctx.fillStyle = ACCENT;
        ctx.beginPath();
        ctx.roundRect(L, 1672, 28, 6, 2);
        ctx.fill();
        ctx.font = `400 24px ${FONT_SANS}`;
        ctx.fillStyle = TEXT2;
        ctx.textBaseline = 'middle';
        const legend = this.target && st.routes > 0
          ? `Longest trip ${this.target.longest.toFixed(1)} km, ${this.target.extra < 0.3 ? 'no longer than at the fairest spot' : `${this.target.extra.toFixed(1)} km more than at the fairest spot`}`
          : `On the lit streets nobody travels more than ${(this.result.zoneLimit / 1000).toFixed(1)} km`;
        fitText(ctx, legend, L + 40, 1676, R - L - 40);
        ctx.textBaseline = 'alphabetic';
        ctx.globalAlpha = 1;
      }
      ctx.font = `500 44px ${FONT_SANS}`;
      ctx.fillStyle = TEXT1;
      fitText(ctx, this.city.name, L, 1756, R - L);
      ctx.font = `400 22px ${FONT_SANS}`;
      ctx.fillStyle = TEXT3;
      ctx.fillText('Map data © OpenStreetMap contributors', L, 1796);
    }
    ctx.restore();
  }
}

/** Shortens text with an ellipsis so it fits maxW. */
function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

function namesLine(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length <= 4) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
}

/** Left-aligned text, squeezed to fit maxW when it is too long. */
function fitText(ctx, text, x, y, maxW) {
  const w = ctx.measureText(text).width;
  if (w <= maxW) {
    ctx.fillText(text, x, y);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(maxW / w, maxW / w);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** A friend's starting point: a filled circle in their line colour. */
export function drawTerminus(ctx, x, y, r, color) {
  if (r <= 0.5) return;
  ctx.save();
  ctx.fillStyle = INK_DEEP;
  ctx.beginPath();
  ctx.arc(x, y, r + 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK_DEEP;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
