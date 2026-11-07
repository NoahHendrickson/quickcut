// Home screen: recent videos, a folder of videos with thumbnails, the update banner.
// Runs the real frontend in Chrome with a mock Tauri bridge (real ffmpeg for thumbnails).
// Usage: node test/ui-home.mjs src  (needs the media from test/make-media.sh in /tmp/qc-test)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const SRC = process.argv[2];
const SHOTS = '/tmp/qc-demo/shots';
const DIR = '/tmp/qc-home';
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const now = Date.now() / 1000;
for (const [i, [from, to]] of [['src.mp4', 'Clutch round.mp4'], ['noaudio.mkv', 'Warmup.mkv'], ['multi.mp4', 'Ranked match.mp4']].entries()) {
  fs.copyFileSync(`/tmp/qc-test/${from}`, `${DIR}/${to}`);
  fs.utimesSync(`${DIR}/${to}`, now - i * 3600, now - i * 3600);
}
fs.writeFileSync(`${DIR}/notes.txt`, 'not a video');
fs.writeFileSync(`${DIR}/x.quickcut-tmp.mp4`, 'half-written export');

const files = new Map();
let nextId = 1;
let thumbCalls = 0;
const stat = (p) => {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? { path: p, name: path.basename(p), size: s.size, modified: s.mtimeMs } : null;
  } catch { return null; }
};
const commands = {
  startup_file: () => null,
  engine_ready: () => true,
  app_version: () => '1.2.5',
  check_update: () => (process.env.QC_NO_UPDATE ? null : { version: '1.3.0', notes: 'Recent videos on the home screen\nOther fixes' }),
  detect_encoders: () => ['libx264'],
  videos_dir: () => null,
  folder_videos: ({ dir, limit }) => fs.readdirSync(dir).filter((f) => /\.(mp4|mkv|mov)$/i.test(f) && !f.includes('.quickcut-tmp'))
    .map((f) => stat(path.join(dir, f))).sort((a, b) => b.modified - a.modified).slice(0, limit),
  stat_videos: ({ paths }) => paths.map(stat).filter(Boolean),
  thumbnail: ({ path: p, height }) => {
    thumbCalls++;
    const out = `/tmp/qc-demo/thumb-${path.basename(p)}.jpg`;
    const len = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString());
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(len * 0.1, 10)), '-i', p, '-an', '-vf', `scale=-2:${height}`, '-frames:v', '1', '-update', '1', out]);
    return [out, len];
  },
  media_url: ({ path: p }) => { const id = nextId++; files.set(String(id), p); return `/media/${id}`; },
  probe: ({ path: p }) => execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', p]).toString(),
  keyframes_near: () => [[0, 0]],
  filmstrip: () => { throw 'skip'; },
  waveform: () => null,
  sibling_videos: () => [],
  output_path: ({ src }) => src + '.out.mp4',
  pick_folder: () => DIR,
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/__events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return; }
  if (req.url.startsWith('/__invoke/')) {
    const cmd = req.url.slice(10);
    let body = '';
    for await (const c of req) body += c;
    try {
      if (!commands[cmd]) throw `no mock for ${cmd}`;
      const out = await commands[cmd](JSON.parse(body || '{}'));
      res.end(JSON.stringify({ ok: out ?? null }));
    } catch (e) {
      res.end(JSON.stringify({ err: String(e) }));
    }
    return;
  }
  if (req.url.startsWith('/media/')) {
    const p = files.get(req.url.split('/')[2]);
    res.writeHead(200, { 'Content-Type': p.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4' });
    return fs.createReadStream(p).pipe(res);
  }
  const f = path.join(SRC, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const mock = ({ dir }) => {
  if (!localStorage.getItem('qc.recent')) {
    localStorage.setItem('qc.settings', JSON.stringify({ mode: 'edit', lastDir: dir })); // Edit: its panel must not take space on the home screen
    localStorage.setItem('qc.recent', JSON.stringify([`${dir}/Warmup.mkv`, '/gone/deleted.mp4', `${dir}/Clutch round.mp4`]));
  }
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { const r = await (await fetch(`/__invoke/${cmd}`, { method: 'POST', body: JSON.stringify(args || {}) })).json(); if ('err' in r) throw r.err; return r.ok; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => {} }) },
    window: { getCurrentWindow: () => ({ setTitle: async (t) => { document.title = t; } }) },
  };
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1320, height: 840 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript(mock, { dir: DIR });
await page.goto(`http://127.0.0.1:${server.address().port}`);

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };
const names = (grid) => page.$$eval(`${grid} .vname`, (els) => els.map((e) => e.textContent));

await page.waitForFunction(() => document.querySelectorAll('#folder-grid img.ready').length === 3, null, { timeout: 15000 });
check(await page.$eval('#empty-state', (e) => e.getBoundingClientRect().height === innerHeight), 'home fills the whole window');
check(JSON.stringify(await names('#recent-grid')) === '["Warmup.mkv","Clutch round.mp4"]', 'recent: existing files only, most recent first');
check(JSON.stringify(await names('#folder-grid')) === '["Clutch round.mp4","Warmup.mkv","Ranked match.mp4"]', 'folder: videos only, newest first');
check(await page.textContent('#home-folder-name') === 'qc-home', 'folder name shown');
check(await page.textContent('#folder-grid .vcard:first-child .vdur') === '0:20', 'duration badge');
// Layout: the release's "Drop a video to start" screen near the middle, the video lists below it
const box = (sel) => page.locator(sel).boundingBox();
const H = 840;
const [hero, title, openBtn, recentBox] = [await box('.home-hero'), await box('.empty-title'), await box('#btn-open-empty'), await box('#home-recent')];
check(Math.abs(title.x + title.width / 2 - 660) < 2, 'hero centered horizontally');
check(title.y > H * 0.3 && title.y < H * 0.55, `hero near the middle of the window (title at ${Math.round(title.y)}px of ${H})`);
check(recentBox.y > hero.y + hero.height && recentBox.y < H - 60, `recent videos below it, peeking in at the bottom (${Math.round(recentBox.y)}px)`);
if (!process.env.QC_NO_UPDATE) {
  const upd = await box('#home-update');
  check(await page.isVisible('#home-update') && await page.textContent('#home-update') === 'Update to 1.3.0', 'update button shown');
  check(upd.y === openBtn.y && upd.x > openBtn.x + openBtn.width, 'update button next to Open video');
  check((await page.getAttribute('#home-update', 'title')).startsWith('Recent videos on the home screen'), 'update notes in its tooltip');
} else {
  check(await page.isHidden('#home-update'), 'no update: no update button');
}
check(thumbCalls === 3, `one thumbnail per file (${thumbCalls})`);
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/${process.env.QC_NO_UPDATE ? '96-home-no-update' : '94-home'}.png` });

// Forget a recent video
await page.hover('#recent-grid .vcard:first-child');
await page.click('#recent-grid .vcard:first-child .vforget');
await page.waitForTimeout(200);
check(JSON.stringify(await names('#recent-grid')) === '["Clutch round.mp4"]', 'remove from recent');

// Open from the folder grid: the video loads and becomes the most recent
await page.click('#folder-grid .vcard:nth-child(3)');
await page.waitForFunction(() => document.title.startsWith('Ranked match.mp4'), null, { timeout: 10000 });
check(await page.isHidden('#empty-state'), 'home hidden once a video is open');
// Volume slider (Watch bar): blue up to the knob
await page.keyboard.press('w');
await page.hover('.pb-vol');
await page.waitForTimeout(250);
const vol = await page.locator('#w-volume').boundingBox();
await page.mouse.click(vol.x + 7 + 0.4 * (vol.width - 14), vol.y + vol.height / 2);
await page.waitForTimeout(150);
const v = await page.$eval('#w-volume', (el) => [el.value, el.style.getPropertyValue('--v')]);
check(v[0] === v[1] && Math.abs(Number(v[0]) - 0.4) < 0.05, `volume fill follows the knob (${v.join(' / ')})`);
await page.screenshot({ path: `${SHOTS}/98-volume.png`, clip: { x: vol.x - 40, y: vol.y - 14, width: vol.width + 60, height: vol.height + 28 } });
const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('qc.recent')));
check(rec[0].endsWith('Ranked match.mp4') && rec.length === 3, 'opened video is first in recent');

// Bare state: nothing recent, empty folder
await page.evaluate(() => { localStorage.setItem('qc.recent', '[]'); localStorage.setItem('qc.settings', JSON.stringify({ homeDir: '/tmp/qc-home-empty' })); });
fs.mkdirSync('/tmp/qc-home-empty', { recursive: true });
await page.reload();
await page.waitForTimeout(600);
check(await page.isHidden('#home-recent') && await page.isVisible('#folder-none'), 'empty: no recents, empty folder message');
check(await page.isVisible('#btn-open-empty'), 'empty: open button still there');

// Nothing at all to list: the hero sits in the true center
await page.evaluate(() => { localStorage.setItem('qc.recent', '[]'); localStorage.setItem('qc.settings', '{}'); });
await page.reload();
await page.waitForTimeout(600);
const t2 = await box('.home-hero');
check(await page.isHidden('#home-recent') && await page.isHidden('#home-folder'), 'nothing to list: no sections');
check(Math.abs(t2.y + t2.height / 2 - H / 2) < 4, 'nothing to list: hero in the true center');
await page.screenshot({ path: `${SHOTS}/95-home-bare.png` });

check(!errors.length, `no page errors ${errors.join(' | ')}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
