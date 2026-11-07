// Where the bundled data files live and how to read them.
//
// The claude.ai artifact host serves only standard web file types, so the
// published build carries the binary files as base64 text (name.b64.txt).

const EMBED = typeof window !== 'undefined' && !!window.TEMPO_EMBED;

/** Path of a bundled data file, for this build. */
export function dataPath(name) {
  return EMBED && !name.endsWith('.json') ? `data/${name}.b64.txt` : `data/${name}`;
}

/** The raw bytes of a data file, decoding base64 text when needed. */
export async function fetchBytes(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  if (!path.endsWith('.b64.txt')) return new Uint8Array(await res.arrayBuffer());
  const bin = atob((await res.text()).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
