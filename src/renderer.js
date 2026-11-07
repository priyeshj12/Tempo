// Draws the 9:16 stage: road network, floods, markers, routes and captions.
// Everything is painted on one canvas so it can be recorded as a video.

export const STAGE_W = 1080;
export const STAGE_H = 1920;
const MAP = { x: 50, y: 330, w: 980, h: 1300 };

export const FONT_SANS = '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif';
export const FONT_MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

const BASE_ROAD = 'rgba(176, 128, 74, 0.30)';
const OUTLINE = 'rgba(255, 176, 72, 0.85)';
const OUTLINE_GLOW = 'rgba(255, 150, 40, 0.16)';

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
const easeOutBack = (x) => {
  x = clamp01(x);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

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
    ctx.fillStyle = 'rgba(255, 170, 70, 0.025)';
    ctx.fill(outline, 'evenodd');

    const roads = new Path2D();
    for (let e = 0; e < this.graph.nEdges; e++) this.geo.addEdge(roads, e);
    ctx.lineCap = 'round';
    ctx.strokeStyle = BASE_ROAD;
    ctx.lineWidth = 1.1;
    ctx.stroke(roads);

    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE_GLOW;
    ctx.lineWidth = 14;
    ctx.stroke(outline);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2.6;
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
    this.routes = result.paths.map((p) => {
      const pts = [];
      let len = 0;
      for (let i = 0; i < p.pts.length; i += 2) {
        const [x, y] = this.toScreen(p.pts[i], p.pts[i + 1]);
        if (pts.length) len += Math.hypot(x - pts[pts.length - 2], y - pts[pts.length - 1]);
        pts.push(x, y);
      }
      return { pts, len };
    });
    this.resetLayers();
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
    ctx.fillStyle = '#000';
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

      if (st.meetIn > 0) this.drawMeetRing(ctx, st);
      if (st.routes > 0) this.drawRoutes(ctx, st.routes);
    }

    this.drawFriends(ctx, st, ui);
    if (st && st.meetIn > 0) this.drawMeetPin(ctx, st, ui.meetName);
    this.drawCaptions(ctx, st, ui);
    ctx.restore();
  }

  drawRoutes(ctx, progress) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.routes.forEach((route, i) => {
      const rgb = hexToRgb(this.friends[i].color);
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
      ctx.strokeStyle = rgba(rgb, 0.28);
      ctx.lineWidth = 30;
      ctx.stroke(path);
      ctx.strokeStyle = rgba(rgb, 0.95);
      ctx.lineWidth = 11;
      ctx.stroke(path);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = 4;
      ctx.stroke(path);
    });
    ctx.restore();
  }

  meetScreen() {
    const g = this.graph;
    const m = this.result.meet;
    return [this.geo.nx[m], this.geo.ny[m]];
  }

  drawMeetRing(ctx, st) {
    const [x, y] = this.meetScreen();
    const pulse = (st.t * 0.9) % 1;
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - pulse) * st.meetIn})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 14 + pulse * 46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawMeetPin(ctx, st, name) {
    const [x, y] = this.meetScreen();
    const k = easeOutBack(st.meetIn);
    ctx.save();
    // avatars above the pin
    const n = this.friends.length;
    const r = 17;
    const gap = 30;
    const ay = y - 108 * k;
    ctx.globalAlpha = clamp01(st.meetIn * 2);
    this.friends.forEach((f, i) => {
      const ax = x + (i - (n - 1) / 2) * gap;
      drawAvatar(ctx, ax, ay, r * k, f.color, 0.9);
    });
    // pin
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-8, -14, -24, -28, -24, -46);
    ctx.arc(0, -46, 24, Math.PI, 0);
    ctx.bezierCurveTo(24, -28, 8, -14, 0, 0);
    ctx.fill();
    ctx.shadowBlur = 0;
    // cup glyph
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.roundRect(-11, -56, 17, 16, [0, 0, 6, 6]);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#111';
    ctx.beginPath();
    ctx.arc(8, -49, 4.5, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-6, -60);
    ctx.quadraticCurveTo(-3, -64, -6, -68);
    ctx.moveTo(1, -60);
    ctx.quadraticCurveTo(4, -64, 1, -68);
    ctx.stroke();
    ctx.restore();

    // name tag under the pin
    if (name) {
      ctx.save();
      ctx.globalAlpha = clamp01((st.meetIn - 0.3) / 0.7);
      ctx.font = `800 30px ${FONT_SANS}`;
      drawTag(ctx, name, x, y + 34, {
        fill: '#fff',
        text: '#0a0a0f',
        stroke: null,
        padX: 16,
        h: 48,
      });
      ctx.restore();
    }
  }

  drawFriends(ctx, st, ui) {
    if (!this.friends || !this.geo) return;
    const showDist = st && st.routes >= 0.98;
    const shown = [];
    this.friends.forEach((f, i) => {
      if (f.node == null || f.node < 0) return;
      const x = this.geo.nx[f.node];
      const y = this.geo.ny[f.node];
      const pop = st ? easeOutBack(st.pop[i] ?? 1) : 1;
      if (pop <= 0.001) return;
      const selected = ui.selected === i;
      const rad = (selected ? 36 : 31) * pop;
      ctx.save();
      if (selected) {
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, rad + 11, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      drawAvatar(ctx, x, y, rad, f.color, 1);
      ctx.restore();
      shown.push({ f, i, x, y, rad });
    });

    // labels go on top of every marker, placed to avoid each other
    ctx.save();
    ctx.font = `700 25px ${FONT_SANS}`;
    const H = 38;
    const pad = 12;
    const taken = shown.map((m) => ({ x: m.x - m.rad, y: m.y - m.rad, w: m.rad * 2, h: m.rad * 2, owner: m.i }));
    if (st && st.meetIn > 0 && this.result && this.result.meet >= 0) {
      const [mx, my] = this.meetScreen();
      taken.push({ x: mx - 70, y: my - 130, w: 140, h: 190, owner: -1 });
    }
    for (const m of shown) {
      const { f, i, x, y, rad } = m;
      const label = showDist && this.result
        ? `${f.name} · ${(this.result.paths[i].length / 1000).toFixed(1)} km`
        : f.place ? `${f.name} · ${f.place}` : f.name;
      const w = ctx.measureText(label).width + pad * 2;
      const spots = [
        [x, y - rad - 14 - H / 2],
        [x, y + rad + 14 + H / 2],
        [x + rad + 12 + w / 2, y],
        [x - rad - 12 - w / 2, y],
        [x, y - rad - 24 - H * 1.5],
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
          best = { cx, cy, r };
        }
        if (overlap === 0) break;
      }
      taken.push({ ...best.r, owner: i });
      const rgb = hexToRgb(f.color);
      ctx.globalAlpha = clamp01((st ? st.pop[i] ?? 1 : 1) * 1.4 - 0.4);
      drawTag(ctx, label, best.cx, best.cy, {
        fill: 'rgba(8, 8, 12, 0.88)',
        text: rgba(mix(rgb, [255, 255, 255], 0.25), 1),
        stroke: rgba(rgb, 0.95),
        padX: pad,
        h: H,
      });
    }
    ctx.restore();
  }

  drawCaptions(ctx, st, ui) {
    ctx.save();
    ctx.textBaseline = 'alphabetic';

    // wordmark
    ctx.font = `800 30px ${FONT_SANS}`;
    ctx.textAlign = 'left';
    const wm = ctx.createLinearGradient(56, 0, 200, 0);
    wm.addColorStop(0, '#5ee7ff');
    wm.addColorStop(1, '#a98bff');
    ctx.fillStyle = wm;
    ctx.beginPath();
    ctx.arc(66, 96, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText('tempo', 84, 106);

    const n = this.friends ? this.friends.length : 0;
    const cx = STAGE_W / 2;
    if (!st || st.phase === 'intro' || st.phase === 'edit') {
      ctx.font = `800 62px ${FONT_SANS}`;
      ctx.textAlign = 'center';
      const text = `Where should ${n} friends meet?`;
      const w = ctx.measureText(text).width;
      const grad = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
      grad.addColorStop(0, '#46e0ff');
      grad.addColorStop(1, '#a67cff');
      ctx.fillStyle = grad;
      fitText(ctx, text, cx, 212, STAGE_W - 80);
      if (ui.hint) {
        ctx.font = `600 32px ${FONT_SANS}`;
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        fitText(ctx, ui.hint, cx, 270, STAGE_W - 100);
      }
    } else {
      drawCounterLine(ctx, st.title, st.roads, cx, 212);
      ctx.font = `700 36px ${FONT_SANS}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      let sub = st.subtitle;
      if (st.subtitle === '@meet') sub = ui.meetName ? `Meet near ${ui.meetName}` : 'Everyone can meet here';
      fitText(ctx, sub, cx, 270, STAGE_W - 100);
    }

    // footer
    if (this.city) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.font = `800 50px ${FONT_SANS}`;
      spacedText(ctx, this.city.name.toUpperCase(), cx, 1730, 12);
      ctx.font = `500 23px ${FONT_SANS}`;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText('© OpenStreetMap contributors', cx, 1778);
    }
    ctx.restore();
  }
}

function drawCounterLine(ctx, title, roads, cx, y) {
  const parts = [
    { text: title, font: `900 68px ${FONT_SANS}`, color: 'title' },
    { text: '  ·  ', font: `700 40px ${FONT_SANS}`, color: 'rgba(255,255,255,0.55)' },
    { text: roads.toLocaleString('en-US'), font: `700 52px ${FONT_MONO}`, color: '#ff5cae' },
    { text: ' roads', font: `700 38px ${FONT_SANS}`, color: 'rgba(255,255,255,0.6)' },
  ];
  ctx.textAlign = 'left';
  let total = 0;
  for (const p of parts) {
    ctx.font = p.font;
    p.w = ctx.measureText(p.text).width;
    total += p.w;
  }
  const scale = Math.min(1, (STAGE_W - 70) / total);
  ctx.save();
  ctx.translate(cx, y);
  ctx.scale(scale, scale);
  let x = -total / 2;
  for (const p of parts) {
    ctx.font = p.font;
    if (p.color === 'title') {
      const g = ctx.createLinearGradient(x, 0, x + p.w, 0);
      g.addColorStop(0, '#ff3d9a');
      g.addColorStop(1, '#ff6fb5');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = p.color;
    }
    ctx.fillText(p.text, x, 0);
    x += p.w;
  }
  ctx.restore();
}

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

function spacedText(ctx, text, cx, y, spacing) {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let x = cx - total / 2;
  ctx.save();
  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    ctx.fillText(c, x, y);
    x += widths[i] + spacing;
  });
  ctx.restore();
}

function drawTag(ctx, text, cx, cy, { fill, text: color, stroke, padX, h }) {
  const w = ctx.measureText(text).width + padX * 2;
  const x = Math.max(16, Math.min(STAGE_W - 16 - w, cx - w / 2));
  const y = cy - h / 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, cy + 1);
  ctx.textBaseline = 'alphabetic';
}

export function drawAvatar(ctx, x, y, r, color, alpha) {
  if (r <= 0.5) return;
  const rgb = hexToRgb(color);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.shadowColor = rgba(rgb, 0.9);
  ctx.shadowBlur = r * 0.8;
  ctx.fillStyle = '#0a0a10';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(2, r * 0.13);
  ctx.strokeStyle = color;
  ctx.stroke();
  // person glyph
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.86, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = rgba(mix(rgb, [255, 255, 255], 0.15), 1);
  ctx.beginPath();
  ctx.arc(x, y - r * 0.2, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.62, r * 0.56, r * 0.45, 0, Math.PI, 0);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}
