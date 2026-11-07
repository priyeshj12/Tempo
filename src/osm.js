// OpenStreetMap services used from the browser: Nominatim for search and
// place names, Overpass for road networks of cities that are not bundled.

// Keep in sync with ROAD_CLASSES in scripts/extract_osm.py.
export const ROAD_CLASSES = {
  all: 'trunk|primary|secondary|tertiary|unclassified|residential|living_street|trunk_link|primary_link|secondary_link|tertiary_link',
  main: 'trunk|primary|secondary|tertiary|unclassified|trunk_link|primary_link|secondary_link|tertiary_link',
  major: 'trunk|primary|secondary|trunk_link|primary_link|secondary_link',
};

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const NOMINATIM = 'https://nominatim.openstreetmap.org';

// Nominatim's usage policy allows at most one request per second.
let queue = Promise.resolve();
let lastCall = 0;
const cache = new Map();

/**
 * Queued, rate-limited, cached Nominatim request. `stale` is checked right
 * before the request goes out, so lookups nobody needs any more are dropped
 * instead of holding up the queue. Only real fetches are cached, so one
 * caller giving up never affects another asking for the same URL.
 */
function nominatim(path, params, stale = null) {
  const url = `${NOMINATIM}/${path}?${new URLSearchParams({ format: 'jsonv2', 'accept-language': navigator.language || 'en', ...params })}`;
  if (cache.has(url)) return cache.get(url);
  const p = queue.then(async () => {
    if (stale && stale()) throw new Error('stale');
    if (cache.has(url)) return cache.get(url);
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (stale && stale()) throw new Error('stale');
    lastCall = Date.now();
    const req = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      return res.json();
    });
    cache.set(url, req);
    req.catch(() => cache.delete(url));
    return req;
  });
  queue = p.catch(() => {});
  return p;
}

/** Cities and regions with a boundary polygon. */
export async function searchCities(q) {
  const results = await nominatim('search', {
    q,
    limit: '8',
    polygon_geojson: '1',
    polygon_threshold: '0.0003',
    addressdetails: '1',
  });
  return results
    .filter((r) => r.geojson && /Polygon/.test(r.geojson.type))
    .map((r) => ({
      label: shortName(r),
      detail: r.display_name,
      osmType: r.osm_type,
      osmId: r.osm_id,
      lat: +r.lat,
      lon: +r.lon,
      bbox: r.boundingbox.map(Number), // [south, north, west, east]
      geojson: r.geojson,
    }));
}

/** Look a city up again by its OSM id (for shared links). */
export async function lookupCity(osmType, osmId) {
  const t = { relation: 'R', way: 'W', node: 'N' }[osmType] || osmType;
  const results = await nominatim('lookup', {
    osm_ids: `${t}${osmId}`,
    polygon_geojson: '1',
    polygon_threshold: '0.0003',
    addressdetails: '1',
  });
  const r = results[0];
  if (!r || !r.geojson) throw new Error('City not found');
  return {
    label: shortName(r),
    detail: r.display_name,
    osmType: r.osm_type,
    osmId: r.osm_id,
    lat: +r.lat,
    lon: +r.lon,
    bbox: r.boundingbox.map(Number),
    geojson: r.geojson,
  };
}

/** Places near a viewbox, for putting a friend somewhere by name. */
export async function searchPlaces(q, bbox) {
  const [w, s, e, n] = bbox;
  const results = await nominatim('search', {
    q,
    limit: '6',
    viewbox: `${w},${n},${e},${s}`,
    bounded: '1',
  });
  return results.map((r) => ({
    label: shortName(r),
    detail: r.display_name,
    lat: +r.lat,
    lon: +r.lon,
  }));
}

/** Short neighbourhood-level name for a point. */
export async function neighbourhoodName(lat, lon, stale = null) {
  const r = await nominatim('reverse', { lat: lat.toFixed(5), lon: lon.toFixed(5), zoom: '15', addressdetails: '1' }, stale);
  const a = r.address || {};
  return a.neighbourhood || a.quarter || a.suburb || a.city_district || a.village || a.town || r.name || '';
}

/**
 * A name people would recognise for the meeting point: the closest station
 * or park nearby (stations count as a bit closer, since they make better
 * meeting spots), else the neighbourhood.
 */
export async function landmarkName(lat, lon, stale = null) {
  const dLat = 0.008;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const viewbox = `${lon - dLon},${lat + dLat},${lon + dLon},${lat - dLat}`;
  const near = async (q) => {
    try {
      return await nominatim('search', { q, viewbox, bounded: '1', limit: '10' }, stale);
    } catch (err) {
      if (err.message === 'stale') throw err;
      return [];
    }
  };
  const metres = (r) =>
    Math.hypot((+r.lat - lat) * 111320, (+r.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180));

  // queue both now so they are not stuck behind lookups queued meanwhile
  const [stations, parks] = await Promise.all([near('station'), near('park')]);
  let best = null;
  let bestScore = Infinity;
  for (const r of stations) {
    if (!r.name || r.category !== 'railway') continue;
    const s = metres(r) / 1.6;
    if (metres(r) < 900 && s < bestScore) {
      bestScore = s;
      best = stationName(r.name);
    }
  }
  for (const r of parks) {
    if (!r.name || !['park', 'garden'].includes(r.type)) continue;
    const s = metres(r);
    if (s < 600 && s < bestScore) {
      bestScore = s;
      best = r.name;
    }
  }
  if (best) return best;

  const r = await nominatim('reverse', { lat: lat.toFixed(5), lon: lon.toFixed(5), zoom: '16', addressdetails: '1' }, stale);
  const a = r.address || {};
  return a.neighbourhood || a.quarter || a.suburb || a.city_district || r.name || a.road || '';
}

function stationName(name) {
  const ascii = /^[\x20-\x7e]+$/.test(name);
  const hasWord = /station|gare|bahnhof|estaci|stazione|stacja|metro|subway|terminal/i.test(name);
  return ascii && !hasWord ? `${name} Station` : name;
}

function shortName(r) {
  const a = r.address || {};
  return r.name || a.city || a.town || a.village || a.suburb || r.display_name.split(',')[0];
}

/** Runs a small Overpass query from the page, trying each server in turn. */
export async function overpass(query, { signal } = {}) {
  let lastError;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass is unreachable');
}

/**
 * Finds a starting point by name. Results near `near` ([lon, lat] bounds)
 * come first, but places elsewhere are still found.
 */
export async function geocode(q, near = null) {
  const params = { q, limit: '5', addressdetails: '1' };
  if (near) {
    const [w, s, e, n] = near;
    params.viewbox = `${w},${n},${e},${s}`;
  }
  const results = await nominatim('search', params);
  return results.map((r) => ({
    label: shortName(r),
    detail: r.display_name,
    lat: +r.lat,
    lon: +r.lon,
    city: cityOf(r.address),
    region: r.address ? r.address.state || r.address.region || r.address.county || '' : '',
    country: r.address ? r.address.country || '' : '',
  }));
}

/** Short name for a point, used when a friend is moved on the map. */
export async function placeName(lat, lon, stale = null) {
  const r = await nominatim('reverse', { lat: lat.toFixed(5), lon: lon.toFixed(5), zoom: '16', addressdetails: '1' }, stale);
  const a = r.address || {};
  return {
    label: a.neighbourhood || a.quarter || a.suburb || a.city_district || a.village || a.town || r.name || a.road || '',
    city: cityOf(a),
  };
}

function cityOf(a) {
  if (!a) return '';
  return a.city || a.town || a.village || a.municipality || a.county || '';
}

/** Overpass QL for every road of the given class inside a city. */
export function overpassQuery(city, detail) {
  const filter = `way["highway"~"^(${ROAD_CLASSES[detail]})$"]`;
  let where;
  if (city.osmType === 'relation') {
    where = `area(id:${3600000000 + Number(city.osmId)})->.a;\n${filter}(area.a);`;
  } else if (city.osmType === 'way') {
    where = `area(id:${2400000000 + Number(city.osmId)})->.a;\n${filter}(area.a);`;
  } else {
    const [s, n, w, e] = city.bbox;
    where = `${filter}(${s},${w},${n},${e});`;
  }
  return `[out:json][timeout:180][maxsize:1073741824];\n${where}\n(._;>;);\nout skel qt;`;
}
