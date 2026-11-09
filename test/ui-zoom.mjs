// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server, errors, SHOTS } = await startApp({ edit: true });
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
const drop = (p) => page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), p);
const vals = () => page.evaluate(() => ({
  in: document.querySelector('#in-time').value, out: document.querySelector('#out-time').value,
  slider: document.querySelector('#zoom-slider').value,
  fitDisabled: document.querySelector('#zoom-fit').disabled,
  ticks: [...document.querySelectorAll('#tl-ticks .tick')].slice(0, 4).map((t) => t.textContent),
  firstTileImage: document.querySelector('#tl-thumbs > div')?.style.backgroundImage.replace(/^url\("?|"?\)$/g, ''),
}));
const parse = (s) => { const [m, sec] = s.split(':'); return Number(m) * 60 + Number(sec); };
await drop('/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelectorAll('#tl-thumbs > div').length > 0, null, { timeout: 30000 });
await page.fill('#in-time', '0:07.00'); await page.press('#in-time', 'Enter');
await page.fill('#out-time', '0:08.50'); await page.press('#out-time', 'Enter');
await page.waitForTimeout(300);
const bv = await vals();
console.log('before zoom', JSON.stringify(bv));
await shot('20-short-selection');

await page.click('#zoom-sel');
await page.waitForTimeout(2000);
console.log('direct filmstrip call:', await page.evaluate(async () => {
  try { return await window.__TAURI__.core.invoke('filmstrip', { path: '/tmp/qc-test/src.mp4', start: 6.9, duration: 1.8, count: 20, height: 112 }); } catch (e) { return 'ERR ' + e; }
}));
const zv = await vals();
console.log('zoomed to selection', JSON.stringify(zv));
await shot('21-zoomed');
console.log('exact-frame strip loaded for zoomed view:', zv.firstTileImage !== bv.firstTileImage);

// Precision: at the whole-video zoom, drag 200px normally vs 200px with Shift held
await page.click('#zoom-fit');
await page.waitForTimeout(300);
const dragBy = async (sel, px, shift) => {
  const h = await page.locator(sel).boundingBox();
  const y = h.y + h.height / 2;
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(h.x + h.width / 2, y); await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + px, y, { steps: 10 });
  await page.waitForTimeout(100);
  if (shift) await shot('22-fine-drag');
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
};
const t0 = parse((await vals()).in);
await dragBy('#tl-handle-in', -200, false);
const t1 = parse((await vals()).in);
await dragBy('#tl-handle-in', 200, true);
const t2 = parse((await vals()).in);
console.log(`200px normal: ${(t1 - t0).toFixed(3)}s | 200px with Shift: ${(t2 - t1).toFixed(3)}s | ratio ${((t0 - t1) / (t2 - t1)).toFixed(1)}x`);
console.log('start on a frame boundary (60fps):', Math.abs(t2 * 60 - Math.round(t2 * 60)) < 1e-3, t2);
await page.click('#zoom-sel');
await page.waitForTimeout(300);
const y = (await page.locator('#tl-handle-in').boundingBox()).y + 20;

await page.locator('#zoom-slider').fill('1000');
await page.waitForTimeout(2000);
console.log('max zoom', JSON.stringify(await vals()));
await shot('23-max-zoom');

// Edge auto-scroll: hold the start handle against the left edge of a zoomed timeline
await page.click('#zoom-sel');
await page.waitForTimeout(400);
const before = await vals();
const hi = await page.locator('#tl-handle-in').boundingBox();
const sb = await page.locator('#tl-strip').boundingBox();
await page.mouse.move(hi.x + hi.width / 2, y); await page.mouse.down();
await page.mouse.move(sb.x + 4, y, { steps: 8 });
await page.waitForTimeout(1200);
await page.mouse.up();
const after = await vals();
console.log('edge scroll: ruler starts', before.ticks[0], '->', after.ticks[0], '| start', before.in, '->', after.in);

await page.click('#zoom-fit');
await page.waitForTimeout(300);
console.log('fit', JSON.stringify(await vals()));
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close();
