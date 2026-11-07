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
  if (!localStorage.getItem('qc.settings')) localStorage.setItem('qc.settings', JSON.stringify({ mode: 'edit' }));
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
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
const drop = (p) => page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), p);
const seekTo = async (t) => { await page.evaluate((t) => { document.querySelector('#video').currentTime = t; }, t); await page.waitForTimeout(400); };
const info = () => page.evaluate(() => ({
  clips: [...document.querySelectorAll('.zoom-clip')].map((c) => c.textContent.trim()),
  box: document.querySelector('#zoom-box').hidden ? null : (() => { const b = document.querySelector('#zoom-box'); return [b.style.left, b.style.top, b.style.width]; })(),
  videoTransform: document.querySelector('#video').style.transform,
  origin: document.querySelector('#video').style.transformOrigin,
  mode: document.querySelector('#export-mode').textContent,
}));
await drop('/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelectorAll('#tl-thumbs > div').length > 0, null, { timeout: 30000 });
await seekTo(5);
await page.click('.tool[data-tool="zoom"]');
await page.waitForTimeout(200);
await shot('30-zoom-tool');
await page.click('#zoom-add');
await page.waitForTimeout(300);
console.log('added', JSON.stringify(await info()));
await page.click('#zoom-amounts button[data-v="2"]');
// Aim: drag the box toward the top-right of the video
const vf = await page.locator('#vframe').boundingBox();
const bx = await page.locator('#zoom-box').boundingBox();
await page.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2);
await page.mouse.down();
await page.mouse.move(vf.x + vf.width * 0.8, vf.y + vf.height * 0.25, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
console.log('aimed', JSON.stringify(await info()));
await shot('31-zoom-aim');
// Preview: switch to another tool -> preview shows the zoom applied at the playhead
await page.click('.tool[data-tool="trim"]');
await seekTo(6.5);
await page.waitForTimeout(300);
console.log('preview mid-zoom', JSON.stringify(await info()));
await shot('32-zoom-preview');
await seekTo(2);
console.log('preview before zoom', JSON.stringify(await info()));
// Resize the zoom clip by dragging its end
const clip = await page.locator('.zoom-clip').boundingBox();
await page.mouse.move(clip.x + clip.width - 3, clip.y + clip.height / 2);
await page.mouse.down();
await page.mouse.move(clip.x + clip.width + 120, clip.y + clip.height / 2, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
console.log('resized', JSON.stringify(await page.$eval('.zoom-clip', (c) => c.title)));
// Export
await page.click('#btn-export');
await page.click('#btn-export');
await page.waitForFunction(() => !document.querySelector('#export-result').hidden, null, { timeout: 120000 });
console.log('export:', (await page.textContent('#export-result')).replace(/\s+/g, ' '), '|', (await info()).mode);
console.log('args:', fs.readFileSync('/tmp/qc-shots/last-args.txt', 'utf8').includes('overlay=') ? 'zoom graph present' : 'NO ZOOM GRAPH');
console.log('errors:', JSON.stringify(errors));
await browser.close();
server.close();
