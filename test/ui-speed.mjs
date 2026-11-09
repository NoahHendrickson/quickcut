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
await page.click('.tl-row[data-row="slow"] .tl-label');
await page.click('#slow-add');
await page.waitForTimeout(200);
console.log('added       ', JSON.stringify(await st()));
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/52-rows.png` });
const typeSpeed = async (v) => {
  if (!(await page.$('.menu.pop'))) await page.click('#speed-pick');
  await page.waitForTimeout(100);
  await page.fill('.menu.pop input', v); await page.press('.menu.pop input', 'Enter');
  await page.waitForTimeout(150);
};
for (const v of ['3', '1/4', '2.5x', 'abc', '40']) {
  await typeSpeed(v);
  console.log(`typed ${v.padEnd(5)} menu-open=${!!(await page.$('.menu.pop'))}`, JSON.stringify(await st()));
}
await page.keyboard.press('Escape');
console.log('esc closes menu:', !(await page.$('.menu.pop')));
// Pick from the list, mute its sound, then type exact start / stop times
await page.click('#speed-pick'); await page.waitForTimeout(100);
await page.screenshot({ path: `${SHOTS}/53-speed-menu.png` });
await page.evaluate(() => [...document.querySelectorAll('.menu.pop button')].find((b) => b.firstElementChild?.textContent === '4×').click());
await page.click('#speed-pick'); await page.waitForTimeout(100);
await page.evaluate(() => [...document.querySelectorAll('.menu.pop button')].find((b) => b.firstElementChild?.textContent === 'Mute').click());
await page.fill('#slow-start', '0:07.50'); await page.press('#slow-start', 'Enter');
await page.fill('#slow-end', '0:09.00'); await page.press('#slow-end', 'Enter');
await page.waitForTimeout(150);
console.log('4x muted 7.5-9', JSON.stringify(await st()));
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/54-speed-muted.png` });
console.log('rows overflowing:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.tl-head')].filter((h) => [...h.querySelectorAll('*')].some((c) => c.offsetParent && c.getBoundingClientRect().right > h.getBoundingClientRect().right + 0.5)).map((h) => h.closest('.tl-row').dataset.row || 'ruler'))));
// Preview speed while playing inside the band
const band = await page.evaluate(() => { const b = document.querySelector('#tl-slow'); return b.title; });
await page.evaluate(() => { const v = document.querySelector('#video'); v.currentTime = 7.6; v.play(); });
await page.waitForTimeout(400);
console.log('playing in band, playbackRate =', (await st()).rate);
await page.evaluate(() => document.querySelector('#video').pause());
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/50-speed-up.png` });
await typeSpeed('0.3');
await page.waitForTimeout(150);
await page.screenshot({ path: `${SHOTS}/51-slow.png` });
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close();
