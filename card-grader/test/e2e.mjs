// Browser smoke test: upload a synthetic photo, run the analysis in the real UI, screenshot the result.
// Usage: node test/e2e.mjs  (needs Playwright + Chromium; starts its own static server)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeCard, embedInScene, writePNG } from './synth.js';

const root = new URL('..', import.meta.url).pathname;
const outDir = path.join(root, 'test', 'out'); fs.mkdirSync(outDir, { recursive: true });
const card = makeCard({ seed: 21, borderL: 38, borderR: 26, defects: [
  { type: 'corner', corner: 'tr', radius: 20 }, { type: 'edge', edge: 'left', t0: 0.5, t1: 0.7, depth: 11 },
  { type: 'scratch', x0: 200, y0: 120, x1: 420, y1: 300, width: 2, amount: 0.9 }, { type: 'dent', x: 735, y: 400, radius: 16, strength: 35 }] });
const { scene } = embedInScene(card, { angle: 0.06, persp: 0.0001, W: 1500, H: 2000 });
const photo = path.join(outDir, 'photo.png'); writePNG(scene, photo);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (err, data) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); res.end(data); });
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(`http://localhost:${port}/index.html`);
await page.selectOption('#era', 'vintage'); await page.selectOption('#rarity', 'holo');
await page.fill('#cardName', 'Charizard 4/102');
await page.setInputFiles('#file-front', photo);
await page.waitForFunction(() => !document.querySelector('#analyze').disabled);
await page.screenshot({ path: path.join(outDir, '1-before.png') });
const t0 = Date.now();
await page.click('#analyze');
await page.waitForSelector('#results:not([hidden])', { timeout: 120000 });
const ms = Date.now() - t0;
await page.screenshot({ path: path.join(outDir, '2-result.png'), fullPage: true });
const summary = await page.evaluate(() => ({
  eu: document.querySelector('#eu-grade').textContent, psa: document.querySelector('#psa-grade').textContent, bgs: document.querySelector('#bgs-grade').textContent,
  defects: [...document.querySelectorAll('#defects li .title')].map(e => e.textContent), whatif: [...document.querySelectorAll('#whatif li')].map(e => e.textContent),
  rec: document.querySelector('#recommend .rec.primary b').textContent, conf: document.querySelector('#confidence-line').textContent }));
for (const f of ['centering', 'whitening', 'surface', 'emboss', 'relief', 'corners', 'defects']) {
  await page.evaluate((f) => { window.__cardGrader.state.filter = f; }, f);
  await page.click(`#filters button:nth-child(${['original', 'centering', 'whitening', 'surface', 'emboss', 'relief', 'corners', 'defects'].indexOf(f) + 1})`);
  await page.locator('#view').screenshot({ path: path.join(outDir, `filter-${f}.png`) });
}
await browser.close(); server.close();
console.log(JSON.stringify({ analysisMs: ms, ...summary, errors }, null, 2));
if (errors.length) process.exitCode = 1;
