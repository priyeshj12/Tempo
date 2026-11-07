// Things to do near the meeting point, from OpenStreetMap.
//
// Places are sorted into four groups and ranked by how far they are to walk
// from the meeting point along the road graph, with a nudge towards places
// that are well known (they have a Wikipedia or Wikidata link) and, for
// parks, towards bigger ones.

export const CATEGORIES = [
  { id: 'eat', label: 'Eat' },
  { id: 'activity', label: 'Activity' },
  { id: 'sightseeing', label: 'Sightseeing' },
  { id: 'chill', label: 'Chill' },
];

const WALK_M_PER_MIN = 80; // about 4.8 km/h

// OpenMapTiles poi subclasses are OSM tag values without their key; these
// are the keys to try, in order, when rebuilding tags for classify().
const POI_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'natural', 'historic'];

/**
 * Place candidates from the poi layer of z14 map tiles (see tiles.js),
 * shaped like candidatesFrom() results. Tiles carry no cuisine or Wikidata,
 * so these are plainer than Overpass results but arrive at once.
 */
export function candidatesFromTiles(tiles, tileLonLat, lang = 'en') {
  const out = [];
  const seen = new Set();
  for (const t of tiles) {
    const E = t.layer.extent;
    for (const f of t.layer.features) {
      const p = f.props;
      const name = p[`name:${lang}`] || (lang === 'en' && p.name_en) || p.name;
      if (!name || !p.subclass) continue;
      let cls = null;
      for (const key of POI_KEYS) {
        cls = classify({ name, [key]: p.subclass });
        if (cls) break;
      }
      if (!cls) continue;
      for (let i = 0; i < f.points.length; i += 2) {
        const [lon, lat] = tileLonLat(t.x + f.points[i] / E, t.y + f.points[i + 1] / E, t.z);
        const key = `${name}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: key,
          category: cls.category,
          kind: cls.kind,
          name,
          lat,
          lon,
          area: 0,
          notable: false,
          details: false,
          park: p.subclass === 'park' || p.subclass === 'garden',
          url: `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=19/${lat.toFixed(6)}/${lon.toFixed(6)}`,
        });
      }
    }
  }
  return out;
}

/** Overpass QL for named places of every group around a point. */
export function placesQuery(lat, lon, radius = 1200) {
  const at = `(around:${Math.round(radius)},${lat.toFixed(6)},${lon.toFixed(6)})`;
  const q = (filters) => filters.map((f) => `  nwr${at}["name"]${f};`).join('\n');
  return `[out:json][timeout:25];
(
${q(['["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"]', '["shop"~"^(bakery|pastry|confectionery)$"]'])}
);
out bb qt 250;
(
${q([
  '["amenity"~"^(cinema|theatre|arts_centre|karaoke_box)$"]',
  '["leisure"~"^(bowling_alley|escape_game|amusement_arcade|miniature_golf|water_park|trampoline_park|ice_rink|sports_centre)$"]',
  '["tourism"~"^(zoo|aquarium|theme_park)$"]',
  '["sport"="climbing"]',
])}
);
out bb qt 120;
(
${q(['["tourism"~"^(museum|gallery|attraction|viewpoint)$"]', '["historic"]', '["amenity"="place_of_worship"]["wikidata"]'])}
);
out bb qt 150;
(
${q([
  '["leisure"~"^(park|garden|nature_reserve|beach_resort|marina|sauna)$"]',
  '["natural"="beach"]',
  '["amenity"~"^(bar|pub|biergarten|public_bath|library)$"]',
])}
);
out bb qt 150;`;
}

const KINDS = {
  amenity: {
    cafe: ['eat', 'Café'],
    fast_food: ['eat', 'Fast food'],
    food_court: ['eat', 'Food court'],
    ice_cream: ['eat', 'Ice cream'],
    restaurant: ['eat', 'Restaurant'],
    cinema: ['activity', 'Cinema'],
    theatre: ['activity', 'Theatre'],
    arts_centre: ['activity', 'Arts centre'],
    karaoke_box: ['activity', 'Karaoke'],
    bar: ['chill', 'Bar'],
    pub: ['chill', 'Pub'],
    biergarten: ['chill', 'Beer garden'],
    public_bath: ['chill', 'Public bath'],
    library: ['chill', 'Library'],
  },
  shop: {
    bakery: ['eat', 'Bakery'],
    pastry: ['eat', 'Pastries'],
    confectionery: ['eat', 'Sweets'],
  },
  leisure: {
    bowling_alley: ['activity', 'Bowling'],
    escape_game: ['activity', 'Escape room'],
    amusement_arcade: ['activity', 'Arcade'],
    miniature_golf: ['activity', 'Mini golf'],
    water_park: ['activity', 'Water park'],
    trampoline_park: ['activity', 'Trampolines'],
    ice_rink: ['activity', 'Ice rink'],
    sports_centre: ['activity', 'Sports centre'],
    park: ['chill', 'Park'],
    garden: ['chill', 'Garden'],
    nature_reserve: ['chill', 'Nature reserve'],
    beach_resort: ['chill', 'Beach'],
    marina: ['chill', 'Marina'],
    sauna: ['chill', 'Sauna'],
  },
  tourism: {
    zoo: ['activity', 'Zoo'],
    aquarium: ['activity', 'Aquarium'],
    theme_park: ['activity', 'Theme park'],
    museum: ['sightseeing', 'Museum'],
    gallery: ['sightseeing', 'Gallery'],
    attraction: ['sightseeing', 'Attraction'],
    viewpoint: ['sightseeing', 'Viewpoint'],
  },
  natural: {
    beach: ['chill', 'Beach'],
  },
};

const HISTORIC = {
  castle: 'Castle',
  monument: 'Monument',
  memorial: 'Memorial',
  ruins: 'Ruins',
  archaeological_site: 'Archaeological site',
  building: 'Historic building',
  city_gate: 'City gate',
  ship: 'Historic ship',
  fort: 'Fort',
  manor: 'Manor',
  palace: 'Palace',
  tower: 'Tower',
  bridge: 'Historic bridge',
};

const WORSHIP = {
  buddhist: 'Temple',
  shinto: 'Shrine',
  christian: 'Church',
  muslim: 'Mosque',
  jewish: 'Synagogue',
  hindu: 'Temple',
  sikh: 'Gurdwara',
};

const notable = (tags) => !!(tags.wikidata || tags.wikipedia);

function cuisineLabel(c) {
  const first = String(c).split(/[;,]/)[0].trim();
  if (!first) return null;
  const words = first.replace(/_/g, ' ');
  if (words === 'coffee shop') return 'Coffee';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Which group a place belongs to and a short label for what it is. */
export function classify(tags) {
  if (!tags || !tags.name) return null;
  if (tags.sport === 'climbing' && (tags.leisure || tags.amenity || tags.shop)) return { category: 'activity', kind: 'Climbing' };
  for (const key of ['amenity', 'shop', 'tourism', 'leisure', 'natural']) {
    const hit = KINDS[key][tags[key]];
    if (!hit) continue;
    let [category, kind] = hit;
    if (category === 'eat' && tags.cuisine && tags.amenity !== 'cafe') kind = cuisineLabel(tags.cuisine) || kind;
    // a sports centre is only an outing when it is something you can drop in to
    if (tags.leisure === 'sports_centre' && !tags.sport) continue;
    return { category, kind };
  }
  if (tags.amenity === 'place_of_worship' && notable(tags)) {
    return { category: 'sightseeing', kind: WORSHIP[tags.religion] || 'Place of worship' };
  }
  if (tags.historic) {
    const kind = HISTORIC[tags.historic];
    // small plaques and stones are everywhere; keep the ones worth a detour
    if (kind && (notable(tags) || !['memorial', 'building', 'monument'].includes(tags.historic))) {
      return { category: 'sightseeing', kind };
    }
    if (notable(tags)) return { category: 'sightseeing', kind: 'Historic site' };
  }
  return null;
}

export function position(el) {
  if (el.lat != null && el.lon != null) return [el.lat, el.lon, 0];
  if (el.center) return [el.center.lat, el.center.lon, 0];
  if (el.bounds) {
    const b = el.bounds;
    const lat = (b.minlat + b.maxlat) / 2;
    const lon = (b.minlon + b.maxlon) / 2;
    const area =
      Math.abs(b.maxlat - b.minlat) * 111320 * Math.abs(b.maxlon - b.minlon) * 111320 * Math.cos((lat * Math.PI) / 180);
    return [lat, lon, area];
  }
  return null;
}

/**
 * Turns Overpass elements into place candidates:
 * { id, category, kind, name, lat, lon, area, notable, details }.
 */
export function candidatesFrom(elements, lang = 'en') {
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    const tags = el.tags || {};
    const cls = classify(tags);
    if (!cls) continue;
    const pos = position(el);
    if (!pos) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const [lat, lon, area] = pos;
    out.push({
      id,
      category: cls.category,
      kind: cls.kind,
      name: tags[`name:${lang}`] || tags.name,
      nameLocal: tags.name,
      nameEn: tags['name:en'] || '',
      lat,
      lon,
      area,
      notable: notable(tags),
      details: !!(tags.website || tags['contact:website'] || tags.opening_hours),
      park: tags.leisure === 'park' || tags.leisure === 'garden' || tags.leisure === 'nature_reserve',
    });
  }
  return out;
}

/**
 * Ranks Overpass elements into the four groups.
 *
 * @param {Array} elements      Overpass elements with tags and a position
 * @param {object} opts
 * @param {object} opts.graph   road graph (for snapping to the street network)
 * @param {Float64Array} opts.walk  metres from the meeting point to every node
 * @param {string} [opts.lang]  preferred language for names, like "en"
 * @param {number} [opts.limit] places per group
 */
export function rankPlaces(elements, opts) {
  return rankCandidates(candidatesFrom(elements, opts.lang), opts);
}

// How many stars one extra kilometre on the longest trip costs a place.
export const STARS_PER_EXTRA_KM = 0.15;

/**
 * How good a place is, on a star scale. Rated places use their rating,
 * pulled towards an average when few people rated them, plus a little for
 * being popular. OpenStreetMap places have no ratings, so being well known
 * (a Wikipedia or Wikidata link) and, for parks, size stand in.
 */
export function quality(p) {
  if (p.rating != null && p.reviews > 0) {
    const prior = 4.1;
    const weight = 25;
    const bayes = (p.rating * p.reviews + prior * weight) / (p.reviews + weight);
    return bayes + 0.12 * Math.log10(1 + p.reviews);
  }
  let q = 4.0;
  if (p.notable) q += 0.45;
  if (p.details) q += 0.05;
  if (p.park && p.area > 2000) q += Math.min(2, Math.log10(p.area / 2000)) * 0.2;
  return q;
}

/**
 * Ranks places for a group of friends: better places may be further away,
 * as long as they are worth the extra distance for whoever travels furthest.
 *
 * @param {Array} candidates  places with category, lat, lon and rating data
 * @param {object} ctx
 * @param {object} ctx.graph         road graph
 * @param {Float64Array[]} ctx.trips one array per friend: metres to every node
 * @param {number} ctx.fairest       longest trip to the fairest spot, metres
 * @returns {object} group -> [{...place, km: [per friend], longest, extra, fun, score}]
 */
export function rankByTrip(candidates, { graph, trips, fairest, limit = 6 }) {
  const groups = Object.fromEntries(CATEGORIES.map((c) => [c.id, []]));
  const maxExtra = Math.max(2, (0.4 * fairest) / 1000);
  for (const p of candidates) {
    if (!groups[p.category]) continue;
    const [x, y] = graph.proj.fwd(p.lon, p.lat);
    const node = graph.grid.nearest(x, y);
    const toRoad = Math.hypot(graph.nodeX[node] - x, graph.nodeY[node] - y);
    if (toRoad > 800) continue;
    const km = trips.map((d) => (d[node] + toRoad) / 1000);
    if (km.some((v) => !Number.isFinite(v))) continue;
    const longest = Math.max(...km);
    const extra = longest - fairest / 1000;
    if (extra > maxExtra) continue;
    const fun = quality(p);
    groups[p.category].push({ ...p, node, km, longest, extra, fun, score: fun - STARS_PER_EXTRA_KM * Math.max(0, extra) });
  }
  for (const c of CATEGORIES) {
    const out = [];
    const names = new Set();
    for (const p of groups[c.id].sort((a, b) => b.score - a.score)) {
      const key = p.name.toLowerCase();
      if (names.has(key)) continue;
      names.add(key);
      out.push(p);
      if (out.length >= limit) break;
    }
    groups[c.id] = out;
  }
  return groups;
}

/** Ranks place candidates into the four groups by walking distance. */
export function rankCandidates(candidates, { graph, walk, limit = 5 }) {
  const groups = Object.fromEntries(CATEGORIES.map((c) => [c.id, []]));
  for (const p of candidates) {
    const { lat, lon, area } = p;
    const [x, y] = graph.proj.fwd(lon, lat);
    const node = graph.grid.nearest(x, y);
    const toRoad = Math.hypot(graph.nodeX[node] - x, graph.nodeY[node] - y);
    if (toRoad > 400) continue; // not reachable from the streets we know
    const onRoad = walk[node];
    const metres = (Number.isFinite(onRoad) ? onRoad : 1e9) + toRoad;
    if (metres > 2500) continue;

    let boost = 1;
    if (p.notable) boost += 1.2;
    if (p.details) boost += 0.2;
    if (p.park && area > 2000) boost += Math.min(2, Math.log10(area / 2000)) * 0.6;

    groups[p.category].push({
      id: p.id,
      name: p.name,
      kind: p.kind,
      lat,
      lon,
      metres,
      minutes: Math.max(1, Math.round(metres / WALK_M_PER_MIN)),
      notable: p.notable,
      score: metres / boost,
      url: p.url || `https://www.openstreetmap.org/${p.id}`,
    });
  }

  for (const c of CATEGORIES) {
    const list = groups[c.id].sort((a, b) => a.score - b.score);
    const out = [];
    const names = new Set();
    const perKind = new Map();
    for (const p of list) {
      const key = p.name.toLowerCase();
      if (names.has(key)) continue;
      // keep some variety: at most two of the same kind of food
      const n = perKind.get(p.kind) || 0;
      if (c.id === 'eat' && n >= 2) continue;
      names.add(key);
      perKind.set(p.kind, n + 1);
      out.push(p);
      if (out.length >= limit) break;
    }
    // chosen by score, listed by how far they are to walk
    groups[c.id] = out.sort((a, b) => a.metres - b.metres);
  }
  return groups;
}
