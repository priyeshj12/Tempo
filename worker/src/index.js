// Tempo places proxy, a Cloudflare Worker.
//
// The page asks one question: what is worth doing around this point? The
// worker answers it from Google Places (eat, chill) and Tripadvisor
// (activities, sightseeing), so the two API keys stay on the server.
// Nothing is cached: Tripadvisor's terms allow caching only location IDs.
//
//   GET /places?lat=52.37&lon=4.89&radius=4000&lang=en
//   -> { places: [{ id, group, name, kind, lat, lon, rating, reviews, price,
//                   url, source }], sources: { eat, chill, activity, sightseeing } }
//
// Environment:
//   GOOGLE_PLACES_KEY   secret, Places API (New) key
//   TRIPADVISOR_KEY     secret, Tripadvisor Terra key (optional)
//   ALLOWED_ORIGINS     comma-separated origins allowed to call the worker

const GOOGLE = 'https://places.googleapis.com/v1/places:searchNearby';
const TERRA = 'https://terra.tripadvisor.com/api/locations/nearby';

// What each group means, in Google place types (Table A).
export const GOOGLE_TYPES = {
  eat: ['restaurant', 'cafe', 'coffee_shop', 'bakery', 'ice_cream_shop', 'dessert_shop'],
  // Chill: somewhere to spend an hour together with nothing to plan. Green
  // and waterside places to sit, views, bathhouses and spas, and easy-going
  // places for a drink.
  chill: [
    'park', 'botanical_garden', 'garden', 'beach', 'marina', 'picnic_ground', 'observation_deck',
    'spa', 'sauna', 'public_bath', 'wellness_center', 'tea_house', 'wine_bar', 'pub',
  ],
  // used for these two only when Tripadvisor is not configured
  activity: [
    'amusement_park', 'amusement_center', 'bowling_alley', 'movie_theater', 'performing_arts_theater',
    'zoo', 'aquarium', 'karaoke', 'water_park', 'night_club',
  ],
  sightseeing: ['tourist_attraction', 'museum', 'art_gallery', 'historical_landmark', 'cultural_landmark', 'monument'],
};

const FIELDS = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.primaryTypeDisplayName',
  'places.googleMapsUri',
  'places.priceLevel',
  'places.businessStatus',
].join(',');

const PRICE = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (!cors['Access-Control-Allow-Origin']) return reply({ error: 'This origin may not use the places proxy' }, 403);
    if (url.pathname !== '/places' || request.method !== 'GET') return reply({ error: 'Not found' }, 404);

    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return reply({ error: 'lat and lon are required' }, 400);
    const radius = Math.min(8000, Math.max(300, Number(url.searchParams.get('radius')) || 3000));
    const lang = (url.searchParams.get('lang') || 'en').slice(0, 5).replace(/[^a-zA-Z-]/g, '') || 'en';

    try {
      return reply(await findPlaces(env, { lat, lon, radius, lang }));
    } catch (err) {
      return reply({ error: err.message || 'Upstream error' }, 502);
    }
  },
};

/** All four groups, from whichever sources are configured. */
export async function findPlaces(env, q) {
  const jobs = {};
  const sources = {};
  if (env.GOOGLE_PLACES_KEY) {
    jobs.eat = google(env, q, 'eat');
    jobs.chill = google(env, q, 'chill');
    sources.eat = sources.chill = 'Google';
  }
  if (env.TRIPADVISOR_KEY) {
    jobs.attractions = tripadvisor(env, q);
    sources.activity = sources.sightseeing = 'Tripadvisor';
  } else if (env.GOOGLE_PLACES_KEY) {
    jobs.activity = google(env, q, 'activity');
    jobs.sightseeing = google(env, q, 'sightseeing');
    sources.activity = sources.sightseeing = 'Google';
  }
  if (!Object.keys(jobs).length) throw new Error('No place sources are configured');

  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(Object.values(jobs));
  const places = [];
  const failed = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') places.push(...s.value);
    else failed.push(`${names[i]}: ${s.reason?.message || s.reason}`);
  });
  if (!places.length && failed.length) throw new Error(failed.join('; '));
  return { places, sources, failed };
}

async function google(env, { lat, lon, radius, lang }, group) {
  const res = await fetch(GOOGLE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({
      includedTypes: GOOGLE_TYPES[group],
      maxResultCount: 20,
      rankPreference: 'POPULARITY',
      languageCode: lang,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } },
    }),
  });
  if (!res.ok) throw new Error(`Google answered ${res.status}`);
  return fromGoogle(await res.json(), group);
}

export function fromGoogle(data, group) {
  return (data.places || [])
    .filter((p) => p.location && p.displayName && p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((p) => ({
      id: `g:${p.id}`,
      group,
      name: p.displayName.text,
      kind: p.primaryTypeDisplayName?.text || '',
      lat: p.location.latitude,
      lon: p.location.longitude,
      rating: p.rating ?? null,
      reviews: p.userRatingCount ?? 0,
      price: p.priceLevel in PRICE ? PRICE[p.priceLevel] : null,
      url: p.googleMapsUri || `https://www.google.com/maps/search/?api=1&query=${p.location.latitude},${p.location.longitude}`,
      source: 'Google',
    }));
}

async function tripadvisor(env, { lat, lon, radius }) {
  const pages = await Promise.all(
    [1, 2].map(async (page) => {
      const params = new URLSearchParams({
        lat: lat.toFixed(5),
        lon: lon.toFixed(5),
        radius: (radius / 1000).toFixed(2),
        unit: 'KM',
        category: 'ATTRACTION',
        size: '20',
        page: String(page),
      });
      const res = await fetch(`${TERRA}?${params}`, { headers: { 'X-API-Key': env.TRIPADVISOR_KEY, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Tripadvisor answered ${res.status}`);
      return res.json();
    }),
  );
  return fromTripadvisor(pages.flatMap((p) => p.data || []));
}

/** Which of our groups a Tripadvisor attraction belongs to, from its categories. */
export function tripadvisorGroup(location) {
  const names = (location.categories || []).map((c) => `${c.display_name || ''} ${c.parent_category?.display_name || ''}`).join(' ');
  if (/spa|wellness|bath|onsen|sauna|beach|garden|nature|park(?!ing)|bar|pub|nightlife|lounge/i.test(names)) return 'chill';
  if (/museum|landmark|sight|histor|monument|statue|church|cathedral|temple|shrine|architect|galler|observation|tower|castle|palace|memorial|bridge|point of interest|neighbo/i.test(names)) return 'sightseeing';
  if (/fun|game|escape|bowling|amusement|water park|theme|zoo|aquarium|theat|show|concert|class|workshop|tour|sport|outdoor|adventure|climb|kart|arcade|cinema|movie|entertain|casino|lesson/i.test(names)) return 'activity';
  const top = (location.categories || []).map((c) => c.top_level_category).join(' ');
  return /Experience/.test(top) ? 'activity' : 'sightseeing';
}

export function fromTripadvisor(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const l = row.location;
    if (!l || !l.coordinates || seen.has(l.id)) continue;
    if (l.status?.value === 'CLOSED') continue;
    seen.add(l.id);
    const name = (l.names || []).find((n) => n.primary)?.value || l.names?.[0]?.value;
    if (!name) continue;
    out.push({
      id: `t:${l.id}`,
      group: tripadvisorGroup(l),
      name,
      kind: l.categories?.[0]?.display_name || '',
      lat: l.coordinates.latitude,
      lon: l.coordinates.longitude,
      rating: l.traveler_ratings?.overall?.rating ?? null,
      reviews: l.traveler_ratings?.overall?.count ?? 0,
      price: null,
      url: l.urls?.tripadvisor?.main || '',
      source: 'Tripadvisor',
    });
  }
  return out;
}
