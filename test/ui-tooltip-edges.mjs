// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server, errors } = await startApp();
await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
const sb = await page.locator('#w-scrub').boundingBox();
const info = () => page.evaluate(() => {
  const t = document.querySelector('#w-hover'); const r = t.getBoundingClientRect();
  const tail = parseFloat(getComputedStyle(t).getPropertyValue('--tail')) || 0;
  return { text: t.textContent, pillLeft: Math.round(r.left), pillRight: Math.round(r.right), tailShift: tail, tailTipX: Math.round(r.left + r.width / 2 + tail) };
});
for (const [name, x] of [['far left', sb.x + 1], ['far right', sb.x + sb.width - 1]]) {
  await page.mouse.move(x, sb.y + sb.height / 2); await page.waitForTimeout(150);
  console.log(name.padEnd(10), 'cursor x', Math.round(x), JSON.stringify(await info()));
  await page.screenshot({ path: `/tmp/hi/edge-${name.replace(' ', '')}.png`, clip: { x: Math.max(0, x - 90), y: sb.y - 50, width: 180, height: 80 } });
}
console.log('native title on the bar:', await page.evaluate(() => document.querySelector('#w-scrub').getAttribute('title')));
console.log('errors:', JSON.stringify(errors)); await browser.close(); server.close();
