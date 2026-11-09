// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server } = await startApp({ dpr: Number(process.env.DPR || 2) });
await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
await page.evaluate(() => { document.querySelector('#video').currentTime = 0; });
await page.mouse.move(600, 200); await page.waitForTimeout(250);
// Render just the labels' ink and the track's ink on a flat background, then find their vertical centres.
const measure = async (label) => {
  // (A constructed stylesheet: the app's Content-Security-Policy turns an injected <style> away.)
  await page.evaluate((css) => { const s = new CSSStyleSheet(); s.replaceSync(css); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; }, '#watchbar{background:#fff!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important} #w-head,#w-progress,#w-buffer{visibility:hidden!important} #w-track{background:#000!important}');
  const r = await page.evaluate(() => {
    const t = document.querySelector('#w-time').getBoundingClientRect(), e = document.querySelector('#w-total').getBoundingClientRect(), k = document.querySelector('#w-track').getBoundingClientRect();
    return { t: [t.left, t.top, t.width, t.height], e: [e.left, e.top, e.width, e.height], k: [k.left, k.top, k.width, k.height] };
  });
  const top = Math.floor(Math.min(r.t[1], r.k[1]) - 6), bottom = Math.ceil(Math.max(r.t[1] + r.t[3], r.k[1] + r.k[3]) + 6);
  const ink = async (x, w) => {
    const buf = await page.screenshot({ clip: { x, y: top, width: w, height: bottom - top } });
    const { PNG } = await import('./png.mjs');
    const img = PNG(buf);
    const rows = [];
    for (let y = 0; y < img.h; y++) { let dark = 0; for (let xx = 0; xx < img.w; xx++) { const i = (y * img.w + xx) * 4; if (img.d[i] < 128) dark++; } if (dark) rows.push(y); }
    return (rows[0] + rows[rows.length - 1] + 1) / 2 / img.scale + top;
  };
  const time = await ink(r.t[0], r.t[2]), total = await ink(r.e[0], r.e[2]), track = await ink(r.k[0] + 20, 40);
  console.log(label.padEnd(8), 'digit centre vs track centre (px):', 'left label', (time - track).toFixed(2), '| right label', (total - track).toFixed(2));
};
await measure('now');
await browser.close(); server.close();
