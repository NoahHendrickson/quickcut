// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { execFileSync } from 'node:child_process';
import { startApp } from './harness.mjs';

const { page, browser, server, errors, SHOTS } = await startApp({ edit: true });
const st = () => page.evaluate(() => ({
  rowOn: document.querySelector('.tl-row[data-row="freeze"]').classList.contains('is-on'),
  focus: document.querySelector('.tl-row.focus')?.dataset.row,
  hold: document.querySelector('#freeze-label').textContent,
  at: document.querySelector('#freeze-at').value,
  markers: [...document.querySelectorAll('.freeze-clip')].map((m) => m.textContent),
  t: Number(document.querySelector('#video').currentTime.toFixed(3)),
  paused: document.querySelector('#video').paused,
  icon: document.querySelector('#btn-play use').getAttribute('href'),
  mode: document.querySelector('#export-mode').textContent,
}));
const log = async (l) => console.log(l.padEnd(18), JSON.stringify(await st()));
await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelectorAll('#tl-thumbs > div').length > 0, null, { timeout: 30000 });
await page.evaluate(() => { document.querySelector('#video').currentTime = 5.3; });
await page.waitForTimeout(300);
await log('before');
await page.keyboard.press('h'); await page.waitForTimeout(200);
await log('H at 5.3');
await page.click('#freeze-pick'); await page.waitForTimeout(120);
await page.screenshot({ path: `${SHOTS}/91-freeze-menu.png` });
await page.evaluate(() => [...document.querySelectorAll('.menu.pop button')].find((b) => b.firstElementChild?.textContent === '3s').click());
await page.waitForTimeout(100);
await log('hold 3s');
await page.fill('#freeze-at', '0:06.00'); await page.press('#freeze-at', 'Enter'); await page.waitForTimeout(200);
await log('typed 0:06');
// Drag the marker to about 8s
const strip = await page.locator('#tl-strip').boundingBox();
const mk = await page.locator('.freeze-clip').boundingBox();
await page.mouse.move(mk.x + 3, mk.y + mk.height / 2); await page.mouse.down();
await page.mouse.move(strip.x + (8 / 20) * strip.width + 3, mk.y + mk.height / 2, { steps: 8 });
await page.mouse.up(); await page.waitForTimeout(250);
const s = await st();
const frameExact = Math.abs(Math.round(parseFloat(s.at.split(':')[1]) * 60) - parseFloat(s.at.split(':')[1]) * 60) < 0.7;
console.log('dragged'.padEnd(18), JSON.stringify(s), '| on a frame:', frameExact);
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/90-freeze-row.png` });
// Preview: play from 7.4, the picture should stop on the freeze for 3s, then carry on
const atSec = await page.evaluate(() => { const v = document.querySelector('#freeze-at').value.split(':'); return Number(v[0]) * 60 + Number(v[1]); });
await page.evaluate(() => { document.querySelector('#video').currentTime = 7.4; }); await page.waitForTimeout(300);
await page.click('#btn-play');
await page.waitForTimeout(1500);
const h1 = await st();
console.log('holding?'.padEnd(18), JSON.stringify({ t: h1.t, paused: h1.paused, icon: h1.icon }), '| held on the frame:', h1.paused && Math.abs(h1.t - atSec) < 0.02 && h1.icon === '#i-pause');
await page.waitForTimeout(2600);
const h2 = await st();
console.log('after hold'.padEnd(18), JSON.stringify({ t: h2.t, paused: h2.paused }), '| carried on:', !h2.paused && h2.t > atSec + 0.1);
await page.click('#btn-play'); await page.waitForTimeout(150);
// Export: the file is the trim + the hold
await page.click('#btn-export'); await page.waitForTimeout(200);
await page.click('#btn-export');
await page.waitForFunction(() => !document.querySelector('#export-result').hidden, null, { timeout: 120000 });
const name = (await page.textContent('#export-result .dim')).trim();
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `/tmp/qc-test/${name}`]).toString());
console.log('exported'.padEnd(18), name, dur.toFixed(2) + 's', '| 20s + 3s hold:', Math.abs(dur - 23) < 0.1, '|', (await st()).mode);
// Delete removes it
await page.click('.freeze-clip'); await page.keyboard.press('Delete'); await page.waitForTimeout(150);
await log('deleted');
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close();
