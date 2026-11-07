import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { fromGoogle, fromTripadvisor, tripadvisorGroup, GOOGLE_TYPES } from '../worker/src/index.js';

// Responses shaped like the Places API (New) and Tripadvisor Terra docs.
const googleReply = (group) => ({
  places: [
    {
      id: `${group}-1`,
      displayName: { text: group === 'eat' ? 'De Kas' : 'Vondelpark', languageCode: 'en' },
      location: { latitude: 52.355, longitude: 4.92 },
      rating: 4.6,
      userRatingCount: 2310,
      primaryTypeDisplayName: { text: group === 'eat' ? 'Restaurant' : 'Park' },
      googleMapsUri: 'https://maps.google.com/?cid=1',
      priceLevel: 'PRICE_LEVEL_EXPENSIVE',
      businessStatus: 'OPERATIONAL',
    },
    { id: 'gone', displayName: { text: 'Closed place' }, location: { latitude: 52, longitude: 4 }, businessStatus: 'CLOSED_PERMANENTLY' },
  ],
});

const taLocation = (id, name, category, top = 'Attraction', rating = 4.5, count = 900) => ({
  location: {
    id,
    names: [{ language: 'en', value: name, primary: true }],
    coordinates: { latitude: 52.36, longitude: 4.885 },
    categories: [{ id: 1, display_name: category, top_level_category: top }],
    traveler_ratings: { overall: { rating, count } },
    urls: { tripadvisor: { main: `https://www.tripadvisor.com/Attraction_Review-${id}` } },
    status: { value: 'OPEN' },
  },
  distance_kilometers: 1.2,
});

function mockFetch(log) {
  return async (url, init = {}) => {
    log.push({ url: String(url), init });
    if (String(url).startsWith('https://places.googleapis.com')) {
      const body = JSON.parse(init.body);
      const group = Object.keys(GOOGLE_TYPES).find((g) => GOOGLE_TYPES[g][0] === body.includedTypes[0]);
      return new Response(JSON.stringify(googleReply(group)), { status: 200 });
    }
    if (String(url).startsWith('https://terra.tripadvisor.com')) {
      const page = new URL(url).searchParams.get('page');
      const data = page === '1'
        ? [taLocation(1, 'Rijksmuseum', 'Art Museums'), taLocation(2, 'Escape Room X', 'Escape Games'), taLocation(3, 'Sauna Deco', 'Spas')]
        : [taLocation(4, 'Canal Cruise', 'Boat Tours', 'Experience'), taLocation(1, 'Rijksmuseum', 'Art Museums')];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
}

const env = { GOOGLE_PLACES_KEY: 'g-key', TRIPADVISOR_KEY: 't-key', ALLOWED_ORIGINS: 'https://friends.example' };
const ask = (path, origin = 'https://friends.example') =>
  worker.fetch(new Request(`https://proxy.example${path}`, { headers: { Origin: origin } }), env);

test('the proxy only answers allowed origins', async () => {
  const res = await ask('/places?lat=52.37&lon=4.89', 'https://elsewhere.example');
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('the proxy returns all four groups from Google and Tripadvisor', async () => {
  const log = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(log);
  try {
    const res = await ask('/places?lat=52.37&lon=4.89&radius=4000&lang=nl');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://friends.example');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body.sources, { eat: 'Google', chill: 'Google', activity: 'Tripadvisor', sightseeing: 'Tripadvisor' });
    const byGroup = (g) => body.places.filter((p) => p.group === g).map((p) => p.name);
    assert.deepEqual(byGroup('eat'), ['De Kas']);
    assert.deepEqual(byGroup('sightseeing'), ['Rijksmuseum']); // listed once across pages
    assert.deepEqual(byGroup('activity').sort(), ['Canal Cruise', 'Escape Room X']);
    assert.deepEqual(byGroup('chill').sort(), ['Sauna Deco', 'Vondelpark']);
    // keys go in headers, never in the page
    const g = log.find((l) => l.url.startsWith('https://places.googleapis.com'));
    assert.equal(g.init.headers['X-Goog-Api-Key'], 'g-key');
    assert.equal(JSON.parse(g.init.body).locationRestriction.circle.radius, 4000);
    const t = log.find((l) => l.url.startsWith('https://terra.tripadvisor.com'));
    assert.equal(t.init.headers['X-API-Key'], 't-key');
    assert.equal(new URL(t.url).searchParams.get('radius'), '4.00');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('without a Tripadvisor key, Google covers activities and sightseeing', async () => {
  const log = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(log);
  try {
    const res = await worker.fetch(
      new Request('https://proxy.example/places?lat=52.37&lon=4.89', { headers: { Origin: 'https://friends.example' } }),
      { ...env, TRIPADVISOR_KEY: '' },
    );
    const body = await res.json();
    assert.deepEqual(body.sources, { eat: 'Google', chill: 'Google', activity: 'Google', sightseeing: 'Google' });
    assert.equal(log.filter((l) => l.url.startsWith('https://places.googleapis.com')).length, 4);
    assert.equal(log.filter((l) => l.url.startsWith('https://terra')).length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('places are normalised into one shape', () => {
  const [g] = fromGoogle(googleReply('eat'), 'eat');
  assert.deepEqual(g, {
    id: 'g:eat-1', group: 'eat', name: 'De Kas', kind: 'Restaurant', lat: 52.355, lon: 4.92,
    rating: 4.6, reviews: 2310, price: 3, url: 'https://maps.google.com/?cid=1', source: 'Google',
  });
  const [t] = fromTripadvisor([taLocation(9, 'Anne Frank House', 'Historic Sites')]);
  assert.equal(t.group, 'sightseeing');
  assert.equal(t.rating, 4.5);
  assert.equal(t.reviews, 900);
  assert.equal(tripadvisorGroup({ categories: [{ display_name: 'Bowling Alleys' }] }), 'activity');
  assert.equal(tripadvisorGroup({ categories: [{ display_name: 'Parks' }] }), 'chill');
  assert.equal(tripadvisorGroup({ categories: [{ display_name: 'Parking Garages' }] }), 'sightseeing');
});
