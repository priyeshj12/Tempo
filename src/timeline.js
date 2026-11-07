// The sequence of the animation and what every moment of it shows.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * @param {object} result   from search.solve
 * @param {Array}  friends  [{name}]
 * @param {object} opts     { separate: bool, speed: number }
 */
export function buildTimeline(result, friends, { separate = true, speed = 1 } = {}) {
  const k = friends.length;
  const segs = [];
  let t = 0;
  const add = (kind, dur, extra = {}) => {
    const seg = { kind, t0: t, t1: t + dur / speed, ...extra };
    segs.push(seg);
    t = seg.t1;
    return seg;
  };

  add('intro', 1.8);
  if (separate && result.separate.length) {
    // about 8 to 10 seconds for the whole phase, however many friends
    const per = Math.max(0.8, Math.min(2.1, 9 / k));
    result.separate.forEach((f, i) => {
      add('separate', per, { index: i, rMax: f.maxRadius });
      add('pause', k > 6 ? 0.1 : 0.18, { index: i });
    });
    add('gap', 0.8);
  }
  add('together', 3.8, { rMax: result.radius });
  add('meet', 0.9);
  add('routes', 1.9);
  add('hold', 3);

  const roadsSeparateBefore = [];
  let acc = 0;
  for (const f of result.separate) {
    roadsSeparateBefore.push(acc);
    acc += f.entered;
  }

  return {
    segments: segs,
    duration: t,
    at(time) {
      return frameAt(segs, time, result, friends, roadsSeparateBefore);
    },
  };
}

function frameAt(segs, time, result, friends, before) {
  const k = friends.length;
  let seg = segs[segs.length - 1];
  for (const s of segs) {
    if (time < s.t1) {
      seg = s;
      break;
    }
  }
  const p = clamp01((time - seg.t0) / (seg.t1 - seg.t0));
  const intro = segs[0];
  const st = {
    t: time,
    phase: seg.kind,
    progress: p,
    baseIn: clamp01((time - intro.t0) / (0.35 * (intro.t1 - intro.t0))),
    pop: friends.map((_, i) => {
      const span = intro.t1 - intro.t0;
      const start = intro.t0 + span * (0.25 + (0.45 * i) / Math.max(1, k));
      return clamp01((time - start) / (span * 0.3));
    }),
    fadeB: 0,
    dimA: 1,
    bandFade: 0,
    radius: 0,
    meetIn: 0,
    routes: 0,
    title: '',
    subtitle: '',
    roads: 0,
  };

  const togetherSeg = segs.find((s) => s.kind === 'together');
  const together = (r) => result.together.reduce((a, f) => a + f.countAt(r), 0);

  switch (seg.kind) {
    case 'intro':
      break;
    case 'separate':
    case 'pause': {
      const i = seg.index;
      const f = result.separate[i];
      const r = seg.kind === 'pause' ? f.maxRadius : f.maxRadius * p;
      st.phase = 'separate';
      st.index = i;
      st.radius = r;
      st.bandFade = seg.kind === 'pause' ? 1 - p : 1;
      st.title = 'One by one';
      st.subtitle = `${friends[i].name}'s search, ${i + 1} of ${k}`;
      st.roads = before[i] + f.countAt(r);
      if (seg.kind === 'separate' && i > 0) st.fadeB = 1 - clamp01(p / 0.35);
      break;
    }
    case 'gap': {
      st.fadeB = 1 - p;
      st.title = 'All at once';
      st.subtitle = `All ${k} set off together`;
      st.roads = 0;
      break;
    }
    case 'together': {
      const r = seg.rMax * p;
      st.radius = r;
      st.bandFade = 1;
      st.title = 'All at once';
      st.subtitle = r >= result.firstCross ? 'The floods cross' : `All ${k} set off together`;
      st.roads = together(r);
      break;
    }
    default: {
      // meet, routes, hold
      const r = togetherSeg.rMax;
      st.radius = r;
      st.title = 'All at once';
      st.subtitle = '@meet';
      st.roads = result.roadsTogether;
      const meet = segs.find((s) => s.kind === 'meet');
      const routes = segs.find((s) => s.kind === 'routes');
      st.bandFade = 1 - clamp01((time - meet.t0) / (meet.t1 - meet.t0));
      st.meetIn = clamp01((time - meet.t0) / (meet.t1 - meet.t0));
      st.routes = clamp01((time - routes.t0) / (routes.t1 - routes.t0));
      st.dimA = 1 - 0.3 * st.routes;
    }
  }
  return st;
}
