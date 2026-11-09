// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server } = await startApp();
await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
await page.mouse.move(600, 300); await page.waitForTimeout(150);
console.log(JSON.stringify(await page.evaluate(() => ['#w-play', '#w-prev-frame', '#w-back5', '#w-fwd5', '#w-next-frame', '#w-mute', '#w-fullscreen', '#btn-open'].map((sel) => {
  const b = document.querySelector(sel); if (!b || !b.offsetParent) return [sel, 'hidden'];
  const r = b.getBoundingClientRect(), s = b.querySelector('svg').getBoundingClientRect(), cs = getComputedStyle(b);
  return [sel, `button ${r.width}x${r.height}`, `icon ${s.width}x${s.height}`, `icon offset from centre: ${(s.left + s.width / 2 - (r.left + r.width / 2)).toFixed(1)}, ${(s.top + s.height / 2 - (r.top + r.height / 2)).toFixed(1)}`, `padding ${cs.padding}`];
})), null, 1));
const bb = await page.locator('#w-back5').boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(200);
await page.screenshot({ path: '/tmp/hi/hover.png', clip: { x: bb.x - 100, y: bb.y - 14, width: 330, height: 64 } });
await browser.close(); server.close();
