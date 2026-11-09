// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server, errors, SHOTS } = await startApp({ edit: true });
const st = () => page.evaluate(() => ({
  value: document.querySelector('#speed-label').textContent + (document.querySelector('#speed-pick .muted').hasAttribute('hidden') ? '' : ' muted'),
  desc: document.querySelector('#speed-pick').title.split('.')[0],
  invalid: !!document.querySelector('.menu.pop input.invalid'),
  bar: document.querySelector('#tl-slow span').textContent,
  fast: document.querySelector('#tl-slow').classList.contains('fast'),
  rate: document.querySelector('#video').playbackRate,
  row: document.querySelector('.tl-row.focus')?.dataset.row,
  fields: [document.querySelector('#slow-start').value, document.querySelector('#slow-end').value],
  mode: document.querySelector('#export-mode').textContent,
}));
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelectorAll('#tl-thumbs > div').length > 0, null, { timeout: 30000 });
await page.evaluate(() => { document.querySelector('#video').currentTime = 8; });
await page.waitForTimeout(300);
// Edit view layout: every row's controls fit its left column; rows are compact and even.
const W = Number(process.env.W || 1320);
await page.setViewportSize({ width: W, height: 840 });
await page.waitForTimeout(200);
await page.click('.tl-row[data-row="zoom"] .tl-label'); await page.click('#zoom-add'); await page.waitForTimeout(150);
await page.click('.tl-row[data-row="slow"] .tl-label'); await page.click('#slow-add'); await page.waitForTimeout(150);
await page.evaluate(() => { document.querySelector('#video').currentTime = 12; }); await page.waitForTimeout(200);
await page.click('.tl-row[data-row="freeze"] .tl-label'); await page.click('#freeze-add'); await page.waitForTimeout(150);
// (sound effects need a file dialog in this harness)
await page.keyboard.press('Escape');
const check = () => page.evaluate(() => {
  const out = [];
  for (const row of document.querySelectorAll('.tl-row')) {
    const head = row.querySelector('.tl-head'); const hr = head.getBoundingClientRect();
    let right = 0;
    for (const el of head.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width && el.offsetParent) right = Math.max(right, r.right); }
    out.push(`${(row.dataset.row || 'ruler').padEnd(6)} h=${Math.round(row.getBoundingClientRect().height)} spare=${Math.round(hr.right - 10 - right)}`);
  }
  return out.join(' | ');
});
for (const row of ['zoom', 'slow', 'freeze', 'sound', 'trim']) {
  await page.click(`.tl-row[data-row="${row}"] .tl-label`); await page.waitForTimeout(120);
  console.log(row.padEnd(7), await check());
}
await page.click('.tl-row[data-row="slow"] .tl-label'); await page.waitForTimeout(120);
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/92-edit-layout-${W}.png` });
// Empty state
await page.evaluate(() => { document.querySelector('#video').currentTime = 3; });
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close(); process.exit(0);
