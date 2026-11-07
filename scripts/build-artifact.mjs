#!/usr/bin/env node
// Builds the page published as a claude.ai artifact: build/artifact/index.html.
// The artifact host wraps the page in its own document, so this writes the
// title, styles and body content only, and turns on embed mode (bundled data,
// saving through the viewer). Scripts and data are published beside it.
//
// Usage: node scripts/build-artifact.mjs

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');

const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  .replace(/\s*<script src="config\.js"><\/script>\s*/, '\n')
  .replace(/\s*<script type="module" src="src\/main\.js"><\/script>\s*/, '\n')
  .trim();
const fonts = html.match(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com[^"]+)">/)[1];

// The full version on GitHub Pages, linked from the artifact for other cities.
// Override with TEMPO_WEB_URL=... when it is hosted elsewhere.
function pagesUrl() {
  if (process.env.TEMPO_WEB_URL) return process.env.TEMPO_WEB_URL;
  try {
    const remote = execSync('git remote get-url origin', { cwd: root, encoding: 'utf8' }).trim();
    const m = remote.match(/github\.com[/:]([^/]+)\/([^/.]+?)(\.git)?$/);
    if (m) return `https://${m[1].toLowerCase()}.github.io/${m[2]}/`;
  } catch {
    /* no git remote */
  }
  return '';
}
const webUrl = pagesUrl();

const page = `<title>Tempo Meetup Planner</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="${fonts.replace(/&/g, '&amp;')}">
<style>
${css.trim()}
</style>
<script>window.TEMPO_EMBED = true; window.TEMPO_WEB_URL = ${JSON.stringify(webUrl)};</script>
${body}
<script type="module" src="src/main.js"></script>
`;

const out = join(root, 'build/artifact');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), page);

// the files to publish beside the page; the host serves only web file types,
// so binary data goes as base64 text (see src/files.js)
const files = {};
for (const f of readdirSync(join(root, 'src'))) if (f.endsWith('.js')) files[`src/${f}`] = `src/${f}`;
mkdirSync(join(out, 'data'), { recursive: true });
for (const f of readdirSync(join(root, 'data'))) {
  if (f.endsWith('.json')) {
    files[`data/${f}`] = `data/${f}`;
  } else {
    writeFileSync(join(out, 'data', `${f}.b64.txt`), readFileSync(join(root, 'data', f)).toString('base64'));
    files[`data/${f}.b64.txt`] = `build/artifact/data/${f}.b64.txt`;
  }
}
writeFileSync(join(out, 'files.json'), JSON.stringify(files, null, 2));
console.log(`build/artifact/index.html (${(page.length / 1024).toFixed(1)} KB) and ${Object.keys(files).length} files to publish; web version: ${webUrl || 'none'}`);
