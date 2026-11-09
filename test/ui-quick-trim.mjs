// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { startApp } from './harness.mjs';

const { page, browser, server, errors, SHOTS } = await startApp();
const st = () => page.evaluate(() => {
  const v = document.querySelector('#video');
  return {
    quick: document.body.classList.contains('quicktrim'),
    info: `${document.querySelector('#w-time').textContent} → ${document.querySelector('#w-total').textContent}`,
    knobGap: (() => { const k = document.querySelector('#w-h-in').getBoundingClientRect(); const h = document.querySelector('#w-head').getBoundingClientRect(); return Math.round((h.left + h.width / 2) - k.right); })(),
    // Vertical centres (px): the line, the knobs and both time labels should agree
    centres: ['#w-track', '#w-h-in', '#w-time', '#w-total'].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return Math.round((r.top + r.height / 2) * 10) / 10; }),
    barH: Math.round(document.querySelector('#watchbar').getBoundingClientRect().height),
    oneLine: Math.abs(document.querySelector('#w-scrub').getBoundingClientRect().top - document.querySelector('#w-play').getBoundingClientRect().top) < 30,
    t: Number(v.currentTime.toFixed(3)), paused: v.paused,
    saved: document.querySelector('#w-quick-done').hidden ? null : document.querySelector('#w-saved-name').textContent,
    trimButton: document.querySelector('#w-trim').offsetParent !== null,
  };
});
const log = async (l) => console.log(l.padEnd(20), JSON.stringify(await st()));
const scrubBox = async () => page.locator('#w-scrub').boundingBox();
const dragTo = async (sel, frac, shot) => {
  const h = await page.locator(sel).boundingBox();
  const sb = await scrubBox();
  const body = h.x + (sel === '#w-h-in' ? 7 : 10); // the anchor body's centre = its time (the neck adds 3px inside)
  await page.mouse.move(body, h.y + h.height / 2);
  await page.mouse.down();
  // The knob's time is its inner edge (knobs sit outside the kept part): aim that edge at frac.
  await page.mouse.move(sb.x + sb.width * frac, h.y + h.height / 2, { steps: 8 });
  await page.waitForTimeout(250);
  if (shot) await page.screenshot({ path: `${SHOTS}/${shot}.png` });
  await page.mouse.up();
  await page.waitForTimeout(250);
};
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
await page.waitForTimeout(300);
await log('watch');
await page.click('#w-trim');
await page.waitForTimeout(200);
await log('quick trim open');
await dragTo('#w-h-in', 0.27, '63-quick-trim-drag');
await log('dragged start');
const startT = await page.evaluate(() => document.querySelector('#video').currentTime); // the knob's exact (frame) time
// Hover the start handle: tooltip with its time (and where the lossless cut starts)
{
  const h = await page.locator('#w-h-in').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.waitForTimeout(200);
  console.log('hover start handle  ', JSON.stringify(await page.evaluate(() => ({ shown: !document.querySelector('#w-bubble').hidden, text: document.querySelector('#w-bubble').innerText.replace(/\n/g, ' | ') }))));
  await page.screenshot({ path: `${SHOTS}/66-trim-tooltip.png` });
}
await dragTo('#w-h-out', 0.35);
await log('dragged end');
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/64-quick-trim.png` });
await page.keyboard.press('Space');
await page.waitForTimeout(400);
await log('playing selection');
await page.waitForTimeout(2200);
await log('after review');
console.log('Save ▾ shown for an MP4:', await page.isVisible('#w-save-opts'), '(MP4 trims are exact and lossless, nothing to choose)');
await page.waitForTimeout(150);
await log('made exact');
await page.keyboard.press('Enter');
await page.waitForFunction(() => !document.querySelector('#w-quick-done').hidden, null, { timeout: 30000 });
await log('saved');
await page.screenshot({ path: `${SHOTS}/65-quick-trim-saved.png` });
const out = '/tmp/qc-test/' + (await page.textContent('#w-saved-name')).replace(/^Saved /, '');
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
const codec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out]).toString().trim();
const copied = fs.readFileSync('/tmp/qc-shots/last-args.txt', 'utf8').includes('-c:v\ncopy');
const grab = (f, at, p) => { execFileSync('ffmpeg', ['-v', 'error', '-y', ...(at == null ? [] : ['-ss', String(at)]), '-i', f, '-frames:v', '1', p]); return p; };
const psnr = (a, b) => { const m = /average:([\d.inf]+)/.exec(spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || ''); return m ? (m[1] === 'inf' ? 99 : Number(m[1])) : 0; };
const first = grab(out, null, '/tmp/qc-test/out/qt-first.png');
const want = grab('/tmp/qc-test/src.mp4', startT - 0.0005, '/tmp/qc-test/out/qt-want.png'); // first frame at/after the start
console.log('  file:', out.split('/').pop(), 'duration', dur.toFixed(3), codec, '| lossless copy:', copied, '| first frame = the', startT.toFixed(5) + 's frame:', psnr(first, want) > 40, `(${psnr(first, want).toFixed(1)} dB)`);
await page.click('#w-trim-done');
await page.waitForTimeout(200);
await log('done');
// Cancel restores the previous trim
await page.keyboard.press('t');
await dragTo('#w-h-in', 0.6);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.keyboard.press('t');
await log('cancelled -> reopen');
await page.keyboard.press('Escape');
// Loop-first: A-B becomes the selection
await page.evaluate(() => { document.querySelector('#video').currentTime = 12; }); await page.waitForTimeout(250);
await page.keyboard.press('i');
await page.evaluate(() => { document.querySelector('#video').currentTime = 15; }); await page.waitForTimeout(250);
await page.keyboard.press('o');
await page.keyboard.press('t');
await page.waitForTimeout(200);
await log('from A-B loop');
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close();
