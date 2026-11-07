// Downloads a city's roads from Overpass and builds the graph off the main thread.

import { buildGraph, graphTransfer } from './graph.js';
import { makeProjection, PolygonIndex, projectPolygons } from './geo.js';
import { OVERPASS_ENDPOINTS } from './osm.js';

self.onmessage = async (ev) => {
  const { id, query, polygons, lon0, lat0 } = ev.data;
  const post = (msg, transfer) => self.postMessage({ id, ...msg }, transfer || []);
  try {
    const text = await fetchOverpass(query, (bytes) => post({ type: 'progress', stage: 'download', bytes }));
    post({ type: 'progress', stage: 'parse' });
    const data = JSON.parse(text);
    if (data.remark && /error/i.test(data.remark)) throw new Error(`Overpass: ${data.remark}`);
    const elements = data.elements || [];
    if (!elements.length) throw new Error('No roads found in this area.');

    const proj = makeProjection(lon0, lat0);
    const clip = new PolygonIndex(projectPolygons(polygons, proj));
    const g = buildGraph(elements, {
      proj,
      clip,
      progress: (p) => post({ type: 'progress', stage: 'build', fraction: p }),
    });
    if (g.nEdges < 30) throw new Error('Too few connected roads here. Try a bigger area.');
    const { raw, transfer } = graphTransfer(g);
    post({ type: 'done', graph: raw }, transfer);
  } catch (err) {
    post({ type: 'error', message: err.message || String(err) });
  }
};

async function fetchOverpass(query, onBytes) {
  let lastError;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      const reader = res.body.getReader();
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytes += value.length;
        onBytes(bytes);
      }
      const all = new Uint8Array(bytes);
      let off = 0;
      for (const c of chunks) {
        all.set(c, off);
        off += c.length;
      }
      return new TextDecoder().decode(all);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Could not download roads (${lastError?.message || 'network error'}). The Overpass servers may be busy; try again in a minute.`);
}
