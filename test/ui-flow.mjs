// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { execFileSync } from 'node:child_process';
import { startApp, check } from './harness.mjs';

const { page, browser, server, errors, files, SHOTS } = await startApp({ edit: true });
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
const drop = (p) => page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), p);
const seekTo = async (t) => { await page.evaluate((t) => { document.querySelector('#video').currentTime = t; }, t); await page.waitForTimeout(450); };
const stripBox = async () => page.locator('#tl-strip').boundingBox();
const xAt = async (t, dur) => { const b = await stripBox(); return b.x + (t / dur) * b.width; };
const tool = (name) => page.click(`.tl-row[data-row="${name === 'split' ? 'trim' : name}"] .tl-label`);
// Row controls: pick a value from a row's menu, or type into its custom field.
const menuPick = async (anchor, label) => {
  await page.click(anchor); await page.waitForTimeout(120);
  await page.evaluate((label) => [...document.querySelectorAll('.menu.pop button')].find((b) => b.firstElementChild?.textContent === label).click(), label);
  await page.waitForTimeout(150);
};
const menuType = async (anchor, value) => {
  await page.click(anchor); await page.waitForTimeout(120);
  await page.fill('.menu.pop input', value); await page.press('.menu.pop input', 'Enter');
  await page.waitForTimeout(150);
};

const dragHandle = async (sel, toX, hold) => {
  const h = await page.locator(sel).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(toX, h.y + h.height / 2, { steps: 10 });
  if (hold) await hold();
  await page.mouse.up();
  await page.waitForTimeout(300);
};
const state = () => page.evaluate(() => ({
  tool: document.querySelector('.tl-row.focus')?.dataset.row,
  in: document.querySelector('#in-time').value, out: document.querySelector('#out-time').value,
  btn: document.querySelector('#btn-export-label').textContent,
  popups: document.querySelectorAll('.pop').length,
}));
const log = async (l) => console.log(l, JSON.stringify(await state()));
const md5 = (f) => execFileSync('md5', ['-q', f]).toString().trim();

await page.waitForTimeout(700);
await shot('00-empty');
await drop('/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2 && document.querySelectorAll('#tl-thumbs > div').length > 0, null, { timeout: 30000 });
await page.waitForTimeout(400);
await log('opened');

// Trim: drag handles, then type an exact end time in the Trim options
await dragHandle('#tl-handle-in', await xAt(4.5, 20));
await dragHandle('#tl-handle-out', await xAt(16, 20), async () => { await page.waitForTimeout(300); await shot('01-trim-drag'); });
await page.fill('#out-time', '0:16.00');
await page.press('#out-time', 'Enter');
await page.waitForTimeout(300);
await log('trimmed');
await shot('02-trim');

// Sound
await tool('sound');
await menuPick('#sfx-add', 'Choose sound files…');
await page.waitForTimeout(400);
await seekTo(8.6);
await page.click('#sfx-add'); await page.click('.menu.pop .item-row:nth-child(1) > button');
await seekTo(13);
await page.click('#sfx-add'); await page.click('.menu.pop .item-row:nth-child(2) > button');
await page.waitForTimeout(500);
await shot('03-sound');
await log('sound');

// Amplitude
await tool('amp');
await menuPick('#amp-pick', '150%');
await page.waitForTimeout(400);
await shot('04-amplitude');
await menuPick('#amp-pick', '100%');

// Slow-mo
await tool('slow');
await page.waitForTimeout(200);
await shot('05-slow-off');
await seekTo(9);
await page.click('#slow-add');
await menuType('#speed-pick', '0.25');
await page.waitForTimeout(300);
await shot('06-slow');
await log('slow');

// Export: first click shows options, second saves
await page.click('#btn-export');
await page.waitForTimeout(300);
await shot('07-export-options');
await log('export-open');
await page.click('#btn-export');
await page.waitForFunction(() => parseFloat(document.querySelector('#export-bar').style.width) > 25, null, { timeout: 60000 });
await shot('08-exporting');
await page.waitForFunction(() => !document.querySelector('#export-result').hidden, null, { timeout: 120000 });
await page.waitForTimeout(300);
await shot('09-exported');
console.log('result:', (await page.textContent('#export-result')).replace(/\s+/g, ' '));

// Split (on another clip)
await drop('/tmp/qc-test/work.mp4');
await page.waitForFunction(() => document.title.startsWith('work') && document.querySelectorAll('#tl-thumbs > div').length > 0, null, { timeout: 30000 });
await seekTo(6.5);
// Split now lives in a dialog (P works in Edit too)
await page.keyboard.press('p');
await page.waitForFunction(() => document.querySelector('#split').open && !/Finding/.test(document.querySelector('#split-note').textContent), null, { timeout: 20000 });
await shot('10-split');
console.log('split dialog parts:', await page.$$eval('#split-list li', (l) => l.length), await page.textContent('#split-go'));
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// Replace original with inline confirmation
const before = md5('/tmp/qc-test/work.mp4');
await tool('trim');
await page.fill('#out-time', '0:05.00');
await page.press('#out-time', 'Enter');
// An emptied time field is not "0:00": the trim stays as it was.
await page.fill('#out-time', '');
await page.press('#out-time', 'Enter');
await page.waitForTimeout(150);
const kept = await state();
check('emptying the End field leaves the trim alone', kept.in === '0:00.00' && kept.out === '0:05.00', `${kept.in} – ${kept.out}`);
await page.click('#btn-export');
await page.click('.seg [data-mode="replace"]');
await page.waitForTimeout(200);
await shot('11-replace');
await page.click('#btn-export');
await page.waitForTimeout(200);
await shot('12-replace-confirm');
check('replace: the first click only asks to confirm', md5('/tmp/qc-test/work.mp4') === before && (await state()).btn === 'Click to confirm', (await state()).btn);
await page.click('#btn-export');
await page.waitForFunction(() => document.querySelector('#export-result').innerText.includes('Replaced'), null, { timeout: 60000 });
await page.waitForTimeout(400);
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '/tmp/qc-test/work.mp4']).toString());
check('replace: the file is now the 5s trim, the old version is kept', Math.abs(dur - 5) < 0.1 && md5('/tmp/qc-test/trash/work.mp4') === before, `${dur.toFixed(2)}s`);
// The editor carries on with the replaced file, not the 20s one that is gone.
const after = await page.evaluate(() => ({
  title: document.title, total: document.querySelector('#time-total').textContent, out: document.querySelector('#out-time').value,
  toast: document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent,
}));
check('replace: reopens the replaced file', after.title.startsWith('work.mp4') && after.total.startsWith('0:05') && after.out.startsWith('0:05') && !/Wait for/.test(after.toast), JSON.stringify(after));
await shot('13-replaced');

await page.keyboard.press('?');
await page.waitForTimeout(250);
await shot('14-shortcuts');
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close();
