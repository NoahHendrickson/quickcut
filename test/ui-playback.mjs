// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server, errors, SHOTS } = await startApp({ dpr: Number(process.env.DPR || 1) });
const open = async (p) => {
  await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
  await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), p);
};
const frameInfo = () => page.evaluate(() => {
  const r = document.querySelector('#vframe').getBoundingClientRect();
  const d = window.devicePixelRatio;
  const whole = (v) => Math.abs(v * d - Math.round(v * d)) < 0.01;
  return { dpr: d, rect: [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 1000) / 1000), onWholeDevicePixels: [r.left, r.top, r.width, r.height].every(whole),
    proxyLabel: !document.querySelector('#w-proxy').hidden, src: document.querySelector('#video').currentSrc.split('/').pop() };
});
await open('/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
await page.waitForTimeout(300);
console.log('h264 file   ', JSON.stringify(await frameInfo()));
for (const [w, h] of [[1111, 777], [1287, 803], [999, 600]]) {
  await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(250);
  console.log(`resized ${w}x${h}`.padEnd(12), JSON.stringify(await frameInfo()));
}
if (!process.env.DPR || process.env.DPR === '1') {
  await page.setViewportSize({ width: 1320, height: 840 });
  await open('/tmp/qc-test/prores.mov');
  await page.waitForFunction(() => !document.querySelector('#w-proxy').hidden, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  console.log('prores file ', JSON.stringify(await frameInfo()));
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${SHOTS}/73-preview-copy.png` });
  await open('/tmp/qc-test/src.mp4');
  await page.waitForFunction(() => document.querySelector('#video').readyState >= 2 && document.querySelector('#video').currentSrc.includes('/media/'), null, { timeout: 30000 });
  await page.waitForTimeout(300);
  console.log('back to h264', JSON.stringify(await frameInfo()));
}
console.log('errors:', JSON.stringify(errors));
await browser.close(); server.close();
