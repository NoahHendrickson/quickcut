// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server, SHOTS } = await startApp();
await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
const rows = [];
for (const w of [960, 1100, 1200, 1320, 1440, 1600, 1920]) {
  await page.setViewportSize({ width: w, height: 840 }); await page.mouse.move(w / 2, 300); await page.waitForTimeout(150);
  rows.push(await page.evaluate((w) => {
    const bar = document.querySelector('#watchbar').getBoundingClientRect();
    const scrub = document.querySelector('#w-scrub').getBoundingClientRect();
    const overflow = [...document.querySelectorAll('#watchbar button')].some((b) => b.offsetParent && b.getBoundingClientRect().right > bar.right + 0.5);
    const shown = (sel) => !!document.querySelector(sel).offsetParent;
    return `${w}px window: seek bar ${Math.round(scrub.width)}px (${Math.round((scrub.width / bar.width) * 100)}% of bar)${overflow ? '  OVERFLOW' : ''} | ±10s ${shown('#w-back10') ? 'yes' : 'no'}, labels ${getComputedStyle(document.querySelector('#w-full-edit')).fontSize !== '0px' ? 'yes' : 'no'}, open ${shown('#btn-open') ? 'yes' : 'no'}, help ${shown('#btn-help') ? 'yes' : 'no'}`;
  }, w));
}
console.log(rows.join('\n'));
await page.setViewportSize({ width: 1320, height: 840 }); await page.mouse.move(600, 300); await page.waitForTimeout(150);
await page.screenshot({ path: `${SHOTS}/75-dock-shown.png` });
await browser.close(); server.close();
