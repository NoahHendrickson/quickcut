// End-to-end tests: build ffmpeg args with src/ffargs.js, run real ffmpeg, verify output.
// Usage: node test/ffargs.test.js <dir with src.mp4 multi.mp4 noaudio.mkv boom.wav whoosh.mp3>
import { execFileSync, spawnSync } from 'node:child_process';
const require_spawn = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }); return (r.stderr || '') + (r.stdout || ''); };
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  parseProbe, planExport, buildExportArgs, pickEncoder, snapToKeyframe, atempoChain,
  evenSplitPoints, nearestKeyframe, partsFromPoints, zoomAt,
  buildProxyArgs, ENCODER_CANDIDATES, parseTime, formatTime,
} from '../src/ffargs.js';

const dir = process.argv[2] || '/tmp/qc-test';
const out = path.join(dir, 'out');
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const probe = (f) => {
  const j = execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', f]).toString();
  return { info: { ...parseProbe(j), ext: f.split('.').pop() }, raw: JSON.parse(j) };
};
const streamDur = (raw, type) => {
  const s = raw.streams.find((x) => x.codec_type === type);
  return s ? Number(s.duration || raw.format.duration) : NaN;
};
// Emulates the Rust keyframes_near command.
const keyframesNear = (f, t, start) => {
  const iv = `${(start + Math.max(0, t - 8)).toFixed(3)}%${(start + t + 0.5).toFixed(3)}`;
  return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', iv,
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', f]).toString()
    .split('\n').filter((l) => l.includes('K')).map((l) => Number(l.split(',')[0]) - start);
};
const packetHashes = (f) =>
  execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_data_hash', 'MD5',
    '-show_entries', 'packet=data_hash', '-of', 'csv=p=0', f]).toString().trim().split('\n');

const available = ['libx264', 'libx265'];
const run = (name, file, edit, expect = {}) => {
  const { info } = probe(path.join(dir, file));
  const plan = planExport(info, edit);
  const enc = pickEncoder(info, available, 'auto');
  const outPath = path.join(out, `${name}.${plan.ext}`);
  const args = buildExportArgs(info, plan, { inputPath: path.join(dir, file), outputPath: outPath, encoder: enc, quality: 'high' });
  const t0 = Date.now();
  try {
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    check(`${name}: ffmpeg ran`, false, e.stderr?.toString());
    console.log('  args:', args.join(' '));
    return null;
  }
  const res = probe(outPath);
  console.log(`----  ${name}: mode=${plan.mode} ext=${plan.ext} start=${plan.start} outDur=${plan.outDuration.toFixed(3)} (${Date.now() - t0}ms)`);
  return { plan, res, outPath, info };
};

// 1. Lossless trim: start snaps to the 2s keyframe grid, packets identical to source.
{
  const kfs = keyframesNear(path.join(dir, 'src.mp4'), 5.3, 0);
  const kIn = snapToKeyframe(kfs, 5.3);
  check('keyframe snap 5.3 -> 4.0', near(kIn, 4.0, 0.02), `got ${kIn} from ${kfs}`);
  const r = run('copy', 'src.mp4', { inT: 5.3, outT: 12, keyframeIn: kIn, sfx: [], origVolume: 1 });
  if (r) {
    check('copy: mode', r.plan.mode === 'copy');
    check('copy: video duration ~8s', near(streamDur(r.res.raw, 'video'), 8, 0.05), String(streamDur(r.res.raw, 'video')));
    check('copy: audio duration ~8s', near(streamDur(r.res.raw, 'audio'), 8, 0.1), String(streamDur(r.res.raw, 'audio')));
    const srcH = packetHashes(path.join(dir, 'src.mp4'));
    const outH = packetHashes(r.outPath);
    const idx = srcH.indexOf(outH[0]);
    check('copy: video packets byte-identical to source', idx >= 0 && outH.every((h, i) => srcH[idx + i] === h), `${outH.length} packets at src index ${idx}`);
    check('copy: starts exactly on keyframe (frame 240)', idx === 240, `idx ${idx}`);
  }
}

// 2. Lossless video + sound effects (audio-only re-encode).
{
  const r = run('copy-sfx', 'src.mp4', {
    inT: 4, outT: 12, keyframeIn: 4, origVolume: 0.8,
    sfx: [{ path: path.join(dir, 'boom.wav'), at: 6, volume: 1 }, { path: path.join(dir, 'whoosh.mp3'), at: 11.5, volume: 0.5 }],
  });
  if (r) {
    check('copy-sfx: mode', r.plan.mode === 'copy-video');
    check('copy-sfx: video copied', r.res.raw.streams.find((s) => s.codec_type === 'video').codec_name === 'h264');
    check('copy-sfx: audio duration ~8s', near(streamDur(r.res.raw, 'audio'), 8, 0.1), String(streamDur(r.res.raw, 'audio')));
    const srcH = packetHashes(path.join(dir, 'src.mp4'));
    const outH = packetHashes(r.outPath);
    const idx = srcH.indexOf(outH[0]);
    check('copy-sfx: video packets byte-identical', idx >= 0 && outH.every((h, i) => srcH[idx + i] === h));
    check('copy-sfx: sfx at 2.0s output', near(r.plan.sfx[0].outAt, 2, 1e-6));
  }
}

// 3. Slow motion in the middle (0.25x), H.264.
{
  const r = run('slow', 'src.mp4', {
    inT: 2, outT: 10, slow: { enabled: true, start: 4, end: 6, speed: 0.25 },
    sfx: [{ path: path.join(dir, 'boom.wav'), at: 5, volume: 1 }], origVolume: 1,
  });
  if (r) {
    check('slow: mode', r.plan.mode === 'reencode');
    check('slow: planned 14s', near(r.plan.outDuration, 14, 1e-6));
    check('slow: video ~14s', near(streamDur(r.res.raw, 'video'), 14, 0.1), String(streamDur(r.res.raw, 'video')));
    check('slow: audio ~14s', near(streamDur(r.res.raw, 'audio'), 14, 0.15), String(streamDur(r.res.raw, 'audio')));
    check('slow: sfx mapped to 2+1/0.25=6s', near(r.plan.sfx[0].outAt, 6, 1e-6));
    check('slow: still 1080p', r.res.info.width === 1920 && r.res.info.height === 1080);
  }
}

// 4. 10-bit HEVC, 120fps, 2 audio tracks, slow-mo from the in-point to the end.
{
  const r = run('slow-hevc', 'multi.mp4', {
    inT: 3, outT: 9, slow: { enabled: true, start: 3, end: 9, speed: 0.5, muteAudio: true }, sfx: [], origVolume: 1,
  });
  if (r) {
    check('hevc: re-encoded as HEVC', r.res.raw.streams.find((s) => s.codec_type === 'video').codec_name === 'hevc');
    check('hevc: 10-bit kept', r.res.info.bitDepth === 10, r.res.info.pixfmt);
    check('hevc: hvc1 tag', r.res.raw.streams.find((s) => s.codec_type === 'video').codec_tag_string === 'hvc1');
    check('hevc: ~12s', near(streamDur(r.res.raw, 'video'), 12, 0.1), String(streamDur(r.res.raw, 'video')));
    check('hevc: tracks merged to 1', r.res.info.audioCount === 1);
  }
}

// 5. Lossless copy keeps all audio tracks.
{
  const kIn = snapToKeyframe(keyframesNear(path.join(dir, 'multi.mp4'), 5, 0), 5);
  const r = run('copy-multi', 'multi.mp4', { inT: 5, outT: 10, keyframeIn: kIn, sfx: [], origVolume: 1 });
  if (r) {
    check('copy-multi: keyframe at 4.0 (240 frames @120fps... keyint 240=2s)', near(kIn, 4, 0.02), String(kIn));
    check('copy-multi: both audio tracks kept', r.res.info.audioCount === 2);
    check('copy-multi: 10-bit HEVC untouched', r.res.info.vcodec === 'hevc' && r.res.info.bitDepth === 10);
  }
}

// 6. Video with no audio + a sound effect.
{
  const r = run('noaudio-sfx', 'noaudio.mkv', {
    inT: 2, outT: 6, keyframeIn: 2, sfx: [{ path: path.join(dir, 'boom.wav'), at: 3, volume: 1 }], origVolume: 1,
  });
  if (r) {
    check('noaudio: mkv kept', r.plan.ext === 'mkv');
    check('noaudio: has audio now', r.res.info.audioCount === 1);
    check('noaudio: ~4s', near(r.res.info.duration, 4, 0.1), String(r.res.info.duration));
  }
}

// 7. Frame-exact re-encode, no slow-mo.
{
  const r = run('exact', 'src.mp4', { inT: 5.3, outT: 7.3, exact: true, sfx: [], origVolume: 1 });
  if (r) {
    check('exact: mode', r.plan.mode === 'reencode');
    check('exact: ~2.0s', near(streamDur(r.res.raw, 'video'), 2, 0.05), String(streamDur(r.res.raw, 'video')));
    const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', r.outPath]).toString());
    check('exact: 120 frames @60fps', frames === 120, String(frames));
  }
}

// 8. Whole clip slowed to 0.1x (atempo chaining).
{
  const r = run('slow-all', 'src.mp4', { inT: 1, outT: 2, slow: { enabled: true, start: 0, end: 20, speed: 0.1 }, sfx: [], origVolume: 1 });
  if (r) {
    check('slow-all: ~10s', near(streamDur(r.res.raw, 'video'), 10, 0.2), String(streamDur(r.res.raw, 'video')));
    check('slow-all: audio ~10s', near(streamDur(r.res.raw, 'audio'), 10, 0.2), String(streamDur(r.res.raw, 'audio')));
  }
}

// 9. Proxy generation.
{
  const p = path.join(out, 'proxy.mp4');
  execFileSync('ffmpeg', buildProxyArgs(path.join(dir, 'multi.mp4'), p), { stdio: ['ignore', 'ignore', 'pipe'] });
  const { info } = probe(p);
  check('proxy: h264 720p 8-bit', info.vcodec === 'h264' && info.height === 720 && info.bitDepth === 8);
  check('proxy: same duration', near(info.duration, 15, 0.1), String(info.duration));
}

// 10. A/V sync: sync.{mp4,mkv} have a white flash and a beep at exactly t=5.0.
const syncTimes = (f) => {
  const r = require_spawn('ffmpeg', ['-hide_banner', '-i', f, '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG',
    '-af', 'silencedetect=n=-40dB:d=0.05', '-f', 'null', '-']);
  let flash = null, pts = null;
  for (const line of r.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) pts = Number(m[1]);
    const y = line.match(/YAVG=([\d.]+)/);
    if (y && Number(y[1]) > 100 && flash === null) flash = pts;
  }
  const b = r.match(/silence_end: ([\d.]+)/);
  return { flash, beep: b ? Number(b[1]) : null };
};
for (const ext of ['mp4', 'mkv']) {
  const f = path.join(dir, `sync.${ext}`);
  const { info } = probe(f);
  const kIn = snapToKeyframe(keyframesNear(f, 3.5, info.start), 3.5);
  const cases = [
    ['copy', { inT: 3.5, outT: 8, keyframeIn: kIn, sfx: [], origVolume: 1 }, 5 - kIn],
    ['remix', { inT: 3.5, outT: 8, keyframeIn: kIn, sfx: [], origVolume: 0.9 }, 5 - kIn],
    ['sfx', { inT: 3.5, outT: 8, keyframeIn: kIn, sfx: [{ path: path.join(dir, 'boom.wav'), at: 5, volume: 1 }], origVolume: 0 }, 5 - kIn],
    ['slow', { inT: 3.5, outT: 8, slow: { enabled: true, start: 4, end: 6, speed: 0.5 }, sfx: [], origVolume: 1 }, 0.5 + 1 / 0.5],
    ['slow-sfx', { inT: 3.5, outT: 8, slow: { enabled: true, start: 4, end: 6, speed: 0.5 }, sfx: [{ path: path.join(dir, 'boom.wav'), at: 5, volume: 1 }], origVolume: 0 }, 0.5 + 1 / 0.5],
  ];
  for (const [name, edit, expected] of cases) {
    const r = run(`sync-${ext}-${name}`, `sync.${ext}`, edit);
    if (!r) continue;
    const t = syncTimes(r.outPath);
    // Video may start up to ~2 frames late in MP4 (B-frame delay, players start there);
    // what matters is that picture and sound stay together: within one 60fps frame.
    const ok = t.flash !== null && t.beep !== null && near(t.flash, expected, 0.04) && Math.abs(t.beep - t.flash) <= 0.017;
    check(`sync ${ext} ${name}: flash at ${expected.toFixed(3)}s, beep within 1 frame`, ok, `flash=${t.flash} beep=${t.beep} offset=${t.flash !== null && t.beep !== null ? ((t.beep - t.flash) * 1000).toFixed(1) + 'ms' : '?'}`);
  }
}

// 11. Split into 4 lossless parts: concatenated, the parts' video packets must be
// exactly the source's (no missing or repeated frames at the cuts).
const keyframesWithDts = (f, t, start) => {
  const iv = `${(start + Math.max(0, t - 8)).toFixed(3)}%${(start + t + 0.5).toFixed(3)}`;
  return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', iv,
    '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', f]).toString()
    .split('\n').filter((l) => l.includes('K')).map((l) => { const x = l.split(','); return [Number(x[0]) - start, Number(x[1]) - start]; });
};
for (const file of ['src.mp4', 'sync.mkv', 'multi.mp4']) {
  const f = path.join(dir, file);
  const { info } = probe(f);
  const snapped = evenSplitPoints(0, info.duration, 4).map((p) => nearestKeyframe(keyframesWithDts(f, p, info.start), p, 0, info.duration));
  const dts = new Map(snapped.map((k) => [k.t, k.dts]));
  const parts = partsFromPoints(0, info.duration, snapped.map((k) => k.t));
  let all = [];
  let ok = true;
  for (const p of parts) {
    const plan = planExport(info, { inT: p.inT, outT: p.outT, keyframeIn: p.inT, endDts: dts.get(p.outT) ?? null, sfx: [], origVolume: 1 });
    const outPath = path.join(out, `split-${file}-${p.index}.${plan.ext}`);
    try {
      execFileSync('ffmpeg', buildExportArgs(info, plan, { inputPath: f, outputPath: outPath }), { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { ok = false; console.log(e.stderr?.toString()); }
    all = all.concat(packetHashes(outPath));
  }
  const src = packetHashes(f);
  check(`split ${file} into ${parts.length}: parts join byte-identically`, ok && parts.length === 4 && all.length === src.length && all.every((h, i) => h === src[i]),
    `${parts.map((p) => `${p.inT.toFixed(2)}-${p.outT.toFixed(2)}`).join(', ')}; ${all.length}/${src.length} packets`);
}
check('partsFromPoints drops duplicate cuts', partsFromPoints(0, 10, [4, 4, 4.01, 8]).length === 3);
check('nearestKeyframe stays inside range', nearestKeyframe([[0, 0], [2, 1.9], [4, 3.9]], 0.5, 0, 10).t === 2);

// 12. Zoom effect: 2x into the center from 3s to 7s.
const zoom2x = { start: 3, end: 7, amount: 2, fx: 0.5, fy: 0.5, ease: 'smooth' };
const psnr = (a, b) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /average:([\d.inf]+)/.exec(r.stderr || '');
  return m ? (m[1] === 'inf' ? 99 : Number(m[1])) : 0;
};
{
  const r = run('zoom', 'src.mp4', { inT: 2, outT: 8, zooms: [zoom2x], sfx: [], origVolume: 1 });
  if (r) {
    check('zoom: re-encoded because of zoom', r.plan.mode === 'reencode' && r.plan.reasons.includes('zoom'));
    check('zoom: same resolution', r.res.info.width === 1920 && r.res.info.height === 1080);
    check('zoom: 6s long', near(streamDur(r.res.raw, 'video'), 6, 0.05), String(streamDur(r.res.raw, 'video')));
    // Output at 3.0s (= source 5.0s, fully zoomed) should equal the source's center quarter scaled 2x.
    const outF = path.join(out, 'zoom-out.png');
    const refF = path.join(out, 'zoom-ref.png');
    const unz = path.join(out, 'zoom-unzoomed.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '3', '-i', r.outPath, '-frames:v', '1', outF]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '5', '-i', path.join(dir, 'src.mp4'), '-frames:v', '1', '-vf', 'crop=960:540:480:270,scale=1920:1080:flags=bicubic', refF]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '5', '-i', path.join(dir, 'src.mp4'), '-frames:v', '1', unz]);
    const p1 = psnr(outF, refF);
    const p2 = psnr(outF, unz);
    check('zoom: fully zoomed frame matches a 2x center crop', p1 > 28 && p1 > p2 + 5, `PSNR vs 2x crop ${p1.toFixed(1)}dB, vs unzoomed ${p2.toFixed(1)}dB`);
    // Before the zoom starts (output 0.5s = source 2.5s) the frame is untouched.
    const early = path.join(out, 'zoom-early.png');
    const earlyRef = path.join(out, 'zoom-early-ref.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.5', '-i', r.outPath, '-frames:v', '1', early]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2.5', '-i', path.join(dir, 'src.mp4'), '-frames:v', '1', earlyRef]);
    check('zoom: frames before the zoom are unchanged', psnr(early, earlyRef) > 35, `${psnr(early, earlyRef).toFixed(1)}dB`);
  }
}
{
  const r = run('zoom-10bit', 'multi.mp4', { inT: 2, outT: 8, zooms: [{ ...zoom2x, fx: 0.2, fy: 0.8 }], sfx: [], origVolume: 1 });
  if (r) check('zoom: 10-bit HEVC stays 10-bit', r.res.info.bitDepth === 10 && r.res.info.vcodec === 'hevc', r.res.info.pixfmt);
}
{
  const r = run('zoom-slow', 'src.mp4', { inT: 2, outT: 10, zooms: [zoom2x], slow: { enabled: true, start: 4, end: 6, speed: 0.5 }, sfx: [], origVolume: 1 });
  if (r) check('zoom + slow-mo: 10s long', near(streamDur(r.res.raw, 'video'), 10, 0.1), String(streamDur(r.res.raw, 'video')));
}
{
  // Trim starts in the middle of the zoom: first frame is already zoomed, size must still be right.
  const r = run('zoom-mid', 'src.mp4', { inT: 5, outT: 9, zooms: [zoom2x], sfx: [], origVolume: 1 });
  if (r) check('zoom: trim starting mid-zoom keeps 1920x1080', r.res.info.width === 1920 && r.res.info.height === 1080);
}
check('zoomAt: none before', zoomAt([zoom2x], 2).scale === 1);
check('zoomAt: full in the middle', Math.abs(zoomAt([zoom2x], 5).scale - 2) < 1e-9);
check('zoomAt: halfway up the ramp is 1.5x', Math.abs(zoomAt([zoom2x], 3.3).scale - 1.5) < 1e-9);

// Unit bits
check('atempo 0.25', atempoChain(0.25) === 'atempo=0.5,atempo=0.5');
check('atempo 0.1', atempoChain(0.1) === 'atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.8');
check('atempo 4', atempoChain(4) === 'atempo=2,atempo=2');
check('pickEncoder 10-bit h264 -> hevc', pickEncoder({ vcodec: 'h264', bitDepth: 10 }, ENCODER_CANDIDATES).family === 'hevc');
check('pickEncoder prefers nvenc', pickEncoder({ vcodec: 'h264', bitDepth: 8 }, ['libx264', 'h264_nvenc', 'h264_qsv']).name === 'h264_nvenc');
check('pickEncoder cpu pref', pickEncoder({ vcodec: 'h264', bitDepth: 8 }, ['libx264', 'h264_nvenc'], 'cpu').name === 'libx264');
check('pickEncoder av1 w/o av1 enc -> hevc', pickEncoder({ vcodec: 'av1', bitDepth: 8 }, ['libx265', 'hevc_amf']).name === 'hevc_amf');
check('parseTime', parseTime('1:02.5') === 62.5 && parseTime('1:00:00') === 3600);
check('formatTime', formatTime(62.5) === '1:02.500' && formatTime(3725.25) === '1:02:05.250');

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
