// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server, errors } = await startApp();
await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
const head = () => page.evaluate(() => { const h = document.querySelector('#w-head').getBoundingClientRect(); const e = document.querySelector('#w-lb').getBoundingClientRect(); const s = getComputedStyle(document.querySelector('#w-head'), '::after'); return { dotAboveEnds: h.bottom <= e.top + 1, stem: s.content !== 'none' && s.height !== 'auto', visible: getComputedStyle(document.querySelector('#w-head')).opacity !== '0' }; });
const tucked = async () => JSON.stringify(await head());
const geo = () => page.evaluate(() => {
  const h = document.querySelector('#w-head').getBoundingClientRect();
  const a = document.querySelector('#w-la').getBoundingClientRect(), b = document.querySelector('#w-lb').getBoundingClientRect();
  const track = document.querySelector('#w-track').getBoundingClientRect();
  const stemX = h.left + h.width / 2;
  return { stemFromStartEnd: Math.round((stemX - a.right) * 10) / 10, stemFromEndEnd: Math.round((b.left - stemX) * 10) / 10,
    stemMeetsTrack: Math.abs(h.bottom - track.top) <= 1.5, headOnTop: +getComputedStyle(document.querySelector('#w-head')).zIndex > +getComputedStyle(document.querySelector('#w-la')).zIndex };
});
await page.evaluate(() => { document.querySelector('#video').currentTime = 4; }); await page.waitForTimeout(250);
await page.mouse.move(600, 300); await page.click('#w-loop-btn'); await page.waitForTimeout(150);
console.log('loop starts at the playhead (4s):', JSON.stringify(await geo()));
const sb = await page.locator('#w-scrub').boundingBox(); const lb = await page.locator('#w-lb').boundingBox();
const dur = await page.evaluate(() => document.querySelector('#video').duration);
await page.mouse.move(lb.x + 10 /* the end anchor body: its time */, lb.y + lb.height / 2); await page.mouse.down();
await page.mouse.move(sb.x + (6 / dur) * sb.width, lb.y + lb.height / 2, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
console.log('end dragged to', (await page.evaluate(() => document.querySelector('#video').currentTime)).toFixed(3) + 's (playhead there):', JSON.stringify(await geo()));
await page.mouse.move(600, 300);
await page.screenshot({ path: '/tmp/hi/tuck.png', clip: { x: sb.x - 40, y: sb.y - 30, width: 360, height: 80 } });
await page.evaluate(() => { document.querySelector('#video').currentTime = 5; }); await page.waitForTimeout(250);
console.log('playhead in the middle (5s):', JSON.stringify(await geo()));
await page.screenshot({ path: '/tmp/hi/tuck2.png', clip: { x: sb.x - 40, y: sb.y - 30, width: 360, height: 80 } });
await page.click('#w-loop-btn'); await page.waitForTimeout(150); await page.mouse.move(600, 300);
console.log('loop off: plain knob again:', await page.evaluate(() => getComputedStyle(document.querySelector('#w-head'), '::after').content === 'none'));
await page.screenshot({ path: '/tmp/hi/tuck3.png', clip: { x: sb.x - 40, y: sb.y - 30, width: 360, height: 80 } });
console.log('errors:', JSON.stringify(errors)); await browser.close(); server.close();
