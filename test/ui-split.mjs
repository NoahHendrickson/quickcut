// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startApp, check } from './harness.mjs';

const { page, browser, server, errors, commands, SHOTS } = await startApp();
const st = () => page.evaluate(() => ({
  open: document.querySelector('#split').open,
  mode: document.querySelector('#split-mode [aria-checked="true"]')?.dataset.mode,
  parts: [...document.querySelectorAll('#split-list li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  note: document.querySelector('#split-note').textContent.slice(0, 100),
  go: document.querySelector('#split-go').textContent, goDisabled: document.querySelector('#split-go').disabled,
  lenInvalid: document.querySelector('#split-len').classList.contains('invalid'),
}));
const log = async (l) => console.log(l.padEnd(16), JSON.stringify(await st()));
const settle = () => page.waitForFunction(() => !document.querySelector('#split-list').classList.contains('pending') && !/Finding/.test(document.querySelector('#split-note').textContent), null, { timeout: 20000 });
await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-split/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/79-split-button.png` });
await page.click('#w-split');
await page.waitForTimeout(100); await settle();
await log('equal 4');
await page.screenshot({ path: `${SHOTS}/80-split-dialog.png` });
await page.click('#split-plus'); await page.waitForTimeout(400); await settle();
await log('equal 5');
await page.click('#split-mode [data-mode="length"]'); await page.waitForTimeout(100);
await page.fill('#split-len', '6s'); await page.waitForTimeout(400); await settle();
await log('every 6s');
await page.screenshot({ path: `${SHOTS}/81-split-length.png` });
await page.fill('#split-len', '1h'); await page.waitForTimeout(400); await settle();
await log('every 1h');
await page.fill('#split-len', 'abc'); await page.waitForTimeout(100);
await log('typed abc');
await page.fill('#split-len', '0:06'); await page.waitForTimeout(400); await settle();
await page.click('#split-go');
await page.waitForFunction(() => !document.querySelector('#split-done').hidden, null, { timeout: 120000 });
await log('done');
await page.screenshot({ path: `${SHOTS}/82-split-done.png` });
const outs = fs.readdirSync('/tmp/qc-split').filter((f) => f.includes('_part')).sort();
const durs = outs.map((f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `/tmp/qc-split/${f}`]).toString()));
console.log("files:", outs.join(' '), '| durations:', durs.map((d) => d.toFixed(2)).join(' '), '| total', durs.reduce((a, b) => a + b, 0).toFixed(2));
// Lossless: every part's video packets are the source's packets
const pk = (f, extra = []) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', ...extra, '-show_entries', 'packet=size', '-of', 'csv=p=0', f]).toString().trim().split('\n');
const src = pk('/tmp/qc-split/src.mp4');
const joined = outs.flatMap((f) => pk(`/tmp/qc-split/${f}`));
check('split: the parts hold exactly the source\'s video packets, in order', joined.length === src.length && joined.every((s, i) => s === src[i]), `source ${src.length}, parts ${joined.length}`);
await page.click('#split-close'); await page.waitForTimeout(150);

// While a split runs, the video it reads from stays open, and Stop stops it even in the
// moment between two parts, when no ffmpeg is running. Hold the split there to try both.
const toastText = () => page.evaluate(() => (document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent));
const realOutputPath = commands.output_path;
let asked = 0, release;
const held = new Promise((r) => (release = r));
let reached;
const atGap = new Promise((r) => (reached = r));
commands.output_path = async (a) => {
  if (a.name.includes('_part') && ++asked === 2) { reached(); await held; }
  return realOutputPath(a);
};
await page.keyboard.press('p'); await page.waitForTimeout(100); await settle();
await page.click('#split-go');
await atGap; // part 1 is saved, part 2 hasn't started
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/multi.mp4');
await page.waitForFunction(() => !document.querySelector('#toast').hidden && /Wait for/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 });
check('split: another video dropped meanwhile is turned away', /Wait for the split/.test(await toastText()) && (await page.title()).startsWith('src.mp4'), `${await toastText()} | ${await page.title()}`);
await page.click('#split-cancel'); // "Stop"
release();
await page.waitForFunction(() => /Split stopped/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
commands.output_path = realOutputPath;
const outs2 = fs.readdirSync('/tmp/qc-split').filter((f) => f.includes('_part'));
check('split: Stop between two parts stops the rest', /1 of \d+ parts were saved/.test(await toastText()) && outs2.length === outs.length + 1, `${await toastText()} | ${outs2.length - outs.length} new file(s)`);
await page.waitForFunction(() => !document.querySelector('#split-done').hidden, null, { timeout: 5000 });
await page.click('#split-close'); await page.waitForTimeout(150);
await page.keyboard.press('p'); await page.waitForTimeout(200);
console.log('P opens it:', (await st()).open);
await page.keyboard.press('Escape'); await page.waitForTimeout(150);
console.log('Esc closes it:', !(await st()).open);
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close();
