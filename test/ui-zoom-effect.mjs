// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import fs from 'node:fs';
import { startApp } from './harness.mjs';

const { page, browser, server, errors, SHOTS } = await startApp({ edit: true });
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
const drop = (p) => page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), p);
const seekTo = async (t) => { await page.evaluate((t) => { document.querySelector('#video').currentTime = t; }, t); await page.waitForTimeout(400); };
const info = () => page.evaluate(() => ({
  clips: [...document.querySelectorAll('.zoom-clip')].map((c) => c.textContent.trim()),
  box: document.querySelector('#zoom-box').hidden ? null : (() => { const b = document.querySelector('#zoom-box'); return [b.style.left, b.style.top, b.style.width]; })(),
  videoTransform: document.querySelector('#video').style.transform,
  origin: document.querySelector('#video').style.transformOrigin,
  mode: document.querySelector('#export-mode').textContent,
}));
await drop('/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelectorAll('#tl-thumbs > div').length > 0, null, { timeout: 30000 });
await seekTo(5);
await page.click('.tl-row[data-row="zoom"] .tl-label');
await page.waitForTimeout(200);
await shot('30-zoom-tool');
await page.click('#zoom-add');
await page.waitForTimeout(300);
console.log('added', JSON.stringify(await info()));
await page.click('#zoom-pick'); await page.waitForTimeout(120);
await page.evaluate(() => [...document.querySelectorAll('.menu.pop button')].find((b) => b.firstElementChild?.textContent === '2×').click());
// Aim: drag the box toward the top-right of the video
const vf = await page.locator('#vframe').boundingBox();
const bx = await page.locator('#zoom-box').boundingBox();
await page.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2);
await page.mouse.down();
await page.mouse.move(vf.x + vf.width * 0.8, vf.y + vf.height * 0.25, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
console.log('aimed', JSON.stringify(await info()));
await shot('31-zoom-aim');
// Preview: switch to another tool -> preview shows the zoom applied at the playhead
await page.click('.tl-row[data-row="trim"] .tl-label');
await seekTo(6.5);
await page.waitForTimeout(300);
console.log('preview mid-zoom', JSON.stringify(await info()));
await shot('32-zoom-preview');
await seekTo(2);
console.log('preview before zoom', JSON.stringify(await info()));
// Resize the zoom clip by dragging its end
const clip = await page.locator('.zoom-clip').boundingBox();
await page.mouse.move(clip.x + clip.width - 3, clip.y + clip.height / 2);
await page.mouse.down();
await page.mouse.move(clip.x + clip.width + 120, clip.y + clip.height / 2, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
console.log('resized', JSON.stringify(await page.$eval('.zoom-clip', (c) => c.title)));
// Export
await page.click('#btn-export');
await page.click('#btn-export');
await page.waitForFunction(() => !document.querySelector('#export-result').hidden, null, { timeout: 120000 });
console.log('export:', (await page.textContent('#export-result')).replace(/\s+/g, ' '), '|', (await info()).mode);
console.log('args:', fs.readFileSync('/tmp/qc-shots/last-args.txt', 'utf8').includes('overlay=') ? 'zoom graph present' : 'NO ZOOM GRAPH');
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close();
