// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const SRC = process.argv[2];
const SHOTS = '/tmp/qc-demo/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const files = new Map();
let nextId = 1;
const sse = new Set();
let job = null;

const emit = (event, payload) => { for (const res of sse) res.write(`data: ${JSON.stringify({ event, payload })}\n\n`); };

const commands = {
  startup_file: () => null,
  probe: ({ path: p }) => execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', p]).toString(),
  keyframes_near: ({ path: p, t, start }) => {
    const iv = `${(start + Math.max(0, t - 8)).toFixed(3)}%${(start + t + 0.5).toFixed(3)}`;
    return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', iv, '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', p])
      .toString().split('\n').filter((l) => l.includes('K')).map((l) => { const x = l.split(','); return [Number(x[0]) - start, Number(x[1]) - start]; });
  },
  waveform: ({ path: p, tracks, width, height }) => {
    if (!tracks) return null;
    const out = `/tmp/qc-demo/wave-${path.basename(p)}.png`;
    if (fs.existsSync(out)) return out;
    const mix = tracks > 1 ? Array.from({ length: tracks }, (_, i) => `[0:a:${i}]`).join('') + `amix=inputs=${tracks}:normalize=0,` : '[0:a:0]';
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', p, '-vn', '-filter_complex', `${mix}aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=white:scale=sqrt:draw=full:filter=peak`, '-frames:v', '1', '-update', '1', out]);
    return out;
  },
  engine_ready: () => (globalThis.__engineCalls = (globalThis.__engineCalls || 0) + 1) > (process.env.QC_SETUP ? 1 : 0),
  install_engine: async () => { for (const r of [0.2, 0.5, 0.8]) { emit('engine-progress', { ratio: r, stage: 'download' }); await new Promise((res) => setTimeout(res, 150)); } return null; },
  app_version: () => '1.0.0',
  check_update: () => (process.env.QC_UPDATE ? { version: '1.1.0', notes: 'Faster exports' } : null),
  install_update: () => null,
  detect_encoders: () => ['libx264', 'libx265'],
  filmstrip: ({ path: p, start = 0, duration, count, height }) => {
    const out = `/tmp/qc-demo/strip-${path.basename(p)}-${start.toFixed(3)}-${duration.toFixed(3)}-${count}.jpg`;
    if (fs.existsSync(out)) return out;
    const args = ['-v', 'error', '-y'];
    if (duration <= 30) {
      args.push('-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', p, '-an', '-vf', `fps=${count}/${duration.toFixed(4)},scale=-2:${height}:flags=fast_bilinear,setsar=1,tile=${count}x1,scale=out_range=full,format=yuvj420p`);
    } else {
      let g = '', st = '';
      for (let i = 0; i < count; i++) {
        args.push('-ss', (start + (i + 0.5) * duration / count).toFixed(3), '-noaccurate_seek', '-i', p);
        g += `[${i}:V:0]trim=end_frame=1,setpts=0,scale=-2:${height}:flags=fast_bilinear,setsar=1[t${i}];`; st += `[t${i}]`;
      }
      args.push('-filter_complex', `${g}${st}hstack=inputs=${count},scale=out_range=full,format=yuvj420p`);
    }
    args.push('-frames:v', '1', '-update', '1', '-q:v', '5', out);
    execFileSync('ffmpeg', args);
    return out;
  },
  media_url: ({ path: p }) => { const id = nextId++; files.set(String(id), p); return `/media/${id}`; },
  proxy_path: ({ path: p }) => [`/tmp/qc-test/out/proxy-ui.mp4`, false],
  remove_file: ({ path: p }) => { try { fs.unlinkSync(p); } catch {} return null; },
  sibling_videos: ({ path: p }) => fs.readdirSync(path.dirname(p)).filter((f) => /\.(mp4|mkv|mov)$/i.test(f)).sort().map((f) => path.join(path.dirname(p), f)),
  output_path: ({ src, ext, name, dir }) => {
    const d = dir || path.dirname(src);
    let c = path.join(d, `${name}.${ext}`);
    for (let n = 2; fs.existsSync(c); n++) c = path.join(d, `${name} (${n}).${ext}`);
    return c;
  },
  temp_output_path: ({ src, ext }) => path.join(path.dirname(src), path.basename(src).replace(/\.[^.]+$/, '') + `.quickcut-tmp.${ext}`),
  replace_original: ({ original, temp }) => {
    fs.mkdirSync('/tmp/qc-test/trash', { recursive: true });
    fs.renameSync(original, path.join('/tmp/qc-test/trash', path.basename(original)));
    const target = original.replace(/\.[^.]+$/, path.extname(temp));
    fs.renameSync(temp, target);
    return target;
  },
  classify: ({ paths }) => [paths.filter((p) => /\.(mp4|mkv|mov)$/i.test(p)), paths.filter((p) => /\.(mp3|wav)$/i.test(p))],
  pick_sounds: () => ['/tmp/qc-test/boom.wav', '/tmp/qc-test/whoosh.mp3'],
  cancel_ffmpeg: () => { if (job) { job.cancelled = true; job.proc.kill(); } return null; },
  run_ffmpeg: ({ args, duration }) => new Promise((resolve, reject) => {
    fs.writeFileSync('/tmp/qc-shots/last-args.txt', args.join('\n'));
    const proc = spawn('ffmpeg', args);
    job = { proc, cancelled: false };
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m) emit('ffmpeg-progress', { ratio: Math.min(1, Number(m.pop().split('=')[1]) / 1e6 / duration), speed: '' });
    });
    proc.on('close', (code) => {
      const j = job; job = null;
      if (j.cancelled) return reject('cancelled');
      code === 0 ? resolve(null) : reject(err.trim().split('\n').slice(-12).join('\n'));
    });
  }),
  reveal: () => null, open_external: () => null, is_file: () => true, pick_video: () => null, pick_folder: () => null,
};

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  if (req.url === '/__events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    sse.add(res);
    req.on('close', () => sse.delete(res));
    return;
  }
  if (req.url.startsWith('/__invoke/')) {
    const cmd = req.url.slice(10);
    let body = '';
    for await (const c of req) body += c;
    try {
      const out = await commands[cmd](JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: out ?? null }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ err: String(e) }));
    }
    return;
  }
  if (req.url.startsWith('/media/')) {
    const p = files.get(req.url.split('/')[2]);
    const size = fs.statSync(p).size;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const ct = p.endsWith('.png') ? 'image/png' : p.endsWith('.jpg') ? 'image/jpeg' : p.endsWith('.mp4') ? 'video/mp4' : p.endsWith('.wav') ? 'audio/wav' : p.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream';
    if (m) {
      const s = Number(m[1] || 0), e = m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': ct, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 });
      fs.createReadStream(p, { start: s, end: e }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(p).pipe(res);
    }
    return;
  }
  const f = path.join(SRC, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const mock = () => {
  const listeners = {};
  const es = new EventSource('/__events');
  es.onmessage = (m) => { const { event, payload } = JSON.parse(m.data); (listeners[event] || []).forEach((cb) => cb({ payload })); };
  window.__dropHandler = null;
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { const r = await (await fetch(`/__invoke/${cmd}`, { method: 'POST', body: JSON.stringify(args || {}) })).json(); if ('err' in r) throw r.err; return r.ok; } },
    event: { listen: async (ev, cb) => { (listeners[ev] ||= []).push(cb); return () => {}; } },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: async (cb) => { window.__dropHandler = cb; } }) },
    window: { getCurrentWindow: () => ({ setTitle: async (t) => { document.title = t; } }) },
  };
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1320, height: 840 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.addInitScript(mock);
await page.goto(base);
const st = () => page.evaluate(() => {
  const v = document.querySelector('#video');
  return {
    mode: document.body.classList.contains('mode-watch') ? 'Watch' : 'Edit',
    fullscreen: document.body.classList.contains('fullscreen'),
    editorShown: getComputedStyle(document.querySelector('#editor')).display !== 'none',
    watchShown: getComputedStyle(document.querySelector('#watchbar')).display !== 'none',
    exportShown: getComputedStyle(document.querySelector('#btn-export')).display !== 'none',
    t: Number(v.currentTime.toFixed(4)),
    time: document.querySelector('#w-time').textContent, total: document.querySelector('#w-total').textContent,
    frame: document.querySelector('#w-time').title.split('\n')[0],
    rate: v.playbackRate, speed: document.querySelector('#w-speed-label').textContent,
    loop: document.querySelector('#w-loop-btn').classList.contains('on') ? document.querySelector('#w-loop-btn').title.split('.')[0] : 'off',
    muted: v.muted, volume: v.volume,
    transform: v.style.transform, mag: document.querySelector('#w-mag').hidden ? null : document.querySelector('#w-mag').textContent,
    trim: [document.querySelector('#in-time').value, document.querySelector('#out-time').value],
  };
});
const log = async (l) => console.log(l.padEnd(18), JSON.stringify(await st()));
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
await page.waitForTimeout(400);
await log('opened (default)');
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/60-watch.png` });

// Frame stepping: src.mp4 is 60 fps with a frame counter burned in by testsrc2
await page.evaluate(() => { document.querySelector('#video').currentTime = 5; });
await page.waitForTimeout(300);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(150);
await log('5s + 1 frame');
for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
await log('+9 frames');
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(200);
await log('-1 frame');
// Hold the "next frame" button for ~1s
const nb = await page.locator('#w-next-frame').boundingBox();
await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
await page.mouse.down(); await page.waitForTimeout(1000); await page.mouse.up();
await page.waitForTimeout(250);
await log('held next 1s');

// Speed: pick 0.25 from the menu, then ] twice, then R; also a custom value
await page.click('#w-speed-val'); await page.waitForTimeout(150);
await page.screenshot({ path: `${SHOTS}/69-speed-menu.png` });
await page.evaluate(() => [...document.querySelectorAll('.menu.pop button')].find((b) => b.firstElementChild?.textContent === '0.25×').click());
await page.keyboard.press('Space'); await page.waitForTimeout(500);
await log('playing at 0.25');
await page.keyboard.press('Space');
await page.keyboard.press(']'); await page.keyboard.press(']');
await log('] ]');
await page.keyboard.press('r');
await page.click('#w-speed-btn'); await page.fill('.menu.pop input', '0.4'); await page.press('.menu.pop input', 'Enter');
await log('custom 0.4');
await page.keyboard.press('r');
// Volume: M mutes, down arrow lowers
await page.keyboard.press('m'); await log('muted');
await page.keyboard.press('m'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await log('volume -10%');

// Loop button: turns yellow, a section starts at the playhead; drag its end to 6s
await page.evaluate(() => { document.querySelector('#video').currentTime = 4; }); await page.waitForTimeout(250);
await page.click('#w-loop-btn'); await page.waitForTimeout(100);
await log('loop on at 4s');
const sb = await page.locator('#w-scrub').boundingBox();
const lb = await page.locator('#w-lb').boundingBox();
const dur = await page.evaluate(() => document.querySelector('#video').duration);
await page.mouse.move(lb.x + 10 /* the end anchor body: its time */, lb.y + lb.height / 2); await page.mouse.down();
await page.mouse.move(sb.x + (6 / dur) * sb.width, lb.y + lb.height / 2, { steps: 8 });
await page.screenshot({ path: `${SHOTS}/70-loop-drag.png` });
await page.mouse.up(); await page.waitForTimeout(150);
await log('dragged loop end');
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/71-loop.png` });
await page.click('#w-loop-btn'); await log('loop off');

// Loop with keys: I=2s, O=3s, B=3s, play 2.5s -> must still be inside [2,3]
await page.evaluate(() => { document.querySelector('#video').currentTime = 2; }); await page.waitForTimeout(250);
await page.keyboard.press('i');
await page.evaluate(() => { document.querySelector('#video').currentTime = 3; }); await page.waitForTimeout(250);
await page.keyboard.press('o');
await page.keyboard.press('Space'); await page.waitForTimeout(2500);
await log('looping 2.5s');
const tl = (await st()).t;
console.log('  inside loop:', tl >= 1.99 && tl <= 3.05);
await page.keyboard.press('Space');

// Picture zoom with the wheel
const vf = await page.locator('#vframe').boundingBox();
await page.mouse.move(vf.x + vf.width * 0.7, vf.y + vf.height * 0.3);
await page.mouse.wheel(0, -400); await page.waitForTimeout(200);
await log('wheel zoom');
await page.mouse.move(5, 5);
await page.screenshot({ path: `${SHOTS}/61-watch-zoomed-loop.png` });

// Switch to Edit: the loop becomes the trim
await page.keyboard.press('e'); await page.waitForTimeout(400);
await log('edit mode');
await page.screenshot({ path: `${SHOTS}/62-edit-from-loop.png` });
await page.screenshot({ path: `${SHOTS}/62-edit-from-loop.png` });
await page.click('#e-back'); await page.waitForTimeout(300);
await log('back to watch');
await page.click('#w-fullscreen'); await page.waitForTimeout(400);
await log('fullscreen');
await page.keyboard.press('r');
await page.mouse.move(600, 300);
await page.keyboard.press('Space'); await page.waitForTimeout(3200);
console.log('  controls auto-hidden while playing:', await page.evaluate(() => document.body.classList.contains('idle')));
await page.screenshot({ path: `${SHOTS}/67-fullscreen-idle.png` });
await page.mouse.move(400, 300); await page.waitForTimeout(300);
console.log('  controls back after mouse move:', await page.evaluate(() => !document.body.classList.contains('idle')));
await page.keyboard.press('Space');
await page.screenshot({ path: `${SHOTS}/68-fullscreen.png` });
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
await log('esc exits');
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close();
