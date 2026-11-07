// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
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
