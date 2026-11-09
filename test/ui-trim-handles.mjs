// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server, errors } = await startApp();
await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
await page.waitForTimeout(400);
// Watch the handle after letting go: does anything move it?
const watchAfter = async (sel, label) => {
  const xs = [];
  for (let i = 0; i < 24; i++) {
    xs.push(await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.left * 10) / 10; }, sel));
    await page.waitForTimeout(50);
  }
  const moved = xs.some((x) => Math.abs(x - xs[0]) > 0.5);
  console.log(label.padEnd(22), 'moved after release:', moved, moved ? JSON.stringify([...new Set(xs)]) : xs[0]);
};
const drag = async (sel, toX, steps = 10) => {
  const h = await page.locator(sel).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
  await page.mouse.move(toX, h.y + h.height / 2, { steps });
  await page.mouse.up();
};
// Quick trim (Watch)
await page.click('#w-trim'); await page.waitForTimeout(300);
let sb = await page.locator('#w-scrub').boundingBox();
for (const frac of [0.27, 0.41, 0.13]) {
  await drag('#w-h-in', sb.x + sb.width * frac);
  await watchAfter('#w-h-in', `quick trim -> ${frac}`);
}
await page.click('#w-trim-cancel'); await page.waitForTimeout(200);
// Edit timeline
await page.keyboard.press('e'); await page.waitForTimeout(500);
sb = await page.locator('#tl-strip').boundingBox();
for (const frac of [0.27, 0.41, 0.13]) {
  await drag('#tl-handle-in', sb.x + sb.width * frac);
  await watchAfter('#tl-handle-in', `edit -> ${frac}`);
}
console.log('errors:', JSON.stringify(errors));
await browser.close(); server.close();
