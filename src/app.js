import {
  parseProbe, planExport, buildExportArgs, buildProxyArgs, pickEncoder, snapToKeyframe,
  ENCODER_CANDIDATES, ENCODERS, VENDOR_LABEL, formatTime, parseTime,
  evenSplitPoints, nearestKeyframe, partsFromPoints, zoomAt, zoomRamp, parseDuration, fixedSplitPoints, canExactCopy,
} from './ffargs.js';

const T = window.__TAURI__;
const invoke = T.core.invoke;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const basename = (p) => p.split(/[\\/]/).pop();
const dirname = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
const extOf = (p) => (p.split('.').pop() || '').toLowerCase();
const stemOf = (p) => basename(p).replace(/\.[^.]+$/, '');
const uid = () => Math.random().toString(36).slice(2, 10);
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
/** 1:02.35 (centiseconds): precise enough to read, short enough to scan. */
const fmt = (t) => formatTime(Math.round(t * 100) / 100 + 1e-6).slice(0, -1);
/** 0.5 -> "0.5", 2 -> "2", 0.333 -> "0.333" */
const fmtSpeed = (v) => String(Math.round(v * 1000) / 1000);
const describeSpeed = (v) =>
  Math.abs(v - 1) < 1e-6 ? 'Normal speed (no effect)'
    : v < 1 ? `${Math.round((1 / v) * 10) / 10}× slower`
      : `${Math.round(v * 10) / 10}× faster`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const settings = Object.assign(
  { quality: 'high', encoder: 'auto', outDir: '', suffix: '_edit', previewVolume: 1, lastDir: '' },
  JSON.parse(localStorage.getItem('qc.settings') || '{}'),
);
const saveSettings = () => localStorage.setItem('qc.settings', JSON.stringify(settings));
let library = JSON.parse(localStorage.getItem('qc.library') || '[]'); // [{id, name, path}]
const saveLibrary = () => localStorage.setItem('qc.library', JSON.stringify(library));

const S = {
  path: null,
  info: null,
  siblings: [],
  usingProxy: false,
  inT: 0,
  outT: 0,
  slow: { enabled: false, start: 0, end: 0, speed: 0.5, muteAudio: false },
  sfx: [], // {id, path, name, at, volume, duration}
  zooms: [], // {id, start, end, amount, fx, fy, ease} (source seconds, sorted, non-overlapping)
  selectedZoom: null,
  freezes: [], // {id, at, hold}: hold the frame at source time `at` for `hold` seconds, then carry on
  selectedFreeze: null,
  holding: null, // id of the freeze being held during preview playback
  justHeld: null,
  selectedSfx: null,
  origVolume: 1,
  exact: false,
  keyframeIn: null,
  keyframeFor: null,
  // 'new' (original untouched) unless the user explicitly picks 'replace'; never remembered.
  save: { mode: 'new', name: '', nameEdited: false },
  view: { start: 0, end: 1 },
  thumbs: null, // {url, count, aspect}: whole video
  detail: null, // {url, start, end, count}: exact frames for the zoomed-in view
  wave: null, // media URL of the waveform PNG
  tool: 'trim', // trim | slow | zoom | freeze | sound | amp | export
  // Watch = a player for investigating clips; Edit = the editor. Remembered between launches.
  mode: settings.mode === 'edit' ? 'edit' : 'watch',
  watchRate: Number(settings.watchRate) > 0 ? Number(settings.watchRate) : 1,
  loop: { a: null, b: null }, // Watch-mode A-B loop (source seconds)
  mag: { scale: 1, x: 0, y: 0 }, // Watch-mode picture zoom (px within the video frame)
  quick: null, // Quick trim in the player: { prevIn, prevOut, saved: null | path, saving: false }
  confirmReplace: false,
  busy: null, // 'proxy' | 'export'
  progress: null,
  encoders: [],
  encodersReady: null,
  openToken: 0,
};

const video = $('#video');
const track = $('#tl-inner');
const strip = $('#tl-strip');
const duration = () => (S.info ? S.info.duration || video.duration || 0 : 0);
const fps = () => (S.info && S.info.fps) || 30;

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}
function overlay(text, ratio = null) {
  $('#overlay').hidden = text == null;
  if (text != null) $('#overlay-text').textContent = text;
  $('#overlay-bar').style.width = ratio == null ? '0%' : `${(ratio * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Tool bar: square tool buttons; the active tool's options show inline next to them
// ---------------------------------------------------------------------------
function setTool(name) {
  if (S.tool === name) return;
  S.tool = name;
  if (name === 'zoom' && !S.zooms.some((z) => z.id === S.selectedZoom)) {
    const t = currentT();
    S.selectedZoom = (S.zooms.find((z) => t >= z.start && t <= z.end) || S.zooms[0])?.id ?? null;
  }
  S.confirmReplace = false;
  syncAll();
}

// ---------------------------------------------------------------------------
// Opening videos
// ---------------------------------------------------------------------------
async function openVideo(path) {
  await engineReady;
  if (S.busy === 'export') return toast('Wait for the export to finish first');
  if (S.busy === 'proxy') await cancelJob();
  const token = ++S.openToken;
  let info;
  try {
    info = parseProbe(await invoke('probe', { path }));
  } catch (e) {
    return toast(`Couldn't read that file: ${String(e).slice(0, 200)}`, 6000);
  }
  if (token !== S.openToken) return;
  if (!info.hasVideo) return toast('That file has no video in it');
  info.ext = extOf(path);

  stopAllSfx();
  Object.assign(S, {
    path, info, usingProxy: false, inT: 0, outT: info.duration, sfx: [], selectedSfx: null, zooms: [], selectedZoom: null, freezes: [], selectedFreeze: null,
    origVolume: 1, exact: !canExactCopy(info), keyframeIn: null, keyframeFor: null, thumbs: null, detail: null, wave: null, confirmReplace: false,
    loop: { a: null, b: null }, mag: { scale: 1, x: 0, y: 0 }, quick: null,
    view: { start: 0, end: Math.max(info.duration, 0.1) },
  });
  S.slow = { enabled: false, start: 0, end: 0, speed: S.slow.speed, muteAudio: S.slow.muteAudio };
  S.save.nameEdited = false;
  S.save.name = defaultSaveName();
  settings.lastDir = dirname(path);
  saveSettings();

  $('#empty-state').hidden = true;
  $('#time-total').textContent = fmt(info.duration);
  // The file name + details live in the window's own title bar (no header taking space from the video).
  T.window.getCurrentWindow().setTitle(`${basename(path)} · ${describe(info)} — QuickCut`).catch(() => {});
  $('#btn-open').title = `${path}\nOpen another video (Ctrl+O)`;

  video.pause();
  netRetries = 0;
  video.src = await invoke('media_url', { path });
  video.currentTime = 0;
  invoke('sibling_videos', { path }).then((list) => {
    if (token !== S.openToken) return;
    S.siblings = list; // for PgUp / PgDn
  });
  loadFilmstrip(token);
  loadWaveform(token);
  syncAll();
  requestKeyframe();
}

function describe(i) {
  const codec = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', prores: 'ProRes' }[i.vcodec] || (i.vcodec || '').toUpperCase();
  const h = Math.min(i.width, i.height);
  const res = h >= 2160 ? '4K' : h >= 1440 ? '1440p' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : `${i.width}×${i.height}`;
  const parts = [res, `${Math.round(i.fps)} fps`, codec + (i.bitDepth > 8 ? ' 10-bit' : '') + (i.hdr ? ' HDR' : '')];
  if (i.audioCount > 1) parts.push(`${i.audioCount} audio tracks`);
  if (i.audioCount === 0) parts.push('no sound');
  return parts.join(' · ');
}

function gotoSibling(delta) {
  const idx = S.siblings.indexOf(S.path);
  const next = S.siblings[idx + delta];
  if (idx >= 0 && next) openVideo(next);
}

// The webview can't decode every codec (e.g. HEVC without the Windows HEVC
// extension). Then build a small H.264 preview copy; export always uses the original.
async function fallbackToProxy() {
  if (S.usingProxy || !S.path || S.busy) return;
  const token = S.openToken;
  S.usingProxy = true;
  try {
    const [proxy, exists] = await invoke('proxy_path', { path: S.path });
    if (!exists) {
      S.busy = 'proxy';
      overlay("This video's format can't be previewed directly, so QuickCut is making a preview copy. Your export still uses the original at full quality.", 0);
      try {
        await invoke('run_ffmpeg', { args: buildProxyArgs(S.path, proxy), duration: duration() });
      } catch (e) {
        invoke('remove_file', { path: proxy });
        throw e;
      } finally {
        S.busy = null;
      }
    }
    if (token !== S.openToken) return;
    overlay(null);
    const t = video.currentTime;
    video.src = await invoke('media_url', { path: proxy });
    video.currentTime = t;
    syncAll(); // shows the "Preview copy" label
  } catch (e) {
    overlay(null);
    if (String(e) !== 'cancelled') toast(`Couldn't create a preview: ${String(e).slice(0, 200)}`, 6000);
  }
}
let netRetries = 0;
video.addEventListener('error', () => {
  if (!S.path) return;
  const code = video.error && video.error.code;
  // Only a format the webview really can't decode gets a preview copy (3 = decode, 4 = unsupported).
  if (code === 3 || code === 4) return fallbackToProxy();
  // A loading hiccup: reload the original where we were instead of dropping quality.
  if (netRetries++ < 2) {
    const t = currentT();
    const src = video.src;
    video.src = src;
    video.currentTime = t;
  } else {
    toast("Couldn't load the video. Try opening it again", 5000);
  }
});
video.addEventListener('loadeddata', () => {
  // Audio-only playback of an unsupported video codec shows up as 0×0.
  if (S.path && video.videoWidth === 0) fallbackToProxy();
});

// ---------------------------------------------------------------------------
// Filmstrip thumbnails
// ---------------------------------------------------------------------------
async function loadFilmstrip(token) {
  strip.classList.add('loading');
  $('#tl-thumbs').innerHTML = '';
  const i = S.info;
  const aspect = i.width && i.height ? i.width / i.height : 16 / 9;
  // Enough thumbnails to fill the strip when zoomed in a bit (more for tall video).
  const count = clamp(Math.ceil(4800 / (56 * aspect)), 24, 96);
  try {
    const file = await invoke('filmstrip', { path: S.path, duration: duration(), count, height: 112 });
    const url = await invoke('media_url', { path: file });
    const img = new Image();
    img.src = url;
    await img.decode();
    if (token !== S.openToken) return;
    // Measure the real thumbnail shape (handles rotated phone videos).
    S.thumbs = { url, count, aspect: img.naturalWidth / count / img.naturalHeight };
    renderThumbs();
  } catch {
    // No thumbnails is fine: the strip just stays plain.
  } finally {
    if (token === S.openToken) strip.classList.remove('loading');
  }
}
const tileWidth = () => Math.max(16, Math.round(strip.clientHeight * (S.thumbs ? S.thumbs.aspect : 16 / 9)));

function renderThumbs() {
  const box = $('#tl-thumbs');
  if (!S.thumbs) return (box.innerHTML = '');
  const h = strip.clientHeight;
  const w = strip.clientWidth;
  const tileW = tileWidth();
  const n = Math.ceil(w / tileW);
  const d = duration();
  const det = S.detail;
  let html = '';
  for (let k = 0; k < n; k++) {
    const t = xToT(k * tileW + tileW / 2);
    // Exact frames where the zoomed-in strip covers this tile, else the whole-video strip.
    const src = det && t >= det.start && t <= det.end ? det : S.thumbs;
    const from = src === det ? det.start : 0;
    const to = src === det ? det.end : d;
    const idx = clamp(Math.floor(((t - from) / (to - from)) * src.count), 0, src.count - 1);
    html += `<div style="width:${tileW}px;background-image:url('${src.url}');background-size:${src.count * tileW}px ${h}px;background-position:-${idx * tileW}px 0"></div>`;
  }
  box.innerHTML = html;
}

// When zoomed in past what the whole-video strip can show, render exact frames
// for the visible stretch (plus a margin so small pans stay sharp).
let detailTimer;
let detailSeq = 0;
function requestDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(loadDetail, 250);
}
async function loadDetail() {
  if (!S.path || !S.thumbs) return;
  const d = duration();
  const span = S.view.end - S.view.start;
  const n = Math.max(1, Math.ceil(strip.clientWidth / tileWidth()));
  const perTile = span / n;
  if (d / S.thumbs.count <= perTile * 1.05) {
    if (S.detail) { S.detail = null; renderThumbs(); }
    return;
  }
  const det = S.detail;
  if (det && det.start <= S.view.start + 1e-6 && det.end >= S.view.end - 1e-6 && Math.abs((det.end - det.start) / det.count - perTile) / perTile < 0.35) return;
  const start = Math.max(0, S.view.start - span * 0.25);
  const end = Math.min(d, S.view.end + span * 0.25);
  const count = clamp(Math.round((end - start) / perTile), 2, 96);
  const seq = ++detailSeq;
  const token = S.openToken;
  strip.classList.add('refining');
  try {
    const file = await invoke('filmstrip', { path: S.path, start, duration: end - start, count, height: 112 });
    const url = await invoke('media_url', { path: file });
    const img = new Image();
    img.src = url;
    await img.decode();
    if (seq !== detailSeq || token !== S.openToken) return;
    S.detail = { url, start, end, count };
    renderThumbs();
  } catch {
    // Keep the coarse strip.
  } finally {
    if (seq === detailSeq) strip.classList.remove('refining');
  }
}

async function loadWaveform(token) {
  try {
    const file = await invoke('waveform', { path: S.path, tracks: S.info.audioCount, width: 4000, height: 160 });
    if (!file || token !== S.openToken) return;
    S.wave = await invoke('media_url', { path: file });
    renderTimeline();
  } catch {
    // The waveform is a nice-to-have.
  }
}

// ---------------------------------------------------------------------------
// Video frame + zoom preview
// ---------------------------------------------------------------------------
const vframe = $('#vframe');
/** Size the frame to the video's shape so zooming can be clipped to it. */
function layoutFrame() {
  const stage = $('#stage');
  // Edge to edge: the video gets all the space between the header and the controls.
  const pad = 0;
  const W = stage.clientWidth - pad * 2;
  const H = stage.clientHeight - pad * 2;
  const vw = video.videoWidth || (S.info && S.info.width) || 16;
  const vh = video.videoHeight || (S.info && S.info.height) || 9;
  const scale = Math.min(W / vw, H / vh);
  // Whole device pixels: a frame at a fractional position is resampled again and comes out soft.
  const dpr = window.devicePixelRatio || 1;
  const snap = (v) => Math.round(v * dpr) / dpr;
  const w = snap(Math.max(0, vw * scale));
  const h = snap(Math.max(0, vh * scale));
  Object.assign(vframe.style, { width: `${w}px`, height: `${h}px`, left: `${snap((stage.clientWidth - w) / 2)}px`, top: `${snap((H - h) / 2 + pad)}px` });
  renderZoomBox();
}
new ResizeObserver(layoutFrame).observe($('#stage'));
// Display scaling changes (e.g. the window moves to a 150% monitor) need a fresh pixel snap.
(function watchDpr() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => { layoutFrame(); watchDpr(); }, { once: true });
})();
video.addEventListener('loadedmetadata', layoutFrame);

const selectedZoom = () => S.zooms.find((z) => z.id === S.selectedZoom) || null;
/** While aiming (Zoom tool, paused, a zoom selected) show the whole frame with the target box. */
const aiming = () => S.mode === 'edit' && S.tool === 'zoom' && !!selectedZoom() && video.paused;

let lastZoomCss = '';
function applyZoomPreview(t) {
  const z = aiming() ? { scale: 1, fx: 0.5, fy: 0.5 } : zoomAt(S.zooms, t);
  const css = z.scale > 1.0001 ? `${z.fx * 100}% ${z.fy * 100}%|scale(${z.scale})` : '';
  if (css === lastZoomCss) return;
  lastZoomCss = css;
  const [origin, transform] = css ? css.split('|') : ['50% 50%', 'none'];
  video.style.transformOrigin = origin;
  video.style.transform = transform;
}

function renderZoomBox() {
  const box = $('#zoom-box');
  const z = selectedZoom();
  const show = !!S.path && aiming();
  document.body.classList.toggle('aiming', show);
  box.hidden = !show;
  if (!show) return;
  const W = vframe.clientWidth;
  const H = vframe.clientHeight;
  const k = 1 / z.amount;
  // The visible area while zoomed: the anchor point stays fixed, everything scales around it.
  Object.assign(box.style, {
    left: `${z.fx * (1 - k) * W}px`, top: `${z.fy * (1 - k) * H}px`, width: `${k * W}px`, height: `${k * H}px`,
  });
  const a = box.querySelector('.anchor');
  a.style.left = `${z.fx * 100}%`;
  a.style.top = `${z.fy * 100}%`;
  $('#zoom-box-label').textContent = `${z.amount}×`;
}

/** Aim: center the zoom box on a point of the frame (fractions 0..1). */
function aimAt(z, cx, cy) {
  const k = 1 / z.amount;
  const toAnchor = (c) => (k >= 1 ? 0.5 : clamp((c - k / 2) / (1 - k), 0, 1));
  z.fx = toAnchor(cx);
  z.fy = toAnchor(cy);
}
vframe.addEventListener('pointerdown', (e) => {
  if (!aiming() || e.button !== 0) return;
  const z = selectedZoom();
  const r = vframe.getBoundingClientRect();
  const k = 1 / z.amount;
  const onBox = e.target.closest('#zoom-box');
  // Grab the box where it was clicked; a click outside it jumps the box there.
  const boxCx = z.fx * (1 - k) + k / 2;
  const boxCy = z.fy * (1 - k) + k / 2;
  const grabX = onBox ? (e.clientX - r.left) / r.width - boxCx : 0;
  const grabY = onBox ? (e.clientY - r.top) / r.height - boxCy : 0;
  const move = (ev) => {
    aimAt(z, (ev.clientX - r.left) / r.width - grabX, (ev.clientY - r.top) / r.height - grabY);
    renderZoomBox();
  };
  move(e);
  vframe.setPointerCapture(e.pointerId);
  const up = () => {
    vframe.removeEventListener('pointermove', move);
    vframe.removeEventListener('pointerup', up);
    updateExportInfo();
  };
  vframe.addEventListener('pointermove', move);
  vframe.addEventListener('pointerup', up);
});

function addZoomAtPlayhead() {
  if (!S.path) return;
  const t = clamp(currentT(), S.inT, S.outT);
  const len = Math.min(3, Math.max(0.5, (S.outT - S.inT) / 3));
  // Fit between neighbouring zooms.
  const prev = S.zooms.filter((z) => z.start <= t).pop();
  const next = S.zooms.find((z) => z.start > t);
  let start = Math.max(t, prev ? prev.end : 0);
  let end = Math.min(start + len, next ? next.start : duration(), duration());
  if (end - start < 0.3) {
    start = Math.max(prev ? prev.end : 0, end - len);
    if (end - start < 0.3) return toast('No room for another zoom here. Move or remove one first');
  }
  const z = { id: uid(), start, end, amount: 1.5, fx: 0.5, fy: 0.5, ease: 'smooth' };
  S.zooms.push(z);
  S.zooms.sort((a, b) => a.start - b.start);
  S.selectedZoom = z.id;
  video.pause();
  S.tool = 'zoom';
  seek(start + Math.min(zoomRamp(z), (end - start) / 2));
  syncAll();
}
function removeZoom(id) {
  S.zooms = S.zooms.filter((z) => z.id !== id);
  if (S.selectedZoom === id) S.selectedZoom = S.zooms[0]?.id ?? null;
  syncAll();
}

// ---------------------------------------------------------------------------
// Playback, seeking, frame stepping
// ---------------------------------------------------------------------------
let seekTarget = null;
let seeking = false;
let shownTime = 0;

function seek(t) {
  if (!S.path) return;
  cancelHold();
  t = clamp(t, 0, duration());
  shownTime = t;
  seekTarget = t;
  if (!seeking) flushSeek();
  stopAllSfx();
}
function flushSeek() {
  if (seekTarget == null) return;
  seeking = true;
  video.currentTime = seekTarget;
  seekTarget = null;
}
video.addEventListener('seeked', () => {
  seeking = false;
  flushSeek();
});
const currentT = () => (seeking || seekTarget != null ? shownTime : video.currentTime);

/** Preview a freeze: stop on its frame for the hold, then carry on. */
let holdTimer = null;
let resumingHold = false;
function startHold(f) {
  video.pause();
  video.currentTime = f.at + 0.5 / fps(); // not seek(): sound effects keep playing through a freeze
  S.holding = f.id;
  holdTimer = setTimeout(() => {
    holdTimer = null;
    S.holding = null;
    S.justHeld = f.id;
    resumingHold = true;
    video.play().catch(() => {});
  }, f.hold * 1000);
}
function cancelHold() {
  if (!S.holding) return;
  clearTimeout(holdTimer);
  holdTimer = null;
  S.holding = null;
  setPlayIcon('play');
  stopAllSfx();
}

function togglePlay() {
  if (!S.path) return;
  if (S.holding) return cancelHold();
  if (video.paused) {
    const t = currentT();
    if (S.mode === 'watch' && S.quick) {
      if (t < S.inT - 0.02 || t >= S.outT - 0.02) seek(S.inT);
    } else if (S.mode === 'watch') {
      const { a, b } = S.loop;
      if (a != null && b != null && (t < a - 0.02 || t >= b - 0.02)) seek(a);
      else if (t >= duration() - 0.05) seek(0);
    } else if (t >= S.outT - 0.02 || t < S.inT - 0.02) seek(S.inT);
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}
/** Watch mode: move exactly k frames. Lands mid-frame so the right frame always shows. */
function stepFrame(k) {
  if (!S.path) return;
  video.pause();
  const f = fps();
  const total = Math.max(1, Math.round(duration() * f));
  const n = clamp(Math.floor(currentT() * f + 1e-6) + k, 0, total - 1);
  seek((n + 0.5) / f);
}
function step(frames) {
  video.pause();
  seek(currentT() + frames / fps());
}
const setPlayIcon = (name) => $$('.play-btn use').forEach((u) => u.setAttribute('href', `#i-${name}`));
video.addEventListener('play', () => {
  renderZoomBox();
  setPlayIcon('pause');
  // Coming out of a freeze: sound effects kept playing through it, like in the export.
  if (resumingHold) resumingHold = false;
  else startSfxAt(currentT());
});
video.addEventListener('pause', () => {
  if (S.holding) return; // a freeze in the preview: still "playing"
  renderZoomBox();
  setPlayIcon('play');
  video.playbackRate = 1;
  stopAllSfx();
});

let lastT = 0;
let lastShown = -1;
function tick() {
  const t = currentT();
  if (S.path && !video.paused && S.mode === 'watch') {
    // Watch: raw playback at the chosen speed, looping A-B if set. No edits applied.
    if (video.playbackRate !== S.watchRate) video.playbackRate = S.watchRate;
    if (video.muted !== !!settings.muted) video.muted = !!settings.muted;
    const { a, b } = S.loop;
    if (S.quick) {
      if (t >= S.outT && lastT < S.outT) { video.pause(); seek(S.outT); }
    } else if (a != null && b != null && t >= b && seekTarget == null && !seeking) seek(a);
  } else if (S.path && !video.paused) {
    if (t >= S.outT && lastT < S.outT) {
      video.pause();
      seek(S.outT);
    }
    // Slow-mo preview
    const inSlow = S.slow.enabled && t >= S.slow.start && t < S.slow.end;
    const rate = inSlow ? S.slow.speed : 1;
    if (video.playbackRate !== rate) video.playbackRate = rate;
    video.muted = !!settings.muted || (inSlow && S.slow.muteAudio);
    // Sound effects the playhead just crossed
    for (const s of S.sfx) {
      if (s.at > lastT && s.at <= t && t - s.at < 0.3) playSfx(s, 0);
    }
    // Freeze frames the playhead just reached
    const jh = S.justHeld && S.freezes.find((f) => f.id === S.justHeld);
    if (S.justHeld && (!jh || t > jh.at + 0.25 || t < jh.at - 0.01)) S.justHeld = null;
    const fz = S.freezes.find((f) => f.id !== S.justHeld && f.at >= lastT - 1e-6 && f.at < t && t - f.at < 0.5 && f.at >= S.inT);
    if (fz) startHold(fz);
    // Keep the playhead in view when zoomed
    const span = S.view.end - S.view.start;
    if (span < duration() && (t > S.view.end || t < S.view.start)) setView(t - span * 0.1, t + span * 0.9);
  }
  lastT = t;
  if (S.path) S.mode === 'edit' ? applyZoomPreview(t) : applyMagnify();
  if (S.path && S.mode === 'watch' && t !== lastWatchT) renderWatchTime(t);
  if (t !== lastShown) {
    lastShown = t;
    $('#time-current').textContent = fmt(t);
    $('#tl-playhead').style.left = `${tToX(t)}px`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/** Player volume (and mute) apply in both modes; in Edit the clip's own volume scales it too. */
function applyPreviewVolume() {
  const clip = S.mode === 'edit' ? Math.min(1, S.origVolume) : 1;
  video.volume = clamp(settings.previewVolume * clip, 0, 1);
  video.muted = !!settings.muted;
  const quiet = settings.muted || settings.previewVolume < 0.001;
  $('#w-mute use').setAttribute('href', quiet ? '#i-mute' : '#i-volume');
  $('#w-mute').title = quiet ? 'Unmute (M)' : 'Mute (M) · ↑ ↓ change the volume';
  if (document.activeElement !== $('#w-volume')) $('#w-volume').value = settings.muted ? 0 : settings.previewVolume;
}
function setVolume(v) {
  settings.previewVolume = Math.round(clamp(v, 0, 1) * 100) / 100;
  settings.muted = settings.previewVolume < 0.001;
  saveSettings();
  applyPreviewVolume();
}
function toggleMute() {
  if (settings.muted && settings.previewVolume < 0.001) settings.previewVolume = 1;
  settings.muted = !settings.muted;
  saveSettings();
  applyPreviewVolume();
  toast(settings.muted ? 'Muted' : `Volume ${Math.round(settings.previewVolume * 100)}%`, 900);
}
$('#w-mute').addEventListener('click', toggleMute);
$('#w-volume').addEventListener('input', (e) => setVolume(Number(e.target.value)));
$('#w-volume').addEventListener('change', (e) => e.target.blur()); // arrow keys go back to frame stepping

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------
const sfxAudio = new Map(); // sfx id -> HTMLAudioElement
const urlCache = new Map(); // file path -> media URL
async function mediaUrl(path) {
  if (!urlCache.has(path)) urlCache.set(path, await invoke('media_url', { path }));
  return urlCache.get(path);
}
async function audioFor(s) {
  let el = sfxAudio.get(s.id);
  if (!el) {
    el = new Audio(await mediaUrl(s.path));
    el.preload = 'auto';
    sfxAudio.set(s.id, el);
    el.addEventListener('loadedmetadata', () => {
      s.duration = el.duration;
      renderTimeline();
    });
  }
  return el;
}
async function playSfx(s, offset) {
  const el = await audioFor(s);
  el.volume = clamp(s.volume * settings.previewVolume, 0, 1);
  el.currentTime = offset;
  el.play().catch(() => {});
}
function startSfxAt(t) {
  for (const s of S.sfx) if (s.duration && t > s.at && t < s.at + s.duration) playSfx(s, t - s.at);
}
let previewEl = null;
function stopAllSfx() {
  for (const el of sfxAudio.values()) el.pause();
  if (previewEl) previewEl.pause();
}
async function previewLibrarySound(item) {
  if (!previewEl) previewEl = new Audio();
  const url = await mediaUrl(item.path);
  if (previewEl.src === url && !previewEl.paused) return previewEl.pause();
  previewEl.src = url;
  previewEl.volume = settings.previewVolume;
  previewEl.play().catch(() => toast("Can't play that sound file"));
}

function placeSound(item, at = currentT()) {
  if (!S.path) return toast('Open a video first');
  const s = { id: uid(), path: item.path, name: item.name, at: clamp(at, 0, duration()), volume: 1, duration: 0 };
  S.sfx.push(s);
  S.selectedSfx = s.id;
  audioFor(s);
  syncAll();
}
function removeSfx(id) {
  const el = sfxAudio.get(id);
  if (el) el.pause();
  sfxAudio.delete(id);
  S.sfx = S.sfx.filter((s) => s.id !== id);
  if (S.selectedSfx === id) S.selectedSfx = null;
  syncAll();
}

function addToLibrary(paths) {
  let added = 0;
  for (const p of paths) {
    if (library.some((l) => l.path === p)) continue;
    library.push({ id: uid(), name: stemOf(p), path: p });
    added++;
  }
  saveLibrary();
  if (added && S.tool !== 'sound') toast(`Added ${added} sound${added > 1 ? 's' : ''}. Press 1–9 to drop one at the playhead`);
}

function openSfxItem(s) {
  S.selectedSfx = s.id;
  if (S.tool !== 'sound') setTool('sound');
  else syncAll();
}

// ---------------------------------------------------------------------------
// Timeline geometry + rendering
// ---------------------------------------------------------------------------
const tToX = (t) => ((t - S.view.start) / (S.view.end - S.view.start || 1)) * strip.clientWidth;
const xToT = (x) => S.view.start + (x / (strip.clientWidth || 1)) * (S.view.end - S.view.start);

// Narrowest view: about 8 frames across the whole timeline.
const minSpan = () => Math.min(duration(), Math.max(0.12, 8 / fps()));
const isZoomed = () => S.view.end - S.view.start < duration() - 1e-6;

function setView(start, end) {
  const d = duration();
  const span = clamp(end - start, minSpan(), d);
  start = clamp(start, 0, d - span);
  S.view = { start, end: start + span };
  renderTimeline();
  requestDetail();
}
/** Keep the playhead where it is on screen if it's visible, else zoom around the middle. */
function zoomAnchor() {
  const t = currentT();
  return t >= S.view.start && t <= S.view.end ? t : (S.view.start + S.view.end) / 2;
}
function zoomToSpan(span, anchorT = zoomAnchor()) {
  const { start, end } = S.view;
  const rel = end > start ? (anchorT - start) / (end - start) : 0.5;
  span = clamp(span, minSpan(), duration());
  setView(anchorT - rel * span, anchorT - rel * span + span);
}
function zoomToSelection() {
  if (!S.path) return;
  const pad = Math.max((S.outT - S.inT) * 0.06, 2 / fps());
  setView(S.inT - pad, S.outT + pad);
}
// The zoom slider is logarithmic: equal steps feel equal at any zoom level.
const spanToSlider = (span) => {
  const d = duration();
  const m = minSpan();
  return d > m ? Math.round((Math.log(span / d) / Math.log(m / d)) * 1000) : 0;
};
const sliderToSpan = (v) => duration() * (minSpan() / duration()) ** (v / 1000);
function zoom(factor, anchorT = zoomAnchor()) {
  const { start, end } = S.view;
  const span = end - start;
  const rel = span ? (anchorT - start) / span : 0.5;
  const ns = span * factor;
  setView(anchorT - rel * ns, anchorT - rel * ns + ns);
}

const slowActive = () =>
  S.slow.enabled && Math.abs(S.slow.speed - 1) > 1e-6 && Math.min(S.slow.end, S.outT) - Math.max(S.slow.start, S.inT) > 0.01;

function renderTimeline() {
  const w = strip.clientWidth;
  const has = !!S.path;
  const xi = has ? tToX(S.inT) : 0;
  const xo = has ? tToX(S.outT) : w;
  const place = (el, left, width) => {
    el.style.left = `${left}px`;
    if (width != null) el.style.width = `${Math.max(0, width)}px`;
  };
  place($('#tl-dim-left'), 0, clamp(xi, 0, w));
  place($('#tl-dim-right'), clamp(xo, 0, w), w - clamp(xo, 0, w));
  place($('#tl-trim'), xi, xo - xi);
  place($('#tl-handle-in'), xi);
  place($('#tl-handle-out'), xo);
  for (const id of ['#tl-handle-in', '#tl-handle-out', '#tl-trim', '#tl-playhead']) $(id).hidden = !has;

  // Effects lane: slow motion as a clip bar (+ a tint on the video clip)
  const slowEl = $('#tl-slow');
  const tint = $('#tl-slow-tint');
  slowEl.hidden = tint.hidden = !(has && S.slow.enabled && S.slow.end > S.slow.start);
  if (!slowEl.hidden) {
    const x0 = tToX(S.slow.start);
    const x1 = tToX(S.slow.end);
    place(slowEl, x0, x1 - x0);
    place(tint, x0, x1 - x0);
    const speed = `${fmtSpeed(S.slow.speed)}×`;
    const fast = S.slow.speed > 1;
    slowEl.classList.toggle('fast', fast);
    tint.classList.toggle('fast', fast);
    slowEl.querySelector('span').textContent = x1 - x0 > 170 ? `${fast ? 'Speed-up' : 'Slow motion'} · ${speed}` : speed;
  }

  const kf = $('#tl-keyframe');
  const showKf = has && !S.exact && !canExactCopy(S.info) && !slowActive() && S.keyframeIn != null && S.keyframeFor === S.inT && S.inT - S.keyframeIn > 0.0005;
  kf.hidden = !showKf;
  if (showKf) place(kf, tToX(S.keyframeIn));

  // Zoom clips
  const zBox = $('#tl-zooms');
  zBox.innerHTML = '';
  $('#lane-zoom').classList.toggle('has', has && (S.zooms.length > 0 || S.tool === 'zoom'));
  for (const z of S.zooms) {
    const x0 = tToX(z.start);
    const x1 = tToX(z.end);
    const m = document.createElement('div');
    m.className = 'zoom-clip' + (z.id === S.selectedZoom ? ' selected' : '');
    m.dataset.id = z.id;
    m.title = `Zoom ${z.amount}× from ${fmt(z.start)} to ${fmt(z.end)}. Drag to move, drag the ends to resize`;
    const ramp = Math.max(0, tToX(z.start + zoomRamp(z)) - x0);
    m.innerHTML = `<i class="ramp in" style="width:${ramp}px"></i><i class="ramp out" style="width:${ramp}px"></i>${icon('zoomfx')}<span>${x1 - x0 > 90 ? `Zoom ${z.amount}×` : `${z.amount}×`}</span>`;
    place(m, x0, x1 - x0);
    zBox.appendChild(m);
  }

  // Sound-effect clips
  const sfxBox = $('#tl-sfx');
  sfxBox.innerHTML = '';
  $('#lane-sfx').classList.toggle('has', has && S.sfx.length > 0);
  for (const s of S.sfx) {
    const m = document.createElement('div');
    m.className = 'sfx-marker' + (s.id === S.selectedSfx ? ' selected' : '');
    m.dataset.id = s.id;
    m.innerHTML = `${icon('sound')}<span></span>`;
    m.lastChild.textContent = s.name;
    m.title = `${s.name} at ${fmt(s.at)}. Drag to move, click for volume`;
    const width = s.duration ? tToX(s.at + s.duration) - tToX(s.at) : 40;
    place(m, tToX(s.at), Math.max(18, width));
    sfxBox.appendChild(m);
  }

  // Freeze frames: a marker on the held frame (the hold adds time, so it has no width here)
  const fzBox = $('#tl-freezes');
  fzBox.innerHTML = '';
  for (const f of S.freezes) {
    const m = document.createElement('div');
    m.className = 'freeze-clip' + (f.id === S.selectedFreeze ? ' selected' : '');
    m.dataset.id = f.id;
    m.title = `Holds the frame at ${fmt(f.at)} for ${fmtSpeed(f.hold)}s, then carries on. Drag to move`;
    m.innerHTML = `${icon('freeze')}<span>${fmtSpeed(f.hold)}s</span>`;
    place(m, tToX(f.at));
    fzBox.appendChild(m);
  }

  // Audio lane: the video's own sound, waveform scaled by its volume
  const audio = $('#tl-audio');
  const hasAudio = has && S.info.audioCount > 0;
  audio.classList.toggle('none', has && !hasAudio);
  audio.classList.toggle('boost', hasAudio && S.origVolume > 1.001);
  audio.classList.toggle('muted', hasAudio && S.origVolume < 0.001);
  $('#tl-audio-label').textContent = !has ? '' : !hasAudio ? 'No sound in this video'
    : `Video sound${Math.abs(S.origVolume - 1) > 1e-6 ? ` · ${Math.round(S.origVolume * 100)}%` : ''}`;
  // Keep the label inside the part that gets exported.
  $('#lane-audio .clip-label').style.left = `${clamp(xi + 18, 8, Math.max(8, w - 160))}px`;
  const img = $('#tl-wave-img');
  img.hidden = !(hasAudio && S.wave);
  if (!img.hidden) {
    img.style.width = `${(w * duration()) / (S.view.end - S.view.start || 1)}px`;
    img.style.left = `${tToX(0)}px`;
    img.style.webkitMaskImage = img.style.maskImage = `url('${S.wave}')`;
    img.style.transform = `scaleY(${clamp(S.origVolume / 2, 0.02, 1)})`;
  }

  if (has) {
    const span = S.view.end - S.view.start;
    if (document.activeElement !== $('#zoom-slider')) $('#zoom-slider').value = spanToSlider(span);
    $('#zoom-fit').disabled = $('#zoom-out').disabled = !isZoomed();
    $('#zoom-in').disabled = span <= minSpan() + 1e-6;
  }
  $('#tl-playhead').style.left = `${tToX(currentT())}px`;
  renderRuler();
  renderScroll();
  renderThumbs();
}

// Ruler: labelled ticks with dots in between
function renderRuler() {
  const box = $('#tl-ticks');
  const w = strip.clientWidth;
  const span = S.view.end - S.view.start;
  if (!S.path || !w || !span) return (box.innerHTML = '');
  const f = 1 / fps();
  const steps = [f, 2 * f, 5 * f, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
    .filter((v, i, a) => i === 0 || v > a[i - 1] + 1e-9);
  const step = steps.find((st) => (st / span) * w >= 90) || 3600;
  const dots = step >= 1 && step <= 2 ? step * 4 : 4;
  const first = Math.floor(S.view.start / step) * step;
  let html = '';
  for (let t = first; t <= S.view.end + step; t += step) {
    const x = tToX(t);
    if (x >= -20 && x <= w + 20) {
      const label = step < 0.1 ? fmt(t) : step < 1 ? fmt(t).replace(/(\.\d)\d$/, '$1') : formatTime(t, false);
      // Keep edge labels fully inside the ruler.
      const pos = x < 24 ? `left:${Math.max(0, x)}px;transform:none` : x > w - 24 ? `left:${Math.min(w, x)}px;transform:translateX(-100%)` : `left:${x}px`;
      if (x >= 0 && x <= w) html += `<span class="tick" style="${pos}">${label}</span>`;
    }
    for (let k = 1; k < dots; k++) {
      const xd = tToX(t + (step * k) / dots);
      // No dots right next to a label.
      const gap = Math.min(xd - x, tToX(t + step) - xd);
      if (xd > 0 && xd < w && gap > 24) html += `<i class="tdot" style="left:${xd}px"></i>`;
    }
  }
  box.innerHTML = html;
}

// Scroll bar: shows (and moves) the visible part of the timeline
function renderScroll() {
  const d = duration();
  const thumb = $('#tl-thumb');
  const w = $('#tl-scroll').clientWidth;
  if (!S.path || !d) return (thumb.hidden = true);
  thumb.hidden = false;
  thumb.style.left = `${(S.view.start / d) * w}px`;
  thumb.style.width = `${Math.max(24, ((S.view.end - S.view.start) / d) * w)}px`;
}
new ResizeObserver(() => renderTimeline()).observe(strip);

// Bubble showing the time under a handle while dragging
function bubble(t) {
  const b = $('#tl-bubble');
  if (t == null) return (b.hidden = true);
  $('#tl-hover').hidden = true;
  b.hidden = false;
  b.textContent = drag && drag.fine ? `${fmt(t)} · fine` : fmt(t);
  placeTip(b, tToX(t), strip.clientWidth);
}

// ---------------------------------------------------------------------------
// Timeline interaction
// ---------------------------------------------------------------------------
let drag = null;
track.addEventListener('pointerdown', (e) => {
  if (!S.path || e.button !== 0 || e.target.closest('.tl-head')) return;
  const rect = strip.getBoundingClientRect();
  const t = clamp(xToT(e.clientX - rect.left), 0, duration());
  const tgt = e.target;
  let mode = 'scrub';
  let ref = null;
  const sfxEl = tgt.closest('.sfx-marker');
  const fzEl = tgt.closest('.freeze-clip');
  if (tgt.closest('#tl-handle-in')) mode = 'in';
  else if (tgt.closest('#tl-handle-out')) mode = 'out';
  else if (fzEl) {
    mode = 'freeze';
    ref = S.freezes.find((f) => f.id === fzEl.dataset.id);
    if (ref) S.selectedFreeze = ref.id;
  } else if (sfxEl) {
    mode = 'sfx';
    ref = S.sfx.find((s) => s.id === sfxEl.dataset.id);
  } else if (tgt.closest('.zoom-clip')) {
    const el = tgt.closest('.zoom-clip');
    ref = S.zooms.find((z) => z.id === el.dataset.id);
    const zr = el.getBoundingClientRect();
    const ox = e.clientX - zr.left;
    mode = ox < 8 ? 'zoom-start' : ox > zr.width - 8 ? 'zoom-end' : 'zoom-move';
    S.selectedZoom = ref.id;
  } else if (tgt.closest('#tl-audio')) {
    mode = 'audio';
  } else if (tgt.closest('#tl-slow')) {
    const sr = $('#tl-slow').getBoundingClientRect();
    const ox = e.clientX - sr.left;
    mode = ox < 8 ? 'slow-start' : ox > sr.width - 8 ? 'slow-end' : 'slow-move';
  }
  drag = {
    mode, ref, t0: t, x0: e.clientX, lastX: e.clientX, acc: 0, fine: false, moved: false, edgeRaf: 0,
    in0: S.inT, out0: S.outT,
    at0: mode === 'sfx' && ref ? ref.at : 0, fz0: mode === 'freeze' && ref ? ref.at : 0,
    s0: S.slow.start, e0: S.slow.end,
    zs0: mode.startsWith('zoom') && ref ? ref.start : 0, ze0: mode.startsWith('zoom') && ref ? ref.end : 0,
  };
  if (mode === 'in' || mode === 'out') $(`#tl-handle-${mode}`).classList.add('active');
  if (['scrub', 'in', 'out', 'freeze'].includes(mode)) video.pause();
  track.setPointerCapture(e.pointerId);
  if (mode === 'scrub') seek(t);
});
track.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
  const dx = e.clientX - drag.lastX;
  drag.lastX = e.clientX;
  if (!drag.moved) return;
  // Move by how far the pointer moved, so Shift can slow it down 10× for fine adjustment.
  drag.fine = e.shiftKey;
  drag.acc += pxToT(dx) * (e.shiftKey ? 0.1 : 1);
  applyDrag();
  if (!drag.edgeRaf) drag.edgeRaf = requestAnimationFrame(edgeScroll);
});
const pxToT = (px) => (px / (strip.clientWidth || 1)) * (S.view.end - S.view.start);
const snapFrame = (t) => Math.round(t * fps()) / fps();

// Dragging something against the edge of a zoomed timeline scrolls it along.
function edgeScroll() {
  if (!drag) return;
  drag.edgeRaf = 0;
  if (drag.mode === 'scrub' || drag.mode === 'audio' || !isZoomed()) return;
  const rect = strip.getBoundingClientRect();
  const x = drag.lastX - rect.left;
  const dir = x < 28 ? -1 : x > rect.width - 28 ? 1 : 0;
  if (!dir) return;
  const before = S.view.start;
  const step = (S.view.end - S.view.start) * 0.012 * dir;
  setView(S.view.start + step, S.view.end + step);
  const moved = S.view.start - before;
  if (moved) {
    drag.acc += moved;
    applyDrag();
  }
  drag.edgeRaf = requestAnimationFrame(edgeScroll);
}
track.addEventListener('pointerup', (e) => {
  if (!drag) return;
  track.releasePointerCapture(e.pointerId);
  if (drag.edgeRaf) cancelAnimationFrame(drag.edgeRaf);
  const { mode, moved, ref } = drag;
  drag = null;
  bubble(null);
  $$('.tl-handle').forEach((h) => h.classList.remove('active'));
  if (!moved) {
    // Plain clicks open the matching tool.
    if (mode === 'sfx' && ref) openSfxItem(ref);
    else if (mode === 'freeze' && ref) {
      S.tool = 'freeze';
      seek(ref.at + 0.5 / fps());
      syncAll();
    }
    else if (mode.startsWith('zoom')) {
      S.tool = 'zoom';
      video.pause();
      seek(clamp(xToT(e.clientX - strip.getBoundingClientRect().left), ref.start, ref.end));
      syncAll();
    }
    else if (mode.startsWith('slow')) setTool('slow');
    else if (mode === 'audio') {
      if (S.info.audioCount > 0) setTool('amp');
      seek(xToT(e.clientX - strip.getBoundingClientRect().left));
    }
    else if (mode === 'in' || mode === 'out') {
      setTool('trim');
      seek(mode === 'in' ? S.inT : S.outT);
    }
    return;
  }
  if (mode === 'in' || mode === 'out') requestKeyframe();
  syncAll();
});

function applyDrag() {
  const rect = strip.getBoundingClientRect();
  const d = duration();
  const dt = drag.acc;
  const minLen = Math.max(1 / fps(), 0.05);
  switch (drag.mode) {
    case 'scrub':
    case 'audio':
      seek(clamp(xToT(drag.lastX - rect.left), 0, d));
      break;
    case 'in':
      S.inT = clamp(snapFrame(drag.in0 + dt), 0, S.outT - minLen);
      seek(S.inT);
      bubble(S.inT);
      break;
    case 'out':
      S.outT = clamp(snapFrame(drag.out0 + dt), S.inT + minLen, d);
      seek(S.outT);
      bubble(S.outT);
      break;
    case 'freeze':
      if (drag.ref) {
        drag.ref.at = clamp(Math.floor((drag.fz0 + dt) * fps() + 1e-6) / fps(), S.inT, Math.max(S.inT, S.outT - 1 / fps()));
        seek(drag.ref.at + 0.5 / fps()); // show the exact frame being held
        bubble(drag.ref.at);
      }
      break;
    case 'sfx':
      if (drag.ref) {
        drag.ref.at = clamp(drag.at0 + dt, 0, d);
        bubble(drag.ref.at);
      }
      break;
    case 'zoom-start':
    case 'zoom-end':
    case 'zoom-move': {
      // Zooms can't overlap each other.
      const z = drag.ref;
      const i = S.zooms.indexOf(z);
      const lo = i > 0 ? S.zooms[i - 1].end : 0;
      const hi = i < S.zooms.length - 1 ? S.zooms[i + 1].start : d;
      if (drag.mode === 'zoom-start') z.start = clamp(snapFrame(drag.zs0 + dt), lo, z.end - 0.3);
      else if (drag.mode === 'zoom-end') z.end = clamp(snapFrame(drag.ze0 + dt), z.start + 0.3, hi);
      else {
        const len = drag.ze0 - drag.zs0;
        z.start = clamp(snapFrame(drag.zs0 + dt), lo, hi - len);
        z.end = z.start + len;
      }
      bubble(drag.mode === 'zoom-end' ? z.end : z.start);
      break;
    }
    case 'slow-start':
      S.slow.start = clamp(snapFrame(drag.s0 + dt), 0, S.slow.end - 0.05);
      bubble(S.slow.start);
      break;
    case 'slow-end':
      S.slow.end = clamp(snapFrame(drag.e0 + dt), S.slow.start + 0.05, d);
      bubble(S.slow.end);
      break;
    case 'slow-move': {
      const w = drag.e0 - drag.s0;
      S.slow.start = clamp(drag.s0 + dt, 0, d - w);
      S.slow.end = S.slow.start + w;
      bubble(S.slow.start);
      break;
    }
  }
  renderTimeline();
}

$('#tl').addEventListener(
  'wheel',
  (e) => {
    if (!S.path || e.target.closest('.tl-head')) return;
    e.preventDefault();
    const rect = strip.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const span = S.view.end - S.view.start;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const delta = ((e.deltaX || e.deltaY) / rect.width) * span;
      setView(S.view.start + delta, S.view.end + delta);
    } else {
      zoom(Math.exp(e.deltaY * 0.0015), xToT(x));
    }
  },
  { passive: false },
);
$('#zoom-fit').addEventListener('click', () => setView(0, duration()));
$('#zoom-sel').addEventListener('click', zoomToSelection);
$('#zoom-in').addEventListener('click', () => zoom(0.5));
$('#zoom-out').addEventListener('click', () => zoom(2));
$('#zoom-slider').addEventListener('input', (e) => zoomToSpan(sliderToSpan(Number(e.target.value))));

// Trim tool: type exact start / end times.
function bindTimeField(el, apply) {
  const commit = () => {
    const t = parseTime(el.value);
    if (isFinite(t)) apply(t);
    else syncAll();
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') el.blur();
    if (e.key === 'Escape') { el.value = ''; el.blur(); syncAll(); }
  });
}

// ---------------------------------------------------------------------------
// Trim, slow-mo, keyframes
// ---------------------------------------------------------------------------
function setIn(t) {
  if (!S.path) return;
  // Start at the beginning of the frame on screen (Watch steps land mid-frame).
  t = Math.floor(t * fps() + 1e-6) / fps();
  S.inT = clamp(t, 0, duration());
  if (S.inT >= S.outT) S.outT = duration();
  afterTrimChange();
}
function setOut(t) {
  if (!S.path) return;
  S.outT = clamp(t, 0, duration());
  if (S.outT <= S.inT) S.inT = 0;
  afterTrimChange();
}
function afterTrimChange() {
  requestKeyframe();
  syncAll();
}

let kfTimer = null;
let kfSeq = 0;
function requestKeyframe() {
  clearTimeout(kfTimer);
  kfTimer = setTimeout(() => ensureKeyframe().catch(() => {}), 120);
}
async function ensureKeyframe() {
  if (!S.path) return null;
  if (S.keyframeFor === S.inT && S.keyframeIn != null) return S.keyframeIn;
  const seq = ++kfSeq;
  const { inT, path } = S;
  const kfs = await invoke('keyframes_near', { path, t: inT, start: S.info.start });
  const k = snapToKeyframe(kfs, inT);
  if (seq === kfSeq && path === S.path && inT === S.inT) {
    S.keyframeIn = k;
    S.keyframeFor = inT;
    syncAll();
  }
  return k;
}

function addSlowAtPlayhead() {
  if (!S.path) return;
  const t = currentT();
  const half = Math.min(1, (S.outT - S.inT) / 4);
  S.slow.enabled = true;
  S.slow.start = clamp(t - half, S.inT, S.outT - 0.1);
  S.slow.end = clamp(S.slow.start + half * 2, S.slow.start + 0.1, S.outT);
  S.tool = 'slow';
  syncAll();
}

// ---------------------------------------------------------------------------
function syncAll() {
  const has = !!S.path;
  document.body.classList.toggle('empty', !has);
  document.body.classList.toggle('mode-watch', S.mode === 'watch');
  document.body.classList.toggle('mode-edit', S.mode === 'edit');
  // Watching a preview copy (format the webview can't decode)? Say so; exports still use the original.
  $('#w-proxy').hidden = $('#e-proxy').hidden = !(has && S.usingProxy);
  for (const id of ['#w-play', '#w-prev-frame', '#w-next-frame', '#w-back5', '#w-fwd5', '#w-back10', '#w-fwd10', '#w-split']) $(id).disabled = !has;
  renderWatch();
  for (const id of ['#btn-play', '#btn-to-start', '#btn-back10', '#btn-back5', '#btn-fwd5', '#btn-fwd10', '#btn-export']) $(id).disabled = !has || (id === '#btn-export' && S.busy === 'export');

  // Rows (controls next to each lane) + the export sheet
  $$('.opt').forEach((o) => o.classList.toggle('active', o.dataset.for === S.tool));
  renderZoomBox();
  lastZoomCss = '!';
  renderRows();
  // Export
  $('#exact').checked = S.exact;
  // MP4/MOV-friendly files always start on the exact frame, losslessly: nothing to choose.
  $('#exact').closest('label').hidden = has && canExactCopy(S.info);
  $('#set-quality').value = settings.quality;
  $('#set-encoder').value = settings.encoder;
  applyPreviewVolume();
  renderTimeline();
  updateExportInfo();
}

function currentEdit() {
  return {
    inT: S.inT,
    outT: S.outT,
    exact: S.exact,
    keyframeIn: S.keyframeFor === S.inT ? S.keyframeIn : S.inT,
    slow: { ...S.slow },
    sfx: S.sfx.map((s) => ({ path: s.path, at: s.at, volume: s.volume })),
    zooms: S.zooms.map(({ start, end, amount, fx, fy, ease }) => ({ start, end, amount, fx, fy, ease })),
    freezes: S.freezes.map(({ at, hold }) => ({ at, hold })),
    origVolume: S.origVolume,
  };
}

function updateExportInfo() {
  if (!S.path) return;
  const plan = planExport(S.info, currentEdit());
  const nParts = 1;
  renderSave(plan.ext, nParts);

  const modeEl = $('#export-mode');
  modeEl.className = plan.mode === 'reencode' ? 'reencode' : '';
  modeEl.innerHTML = '<span class="dot"></span>';
  modeEl.append(
    plan.mode === 'copy' ? 'Lossless: original quality, bit for bit'
      : plan.mode === 'copy-video' ? 'Lossless video, sound remixed'
        : `Re-encoded for ${plan.reasons.join(' and ') || 'this edit'}, visually lossless`,
  );

  const lines = [];
  if (plan.mode === 'reencode') {
    const enc = pickEncoder(S.info, S.encoders, settings.encoder);
    lines.push(`Uses your ${enc.vendor === 'cpu' ? 'processor' : VENDOR_LABEL[enc.vendor]}.`);
  } else if (S.keyframeFor !== S.inT && !canExactCopy(S.info)) {
    lines.push('Finding the nearest keyframe…');
  } else if (plan.snapDelta > 0.0005) {
    lines.push(`Starts ${plan.snapDelta.toFixed(2)}s early, at the nearest keyframe. "Exact start frame" under Advanced avoids that.`);
  }
  if (plan.mergesTracks) lines.push(`The ${S.info.audioCount} audio tracks are mixed into one.`);
  lines.push(nParts > 1 ? `${nParts} videos, ${fmt(plan.outDuration)} in total.` : `${fmt(plan.outDuration)} long.`);
  $('#export-detail').textContent = lines.join(' ');
}

// ---------------------------------------------------------------------------
// Save options
// ---------------------------------------------------------------------------
const cleanName = (n) => n.replace(/[\\/:*?"<>|]/g, '_');
const defaultSaveName = () => (S.path ? stemOf(S.path) + (settings.suffix || '') : '');
const saveMode = () => S.save.mode;

/** Name for output #part (0 = single file). */
function saveName(part = 0, pad = 1) {
  let base = cleanName(S.save.name.trim()) || defaultSaveName();
  if (!part) return base;
  if (!S.save.nameEdited) base = stemOf(S.path); // "clip_part1", not "clip_edit_part1"
  return `${base}_part${String(part).padStart(pad, '0')}`;
}

let savePreviewSeq = 0;
function renderSave(ext, nParts) {
  const mode = saveMode();
  $$('#save-seg button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  });
  $('#save-new').hidden = mode !== 'new';
  $('#save-safe').hidden = mode !== 'new';
  $('#save-replace').hidden = mode !== 'replace';
  // One button: "Export" opens the options; in the Export tool it saves.
  const btn = $('#btn-export');
  const inExport = S.tool === 'export';
  btn.classList.toggle('replace', inExport && mode === 'replace');
  btn.classList.toggle('confirm', S.confirmReplace);
  $('#btn-export-label').textContent = !inExport ? 'Export'
    : S.busy === 'export' ? 'Saving…'
      : S.confirmReplace ? 'Click to confirm'
        : mode === 'replace' ? 'Replace original' : nParts > 1 ? `Save ${nParts} videos` : 'Save video';
  btn.title = !inExport ? 'Choose how to save (Ctrl+S saves right away)' : '';

  if (document.activeElement !== $('#save-name')) $('#save-name').value = S.save.name;
  $('#save-ext').textContent = nParts > 1 ? `_part1–${nParts}.${ext}` : `.${ext}`;
  $('#save-folder').textContent = settings.outDir || dirname(S.path);
  $('#save-folder-change').title = `${settings.outDir || dirname(S.path)}\nClick to choose another folder`;
  $('#save-folder-reset').hidden = !settings.outDir;
  $('#replace-name').textContent = basename(S.path);

  // Show the real name if that file already exists (we never overwrite).
  const seq = ++savePreviewSeq;
  const name = saveName(nParts > 1 ? 1 : 0, String(nParts).length);
  invoke('output_path', { src: S.path, ext, name, dir: settings.outDir || null }).then((p) => {
    if (seq !== savePreviewSeq) return;
    const wanted = `${name}.${ext}`;
    $('#save-note').textContent = basename(p) !== wanted ? `${wanted} exists already, so this saves as ${basename(p)}` : '';
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
T.event.listen('ffmpeg-progress', (e) => {
  const { ratio, speed } = e.payload;
  if (S.busy === 'export' && S.quick) {
    $('#w-trim-save').textContent = `Saving… ${Math.round(ratio * 100)}%`;
  } else if (S.busy === 'export') {
    // Map this ffmpeg run's progress onto the whole (multi-part) export.
    const p = S.progress || { base: 0, weight: 1, label: '' };
    const overall = clamp(p.base + ratio * p.weight, 0, 1);
    $('#export-bar').style.width = `${(overall * 100).toFixed(1)}%`;
    $('#export-status').textContent = `${p.label}${Math.round(overall * 100)}%${speed && speed !== 'N/A' ? ` · ${speed}` : ''}`;
  } else if (S.busy === 'split') {
    const p = S.progress || { base: 0, weight: 1, label: '' };
    const overall = clamp(p.base + ratio * p.weight, 0, 1);
    $('#split-bar').style.width = `${(overall * 100).toFixed(1)}%`;
    $('#split-status').textContent = `${p.label}${Math.round(overall * 100)}%`;
  } else if (S.busy === 'proxy') {
    $('#overlay-bar').style.width = `${(ratio * 100).toFixed(1)}%`;
  }
});

const cancelJob = () => invoke('cancel_ffmpeg');

let confirmTimer;
/** The Export button: first click shows the save options, the next one saves. */
function onExportButton() {
  if (!S.path || S.busy) return;
  if (S.tool !== 'export') {
    $('#export-result').hidden = true;
    return setTool('export');
  }
  doExport();
}

async function doExport() {
  if (!S.path || S.busy) return;
  if (S.outT - S.inT < 0.05) return toast('The selection is too short');
  if (S.tool !== 'export') {
    S.tool = 'export';
    syncAll();
  }
  video.pause();
  const replacing = saveMode() === 'replace';
  if (replacing && !S.confirmReplace) {
    // Replacing is the one destructive action: ask for a second click, inline.
    S.confirmReplace = true;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => { S.confirmReplace = false; updateExportInfo(); }, 6000);
    updateExportInfo();
    return;
  }
  S.confirmReplace = false;
  clearTimeout(confirmTimer);
  const source = S.path;
  const startedAt = performance.now();
  const result = $('#export-result');
  result.hidden = true;

  S.busy = 'export';
  S.progress = null;
  $('#export-progress').hidden = false;
  $('#export-bar').style.width = '0%';
  $('#export-status').textContent = 'Starting…';
  syncAll();

  const saved = [];
  let current = null;
  let total = 1;
  try {
    const base = currentEdit();
    if (planExport(S.info, base).mode !== 'reencode') base.keyframeIn = await ensureKeyframe();
    else if (S.encodersReady) await S.encodersReady;
    const edits = [base];
    total = edits.length;
    const plans = edits.map((e) => planExport(S.info, e));
    const totalDur = plans.reduce((a, p) => a + p.outDuration, 0) || 1;
    const pad = String(total).length;

    let done = 0;
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const outputPath = replacing
        ? await invoke('temp_output_path', { src: source, ext: plan.ext })
        : await invoke('output_path', { src: source, ext: plan.ext, name: saveName(total > 1 ? i + 1 : 0, pad), dir: settings.outDir || null });
      current = outputPath;
      S.progress = { base: done / totalDur, weight: plan.outDuration / totalDur, label: total > 1 ? `Part ${i + 1} of ${total} · ` : '' };
      await runExport(plan, outputPath);
      saved.push(outputPath);
      current = null;
      done += plan.outDuration;
    }

    let headline = total > 1 ? `Saved ${total} new videos` : 'Saved';
    if (replacing) {
      // Only now, with the edit fully written, is the original touched.
      $('#export-status').textContent = 'Replacing the original…';
      saved[0] = await invoke('replace_original', { original: source, temp: saved[0] });
      headline = 'Replaced (the old version is in the Recycle Bin)';
      await openVideo(saved[0]);
    }
    const secs = (performance.now() - startedAt) / 1000;
    const took = secs < 10 ? secs.toFixed(1) : Math.round(secs);
    result.innerHTML = `<span class="ok">${icon('check')}<b></b></span><span class="dim"></span>
      <button class="btn" data-a="reveal">Show in folder</button><button class="btn" data-a="open">Play</button>`;
    result.querySelector('b').textContent = `${headline} in ${took}s`;
    result.querySelector('.dim').textContent = total > 1 ? `${basename(saved[0])} … ${basename(saved[saved.length - 1])}` : basename(saved[0]);
    result.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'reveal') invoke('reveal', { path: saved[0] });
      if (a === 'open') invoke('open_external', { path: saved[0] });
    };
  } catch (e) {
    if (current) invoke('remove_file', { path: current });
    const kept = saved.length ? ` ${saved.length} of ${total} parts were saved.` : '';
    result.innerHTML = '<span></span><div class="err"></div>';
    if (String(e) === 'cancelled') {
      result.firstChild.textContent = `Export cancelled.${kept}`;
      result.lastChild.remove();
    } else {
      result.firstChild.textContent = `Export failed.${kept}`;
      result.querySelector('.err').textContent = String(e);
    }
  } finally {
    S.busy = null;
    S.progress = null;
    result.hidden = false;
    $('#export-progress').hidden = true;
    syncAll(); // also refreshes the name preview: the one we just used is taken
  }
}

/** Run one export; if a GPU encoder fails, retry once on the CPU. */
async function runExport(plan, outputPath) {
  let encoder = pickEncoder(S.info, S.encoders, settings.encoder);
  const run = (enc) => invoke('run_ffmpeg', {
    args: buildExportArgs(S.info, plan, { inputPath: S.path, outputPath, encoder: enc, quality: settings.quality }),
    duration: plan.outDuration,
  });
  try {
    await run(encoder);
  } catch (e) {
    if (String(e) === 'cancelled' || plan.mode !== 'reencode' || encoder.vendor === 'cpu') throw e;
    $('#export-status').textContent = 'Graphics card encoder failed, retrying on the processor…';
    encoder = pickEncoder(S.info, S.encoders.filter((n) => n.startsWith('lib')), 'cpu');
    await run(encoder);
  }
}

// ---------------------------------------------------------------------------
// Watch mode: a player for investigating clips
// ---------------------------------------------------------------------------
function setMode(mode) {
  if (S.mode === mode) return;
  // Marked a moment in Watch? Make it the trim when you start editing.
  if (mode === 'edit' && S.path) {
    const { a, b } = S.loop;
    const untouched = S.inT <= 0.001 && S.outT >= duration() - 0.001;
    if (a != null && b != null && untouched) {
      S.inT = Math.floor(a * fps() + 1e-6) / fps();
      S.outT = b;
      requestKeyframe();
      toast('Trim set to your loop');
    }
  }
  if (S.quick) S.quick = null;
  cancelHold();
  S.mode = mode;
  settings.mode = mode;
  saveSettings();
  S.confirmReplace = false;
  video.style.transform = 'none';
  lastMagCss = '';
  lastZoomCss = '!';
  syncAll();
}
$('#w-full-edit').addEventListener('click', () => setMode('edit'));
$('#e-back').addEventListener('click', () => setMode('watch'));

// Full screen (the whole window). Controls float over the video and fade while playing.
const appWindow = T.window.getCurrentWindow();
async function setFullscreen(on) {
  try {
    if (appWindow.setFullscreen) await appWindow.setFullscreen(on);
    else if (on) await document.documentElement.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    // Not supported here: ignore.
  }
  document.body.classList.toggle('fullscreen', on);
  $('#w-fullscreen use').setAttribute('href', on ? '#i-fullscreen-exit' : '#i-fullscreen');
  $('#w-fullscreen').title = on ? 'Exit full screen (Esc)' : 'Full screen (F, or double-click the video)';
  wakeControls();
  layoutFrame();
}
const isFullscreen = () => document.body.classList.contains('fullscreen');
const toggleFullscreen = () => setFullscreen(!isFullscreen());
$('#w-fullscreen').addEventListener('click', toggleFullscreen);
// Keep in sync if the OS takes the window out of full screen.
addEventListener('resize', async () => {
  if (!isFullscreen() || !appWindow.isFullscreen) return;
  if (!(await appWindow.isFullscreen())) setFullscreen(false);
});
// Watch controls behave like an auto-hiding Dock: they slide away after a moment without
// mouse movement (playing or paused) and come straight back when the mouse moves.
const IDLE_MS = 900;
let idleTimer = null;
/** Is the bar in use right now? Then it stays. */
function controlsInUse() {
  const bar = $('#watchbar');
  const typing = document.activeElement && bar.contains(document.activeElement) && document.activeElement.matches('input:not([type="range"])');
  return S.mode !== 'watch' || !S.path || !!S.quick || pointerOverBar() || !!popMenu
    || !!document.querySelector('dialog[open]') || scrub.classList.contains('drag') || quickDragging || typing;
}
function hideControls() {
  clearTimeout(idleTimer);
  if (controlsInUse()) return (idleTimer = setTimeout(hideControls, IDLE_MS));
  document.body.classList.add('idle');
}
function wakeControls() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(hideControls, IDLE_MS);
}
// Only real movement counts: the webview also sends "moves" with the cursor standing still
// (e.g. when the bar itself fades under it), which would make it flicker back.
let lastPointer = '';
let pointerAt = null; // last cursor position in the window (null = outside it)
/** Cursor over the bar? (Not :hover: that isn't updated when the bar reappears under a still cursor.) */
function pointerOverBar() {
  if (!pointerAt) return false;
  const r = $('#watchbar').getBoundingClientRect();
  return pointerAt.x >= r.left && pointerAt.x <= r.right && pointerAt.y >= r.top - 6 && pointerAt.y <= r.bottom;
}
document.addEventListener('pointermove', (e) => {
  pointerAt = { x: e.clientX, y: e.clientY };
  const at = `${e.screenX},${e.screenY}`;
  if (at === lastPointer) return;
  lastPointer = at;
  wakeControls();
}, { passive: true });
for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, wakeControls, { passive: true });
// Mouse left the window: hide right away, like the Dock (unless it's busy, e.g. mid-drag).
document.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return;
  lastPointer = '';
  pointerAt = null;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(hideControls, 60);
});
video.addEventListener('pause', wakeControls);

// Seek bar + readouts
let lastWatchT = -1;
const frameCount = () => Math.max(1, Math.round(duration() * fps()));
const frameAt = (t) => clamp(Math.floor(t * fps() + 1e-6) + 1, 1, frameCount());
/** Watch speed: 1 -> "1.0", 0.25 -> "0.25" (like the design's "1.0"). */
/** The labels either side of the seek bar: whole seconds (the tooltips show the exact time). */
const fmtLabel = (t) => formatTime(t, false);
const fmtRate = (v) => (Number.isInteger(v) ? v.toFixed(1) : fmtSpeed(v));
function renderWatchTime(t) {
  lastWatchT = t;
  const d = duration() || 1;
  const pct = `${clamp(t / d, 0, 1) * 100}%`;
  $('#w-progress').style.width = pct;
  $('#w-head').style.left = playheadLeft(t, d);
  const n = frameAt(t);
  const time = $('#w-time');
  if (S.quick && S.mode === 'watch') return; // while trimming the labels show the trim's start and end
  time.textContent = settings.showFrames ? `Frame ${n.toLocaleString()}` : fmtLabel(t);
  time.title = `${settings.showFrames ? fmt(t) : `Frame ${n.toLocaleString()}`} of ${frameCount().toLocaleString()} · ${Math.round(fps() * 100) / 100} fps\nClick to show ${settings.showFrames ? 'the time' : 'frame numbers'}`;
}
/**
 * Where to draw the playhead. With anchors on the bar (trim knobs or loop ends), it never sits
 * under one: within an anchor's width it's drawn against the anchor's inner edge instead
 * (right of the start anchor, left of the end anchor), as in the design.
 */
function playheadLeft(t, d) {
  const w = scrub.clientWidth;
  const { a, b } = S.loop;
  const ends = S.quick ? [S.inT, S.outT] : a != null && b != null ? [a, b] : null;
  if (!ends || !w) return `${clamp(t / d, 0, 1) * 100}%`;
  let x = clamp(t / d, 0, 1) * w;
  // Anchor bodies span 7px either side of their time; on the inner side the fillet and neck add 3px.
  const [s0, e0] = ends.map((v) => (v / d) * w);
  const OUT = 8; // outer side: the 2px stem's centre touching the body
  const IN = 11; // inner side: just past the fillet
  if (x > s0 - OUT && x < s0 + IN) x = x >= s0 - 0.5 ? s0 + IN : s0 - OUT;
  if (x > e0 - IN && x < e0 + OUT) x = x <= e0 + 0.5 ? e0 - IN : e0 + OUT;
  return `${x}px`;
}
function renderWatch() {
  const r = S.watchRate;
  $('#w-speed-label').textContent = fmtRate(r);
  $('#w-speed').classList.toggle('changed', Math.abs(r - 1) > 1e-6);
  $('#w-total').textContent = !S.path ? '0:00' : settings.showFrames ? `of ${frameCount().toLocaleString()}` : formatTime(duration(), false);
  if (S.path) {
    // Fixed widths (monospace): the bar never changes size as the numbers change.
    const d = duration();
    const longest = (a) => Math.max(...a.map((x) => x.length));
    $('#w-time').style.minWidth = `${longest([fmtLabel(d), `Frame ${frameCount().toLocaleString()}`])}ch`;
    $('#w-total').style.minWidth = `${longest([fmtLabel(d), `of ${frameCount().toLocaleString()}`])}ch`;
    // Edit-row time fields fit the longest time in this video (0:07.00 or 1:02:07.00)
    $('#editor').style.setProperty('--tch', fmt(d).length);
  }
  // Loop: yellow button, yellow section with two draggable ends on the seek bar
  const { a, b } = S.loop;
  const on = !!S.path && a != null && b != null;
  document.body.classList.toggle('looping', on && S.mode === 'watch');
  const btn = $('#w-loop-btn');
  btn.classList.toggle('on', on);
  btn.title = on ? `Looping ${fmt(a)} – ${fmt(b)}. Drag its ends on the seek bar. Click to stop (X)`
    : 'Loop a section: drag its ends on the seek bar (I / O set them to the playhead)';
  if (on) {
    const d = duration() || 1;
    $('#w-loop').style.left = `${(a / d) * 100}%`;
    $('#w-loop').style.width = `${((b - a) / d) * 100}%`;
    $('#w-la').style.left = `${(a / d) * 100}%`;
    $('#w-lb').style.left = `${(b / d) * 100}%`;
  }
  renderQuickTrim();
  const mag = $('#w-mag');
  mag.hidden = S.mag.scale <= 1.0001;
  mag.textContent = `${Math.round(S.mag.scale * 100)}%`;
  lastWatchT = -1;
}
$('#w-time').addEventListener('click', () => {
  settings.showFrames = !settings.showFrames;
  saveSettings();
  renderWatch();
});

const scrub = $('#w-scrub');
const scrubT = (e) => {
  const r = scrub.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * duration();
};
/** The time bubble above the seek bar while dragging a handle. */
/** Time tooltip over the bar. dx: set (even 0) when it belongs to an anchor, whose playhead then steps aside. */
function scrubBubble(t, kind, sub = '', dx = null) {
  const b = $('#w-bubble');
  document.body.classList.toggle('knobtip', t != null && (dx != null || kind === 'loop'));
  if (t == null) return (b.hidden = true);
  const w = scrub.clientWidth;
  b.hidden = false;
  b.className = `tip ${kind || ''}`;
  b.innerHTML = `<span></span>${sub ? '<small></small>' : ''}`;
  b.firstChild.textContent = fmt(t);
  if (sub) b.lastChild.textContent = sub;
  placeTip(b, (t / (duration() || 1)) * w + (dx || 0), w);
}
const KNOB_DX = { in: 0, out: 0 }; // anchors are centred on their time
/**
 * Put a tooltip over x (px within its container). The pill may extend past the container (over
 * the time labels or the video) and only stops at the window's edges, so the tail rarely has to
 * slide; when it does, it stays under the pill's flat bottom edge, never its rounded corners.
 */
function placeTip(el, x) {
  const half = el.offsetWidth / 2;
  const box = el.offsetParent ? el.offsetParent.getBoundingClientRect() : { left: 0 };
  const minL = -box.left + half + 8;
  const maxL = innerWidth - box.left - half - 8;
  const left = clamp(x, minL, Math.max(minL, maxL));
  el.style.left = `${left}px`;
  const flat = Math.max(0, half - 13 - 16); // 13px corner radius, 16px half the tail
  el.style.setProperty('--tail', `${clamp(x - left, -flat, flat)}px`);
}
scrub.addEventListener('pointerdown', (e) => {
  if (!S.path || e.button !== 0) return;
  const handle = S.quick && !S.quick.saved && e.target.closest('.w-handle');
  if (handle) return dragQuickHandle(e, handle.id === 'w-h-in' ? 'in' : 'out');
  const loopEnd = !S.quick && e.target.closest('.w-lhandle');
  if (loopEnd) return dragLoopEnd(e, loopEnd.id === 'w-la' ? 'a' : 'b');
  scrub.setPointerCapture(e.pointerId);
  scrub.classList.add('drag');
  const wasPlaying = !video.paused;
  video.pause();
  seek(scrubT(e));
  const move = (ev) => seek(scrubT(ev));
  const up = () => {
    scrub.classList.remove('drag');
    scrub.removeEventListener('pointermove', move);
    scrub.removeEventListener('pointerup', up);
    if (wasPlaying) video.play().catch(() => {});
  };
  scrub.addEventListener('pointermove', move);
  scrub.addEventListener('pointerup', up);
});
let quickDragging = false;
scrub.addEventListener('pointermove', (e) => {
  const hv = $('#w-hover');
  if (!S.path || quickDragging || e.target.closest('.w-lhandle, .w-handle')) return (hv.hidden = true);
  const r = scrub.getBoundingClientRect();
  hv.hidden = false;
  hv.textContent = fmt(scrubT(e));
  placeTip(hv, e.clientX - r.left, r.width);
});
scrub.addEventListener('pointerleave', () => ($('#w-hover').hidden = true));

// Frame stepping buttons repeat while held, like the arrow keys.
function holdRepeat(btn, fn) {
  let timer = null;
  const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || btn.disabled) return;
    fn();
    timer = setTimeout(() => { timer = setInterval(fn, 70); }, 350);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
}
holdRepeat($('#w-prev-frame'), () => stepFrame(-1));
holdRepeat($('#w-next-frame'), () => stepFrame(1));
$('#w-play').addEventListener('click', togglePlay);
$('#w-back5').addEventListener('click', () => seek(currentT() - 5));
$('#w-fwd5').addEventListener('click', () => seek(currentT() + 5));
$('#w-back10').addEventListener('click', () => seek(currentT() - 10));
$('#w-fwd10').addEventListener('click', () => seek(currentT() + 10));

// Playback speed (Watch only; it's not an edit). The value opens a menu with a custom field.
const WATCH_SPEEDS = [0.1, 0.125, 0.25, 0.33, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16];
const MENU_SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8];
function setWatchRate(v) {
  S.watchRate = Math.round(clamp(v, 0.1, 16) * 1000) / 1000;
  settings.watchRate = S.watchRate;
  saveSettings();
  if (!video.paused && S.mode === 'watch') video.playbackRate = S.watchRate;
  renderWatch();
}
const nudgeWatchRate = (dir) => {
  const r = S.watchRate;
  const next = dir > 0 ? WATCH_SPEEDS.find((v) => v > r + 1e-6) : [...WATCH_SPEEDS].reverse().find((v) => v < r - 1e-6);
  if (next) setWatchRate(next);
};
// The speed menu is the shared pop-up (on the page, not inside the frosted bar: an element
// that blurs what's behind it can't contain another one that does).
function openSpeedMenu() {
  const r = S.watchRate;
  const custom = !MENU_SPEEDS.some((v) => Math.abs(v - r) < 1e-6);
  openMenu($('#w-speed'), [
    ...MENU_SPEEDS.map((v) => {
      const on = Math.abs(v - r) < 1e-6;
      return { label: `${fmtRate(v)}×`, on, hint: v === 1 ? 'Normal' : '', run: () => setWatchRate(v) };
    }),
    '-',
    { input: { label: 'Custom', value: custom ? fmtSpeed(r) : '', placeholder: '0.1–16',
      apply: (t) => { const v = parseSpeed(t); if (!(v >= 0.1 && v <= 16)) return false; setWatchRate(v); } } },
  ]);
}
$('#w-speed-btn').addEventListener('click', openSpeedMenu);
$('#w-speed-val').addEventListener('click', openSpeedMenu);

// Loop: a yellow section on the seek bar. Starts at the playhead; drag either end to adjust.
const minLoop = () => Math.max(2 / fps(), 0.1);
const defaultLoopLen = () => Math.min(duration(), clamp(duration() * 0.1, 1, 10));
function startLoop(at = currentT()) {
  if (!S.path) return;
  const d = duration();
  const len = defaultLoopLen();
  let a = clamp(at, 0, d);
  let b = a + len;
  if (b > d) { b = d; a = Math.max(0, d - len); }
  S.loop = { a, b };
  renderWatch();
}
const clearLoop = () => { S.loop = { a: null, b: null }; renderWatch(); };
const toggleLoop = () => (S.loop.a != null ? clearLoop() : startLoop());
/** I / O: move the loop's start / end to the playhead (starting a loop if there isn't one). */
function setLoopPoint(which) {
  if (!S.path) return;
  const t = currentT();
  const d = duration();
  const len = defaultLoopLen();
  let { a, b } = S.loop;
  if (a == null) {
    a = which === 'a' ? t : Math.max(0, t - len);
    b = which === 'b' ? t : Math.min(d, t + len);
  } else if (which === 'a') {
    a = t;
    if (b - a < minLoop()) b = Math.min(d, a + len);
  } else {
    b = t;
    if (b - a < minLoop()) a = Math.max(0, b - len);
  }
  S.loop = { a, b };
  renderWatch();
}
function dragLoopEnd(e, which) {
  const el = $(which === 'a' ? '#w-la' : '#w-lb');
  el.classList.add('active');
  quickDragging = true;
  $('#w-hover').hidden = true;
  scrub.setPointerCapture(e.pointerId);
  const wasPlaying = !video.paused;
  video.pause();
  // The end sits beside its time (outside the loop): keep the grab point so it doesn't jump.
  const grab = scrubT(e) - S.loop[which];
  scrubBubble(S.loop[which], 'loop', '', KNOB_DX[which === 'a' ? 'in' : 'out']);
  const move = (ev) => {
    const t = snapFrame(scrubT(ev) - grab);
    if (which === 'a') S.loop.a = clamp(t, 0, S.loop.b - minLoop());
    else S.loop.b = clamp(t, S.loop.a + minLoop(), duration());
    seek(S.loop[which]); // show the frame under the handle
    scrubBubble(S.loop[which], 'loop', '', KNOB_DX[which === 'a' ? 'in' : 'out']);
    renderWatch();
  };
  const up = () => {
    el.classList.remove('active');
    quickDragging = false;
    scrubBubble(null);
    scrub.removeEventListener('pointermove', move);
    scrub.removeEventListener('pointerup', up);
    if (wasPlaying) { seek(S.loop.a); video.play().catch(() => {}); }
  };
  scrub.addEventListener('pointermove', move);
  scrub.addEventListener('pointerup', up);
}
$('#w-loop-btn').addEventListener('click', toggleLoop);

// Picture zoom: scroll on the video to zoom in where the mouse is, drag to look around.
let lastMagCss = '';
function clampMag() {
  const m = S.mag;
  const W = vframe.clientWidth;
  const H = vframe.clientHeight;
  m.scale = clamp(m.scale, 1, 8);
  m.x = clamp(m.x, W - W * m.scale, 0);
  m.y = clamp(m.y, H - H * m.scale, 0);
}
function applyMagnify() {
  const m = S.mag;
  const css = m.scale > 1.0001 ? `translate(${m.x}px, ${m.y}px) scale(${m.scale})` : 'none';
  document.body.classList.toggle('magnified', m.scale > 1.0001 && S.mode === 'watch');
  if (css === lastMagCss) return;
  lastMagCss = css;
  video.style.transformOrigin = '0 0';
  video.style.transform = css;
}
function magnifyAt(factor, cx, cy) {
  const m = S.mag;
  const s1 = clamp(m.scale * factor, 1, 8);
  m.x = cx - (cx - m.x) * (s1 / m.scale);
  m.y = cy - (cy - m.y) * (s1 / m.scale);
  m.scale = s1;
  clampMag();
  renderWatch();
}
const resetMag = () => { S.mag = { scale: 1, x: 0, y: 0 }; renderWatch(); };
$('#w-mag').addEventListener('click', resetMag);
vframe.addEventListener('wheel', (e) => {
  if (S.mode !== 'watch' || !S.path) return;
  e.preventDefault();
  const r = vframe.getBoundingClientRect();
  magnifyAt(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
vframe.addEventListener('pointerdown', (e) => {
  if (S.mode !== 'watch' || !S.path || e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const m0 = { ...S.mag };
  let moved = false;
  vframe.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) moved = true;
    if (!moved || S.mag.scale <= 1.0001) return;
    document.body.classList.add('panning');
    S.mag.x = m0.x + (ev.clientX - x0);
    S.mag.y = m0.y + (ev.clientY - y0);
    clampMag();
  };
  const up = () => {
    document.body.classList.remove('panning');
    vframe.removeEventListener('pointermove', move);
    vframe.removeEventListener('pointerup', up);
    if (!moved) togglePlay(); // click the picture to play / pause, like most players
  };
  vframe.addEventListener('pointermove', move);
  vframe.addEventListener('pointerup', up);
});
vframe.addEventListener('dblclick', () => {
  if (S.mode === 'watch' && S.path) toggleFullscreen();
});
new ResizeObserver(() => { clampMag(); lastMagCss = ''; }).observe(vframe);

// ---------------------------------------------------------------------------
// Quick trim: trim straight from the player, no editor
// ---------------------------------------------------------------------------
function startQuickTrim() {
  if (!S.path || S.busy) return;
  video.pause();
  S.quick = { prevIn: S.inT, prevOut: S.outT, saved: null, exact: !canExactCopy(S.info) };
  // Start from the A-B loop if one is set, else the whole clip.
  const { a, b } = S.loop;
  if (a != null && b != null) {
    S.inT = Math.floor(a * fps() + 1e-6) / fps();
    S.outT = b;
  }
  requestKeyframe();
  syncAll();
}
function endQuickTrim(keep) {
  if (!S.quick) return;
  if (!keep) {
    S.inT = S.quick.prevIn;
    S.outT = S.quick.prevOut;
    requestKeyframe();
  }
  S.quick = null;
  syncAll();
}
function quickSet(which, t) {
  const d = duration();
  const minLen = Math.max(1 / fps(), 0.05);
  if (which === 'in') S.inT = clamp(Math.floor(t * fps() + 1e-6) / fps(), 0, S.outT - minLen);
  else S.outT = clamp(t, S.inT + minLen, d);
  requestKeyframe();
  renderWatch();
}
function dragQuickHandle(e, which) {
  const handle = $(which === 'in' ? '#w-h-in' : '#w-h-out');
  handle.classList.add('active');
  quickDragging = true;
  $('#w-hover').hidden = true;
  scrub.setPointerCapture(e.pointerId);
  video.pause();
  scrubBubble(which === 'in' ? S.inT : S.outT, '', '', KNOB_DX[which]);
  const grab = scrubT(e) - (which === 'in' ? S.inT : S.outT);
  const move = (ev) => {
    const t = snapFrame(scrubT(ev) - grab);
    const minLen = Math.max(1 / fps(), 0.05);
    if (which === 'in') S.inT = clamp(t, 0, S.outT - minLen);
    else S.outT = clamp(t, S.inT + minLen, duration());
    const at = which === 'in' ? S.inT : S.outT;
    seek(at); // show the exact frame under the handle
    scrubBubble(at, '', '', KNOB_DX[which]);
    renderQuickTrim();
  };
  const up = () => {
    handle.classList.remove('active');
    quickDragging = false;
    scrubBubble(null);
    if (hoverHandle) quickTip(hoverHandle);
    scrub.removeEventListener('pointermove', move);
    scrub.removeEventListener('pointerup', up);
    requestKeyframe();
    renderWatch();
  };
  scrub.addEventListener('pointermove', move);
  scrub.addEventListener('pointerup', up);
}
function renderQuickTrim() {
  const q = S.quick;
  document.body.classList.toggle('quicktrim', !!q && S.mode === 'watch');
  if (!q || !S.path) return;
  const d = duration() || 1;
  const pi = (S.inT / d) * 100;
  const po = (S.outT / d) * 100;
  $('#w-dim-l').style.left = '0';
  $('#w-dim-l').style.width = `${pi}%`;
  $('#w-dim-r').style.left = `${po}%`;
  $('#w-dim-r').style.width = `${100 - po}%`;
  $('#w-sel').style.left = `${pi}%`;
  $('#w-sel').style.width = `${po - pi}%`;
  $('#w-h-in').style.left = `${pi}%`;
  $('#w-h-out').style.left = `${po}%`;
  // Lossless cuts start on a keyframe: the start knob's tooltip and Save ▾ say where.
  const plan = planExport(S.info, { ...quickEdit(), exact: false });
  q.lead = !q.exact && S.keyframeFor === S.inT && plan.snapDelta > 0.0005 ? plan.snapDelta : 0;
  // The labels either side of the bar show the trim's start and end.
  $('#w-time').textContent = fmtLabel(S.inT);
  $('#w-total').textContent = fmtLabel(S.outT);
  $('#w-time').title = 'Start of the trim';
  $('#w-total').title = `End of the trim · ${fmt(S.outT - S.inT)} long`;
  const exactCopy = canExactCopy(S.info);
  $('#w-trim-save').title = `Save these ${fmt(S.outT - S.inT)} as a new video, ${exactCopy ? 'lossless, starting on the exact frame' : q.exact ? 'starting on the exact frame (re-encodes)' : q.lead ? `lossless (starts ${q.lead.toFixed(2)}s earlier, at a keyframe)` : 'lossless'}. Your original stays untouched (Enter)`;
  // Only files that can't start on an exact frame losslessly have a choice to make.
  $('#w-save-opts').hidden = exactCopy;
  $('#w-save-split').classList.toggle('single', exactCopy);
  $('#w-save-opts').disabled = !!S.busy;
  if (hoverHandle && !quickDragging) quickTip(hoverHandle); // e.g. the keyframe just arrived
  $('#w-quick-edit').hidden = !!q.saved;
  $('#w-quick-done').hidden = !q.saved;
  if (q.saved) $('#w-saved-name').textContent = `Saved ${basename(q.saved)}`;
  if (!S.busy) $('#w-trim-save').textContent = 'Save trim';
  $('#w-trim-save').disabled = $('#w-trim-cancel').disabled = !!S.busy;
}
/** Quick trim = a plain lossless trim, without any Edit-mode effects. */
function quickEdit() {
  return {
    inT: S.inT, outT: S.outT, exact: !!(S.quick && S.quick.exact),
    keyframeIn: S.keyframeFor === S.inT ? S.keyframeIn : S.inT,
    slow: { enabled: false, start: 0, end: 0, speed: 1 }, sfx: [], zooms: [], origVolume: 1,
  };
}
async function quickSave() {
  if (!S.quick || S.busy || !S.path) return;
  if (S.outT - S.inT < 0.05) return toast('The selection is too short');
  video.pause();
  S.busy = 'export';
  renderQuickTrim();
  $('#w-trim-save').textContent = 'Saving…';
  let outputPath = null;
  try {
    const edit = quickEdit();
    edit.keyframeIn = await ensureKeyframe(); // decides lossless-exact vs keyframe vs re-encode
    const plan = planExport(S.info, edit);
    if (plan.mode === 'reencode' && S.encodersReady) await S.encodersReady;
    outputPath = await invoke('output_path', { src: S.path, ext: plan.ext, name: defaultSaveName(), dir: settings.outDir || null });
    await runExport(plan, outputPath);
    if (S.quick) S.quick.saved = outputPath;
    toast(`Saved ${basename(outputPath)}`, 3500);
  } catch (e) {
    if (outputPath) invoke('remove_file', { path: outputPath });
    if (String(e) !== 'cancelled') toast(`Couldn't save the trim: ${String(e).slice(0, 160)}`, 6000);
  } finally {
    S.busy = null;
    syncAll();
  }
}
$('#w-trim').addEventListener('click', startQuickTrim);
// Hover a handle: its exact time (and where a lossless cut really starts)
const quickTip = (which) => {
  const q = S.quick;
  const t = which === 'in' ? S.inT : S.outT;
  scrubBubble(t, '', which === 'in' && q && q.lead ? `lossless from ${fmt(t - q.lead)}` : '', KNOB_DX[which]);
};
let hoverHandle = null;
for (const [sel, which] of [['#w-h-in', 'in'], ['#w-h-out', 'out']]) {
  $(sel).addEventListener('pointerenter', () => { hoverHandle = which; if (S.quick && !quickDragging) quickTip(which); });
  $(sel).addEventListener('pointerleave', () => { hoverHandle = null; if (!quickDragging) scrubBubble(null); });
}
// Save ▾: lossless (instant, starts on a keyframe) or frame-exact (re-encodes)
$('#w-save-opts').addEventListener('click', (e) => {
  const q = S.quick;
  if (!q || q.saved || S.busy) return;
  openMenu(e.currentTarget, [
    { title: 'Save the trim' },
    { label: 'Lossless', hint: q.lead ? `starts ${q.lead.toFixed(2)}s early, on a keyframe` : 'original quality, instant', on: !q.exact, run: () => { q.exact = false; renderQuickTrim(); } },
    { label: 'Frame-exact start', hint: 're-encodes, visually lossless', on: !!q.exact, run: () => { q.exact = true; renderQuickTrim(); } },
  ]);
});
$('#w-trim-cancel').addEventListener('click', () => endQuickTrim(false));
$('#w-trim-save').addEventListener('click', quickSave);
$('#w-trim-done').addEventListener('click', () => endQuickTrim(true));
$('#w-saved-reveal').addEventListener('click', () => S.quick?.saved && invoke('reveal', { path: S.quick.saved }));

// ---------------------------------------------------------------------------
// Split: turn one video into several, from a small dialog. Whole video, lossless.
// ---------------------------------------------------------------------------
const SPLIT_MAX = 200;
const SP = {
  mode: settings.splitMode === 'length' ? 'length' : 'count',
  count: clamp(Math.round(Number(settings.splitCount)) || 4, 2, 99),
  len: Number(settings.splitLen) > 0 ? Number(settings.splitLen) : 3600,
  points: [], // cut times after snapping to keyframes
  dts: new Map(), // cut time -> that keyframe's decode time, so parts join exactly
  snapping: null, // promise while keyframes are being looked up
  seq: 0,
  saved: [],
};
const splitDlg = $('#split');
/** Where we'd like to cut, before keyframes. */
function wantedSplitPoints() {
  const d = duration();
  return SP.mode === 'count' ? evenSplitPoints(0, d, SP.count) : fixedSplitPoints(0, d, SP.len);
}
/** Move every cut onto the nearest keyframe so each part is a stream copy. */
function snapSplit() {
  const seq = ++SP.seq;
  const path = S.path;
  const wanted = wantedSplitPoints();
  SP.points = wanted;
  SP.dts = new Map();
  if (wanted.length > SPLIT_MAX - 1) { SP.snapping = null; return renderSplit(); }
  SP.snapping = (async () => {
    await null; // finish assigning SP.snapping before this can clear it
    const d = duration();
    const snapped = [];
    const dts = new Map();
    for (const t of wanted) {
      const kfs = await invoke('keyframes_near', { path, t, start: S.info.start });
      const k = nearestKeyframe(kfs, t, snapped.length ? snapped[snapped.length - 1] : 0, d);
      snapped.push(k.t);
      if (k.dts != null) dts.set(k.t, k.dts);
    }
    if (seq !== SP.seq || path !== S.path) return;
    // Two cuts can land on one keyframe when parts are shorter than the keyframe gap.
    SP.points = partsFromPoints(0, d, snapped).slice(1).map((p) => p.inT);
    SP.dts = dts;
    SP.snapping = null;
    renderSplit();
  })();
  SP.snapping.catch((e) => {
    if (seq === SP.seq) SP.snapping = null;
    toast(`Couldn't find keyframes: ${String(e).slice(0, 160)}`, 5000);
  });
  renderSplit();
}
let splitTimer = null;
const resnapSplit = () => {
  clearTimeout(splitTimer);
  splitTimer = setTimeout(() => { splitTimer = null; snapSplit(); }, 250);
  renderSplit();
};

function renderSplit() {
  if (!S.path) return;
  const d = duration();
  const running = S.busy === 'split';
  const done = !running && SP.saved.length > 0;
  $$('#split-mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === SP.mode)));
  $$('#split .split-field').forEach((f) => (f.hidden = f.dataset.for !== SP.mode));
  if (document.activeElement !== $('#split-count')) $('#split-count').value = SP.count;
  if (document.activeElement !== $('#split-len')) $('#split-len').value = formatTime(SP.len, false);
  $$('#split-presets button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === SP.len));
  for (const el of $$('#split-mode button, #split .split-field button, #split .split-field input')) el.disabled = running || done;

  const tooMany = wantedSplitPoints().length > SPLIT_MAX - 1;
  const parts = partsFromPoints(0, d, SP.points);
  const n = parts.length;
  $('#split-each').textContent = `parts of about ${formatTime(d / SP.count, false)}`;
  // The list of parts, with their real (keyframe) times once known
  const list = $('#split-list');
  const show = parts.length > 14 ? [...parts.slice(0, 12), null, parts[parts.length - 1]] : parts;
  list.innerHTML = tooMany ? '' : show.map((p) => (p
    ? `<li><span class="i">${p.index}</span><span>${formatTime(p.inT, false)} → ${formatTime(p.outT, false)}</span><b>${formatTime(p.outT - p.inT, false)}</b></li>`
    : `<li class="more">… ${parts.length - 13} more</li>`)).join('');
  list.classList.toggle('pending', !!SP.snapping || !!splitTimer);
  const note = $('#split-note');
  if (tooMany) note.textContent = `That makes more than ${SPLIT_MAX} parts. Choose a longer length.`;
  else if (n < 2) note.textContent = SP.mode === 'length' ? 'The video is shorter than that, so there is nothing to split.' : 'This video is too short to split.';
  else if (SP.snapping || splitTimer) note.textContent = 'Finding the cut points…';
  else {
    const fewer = SP.mode === 'count' && n < SP.count ? ` Only ${n} parts fit: lossless cuts start on a keyframe and this video has few of them.` : '';
    note.textContent = `Lossless: each part is copied bit for bit, cut at the nearest keyframe. Saved next to the original as ${stemOf(S.path)}_part1… Your original stays untouched.${fewer}`;
  }
  const go = $('#split-go');
  go.textContent = running ? 'Splitting…' : n >= 2 ? `Split into ${n} videos` : 'Split';
  go.disabled = running || tooMany || n < 2;
  $('#split-cancel').textContent = running ? 'Stop' : 'Cancel';
  $('#split-progress').hidden = !running;
  $('#split-actions').hidden = done;
  $('#split-done').hidden = !done;
}

function openSplit() {
  if (!S.path || S.busy) return;
  video.pause();
  closeMenu();
  SP.saved = [];
  $('#split-src').textContent = `${basename(S.path)} · ${formatTime(duration(), false)}`;
  splitDlg.showModal();
  snapSplit();
}
function setSplitMode(mode) { SP.mode = mode; settings.splitMode = mode; saveSettings(); resnapSplit(); }
function setSplitCount(n) {
  SP.count = clamp(Math.round(n) || 2, 2, 99);
  settings.splitCount = SP.count;
  saveSettings();
  resnapSplit();
}
function setSplitLen(sec) {
  SP.len = Math.max(1, sec);
  settings.splitLen = SP.len;
  saveSettings();
  resnapSplit();
}

async function runSplit() {
  if (!S.path || S.busy) return;
  if (splitTimer) { clearTimeout(splitTimer); splitTimer = null; snapSplit(); }
  if (SP.snapping) await SP.snapping;
  const d = duration();
  const parts = partsFromPoints(0, d, SP.points);
  if (parts.length < 2) return;
  S.busy = 'split';
  SP.saved = [];
  const startedAt = performance.now();
  let current = null;
  renderSplit();
  try {
    const edits = parts.map((p) => ({
      inT: p.inT, outT: p.outT, exact: false, keyframeIn: p.inT,
      endDts: p.index < parts.length ? SP.dts.get(p.outT) ?? null : null,
      slow: { enabled: false, start: 0, end: 0, speed: 1 }, sfx: [], zooms: [], origVolume: 1,
    }));
    const plans = edits.map((e) => planExport(S.info, e));
    const pad = String(plans.length).length;
    let done = 0;
    for (let i = 0; i < plans.length; i++) {
      const name = `${stemOf(S.path)}_part${String(i + 1).padStart(pad, '0')}`;
      const outputPath = await invoke('output_path', { src: S.path, ext: plans[i].ext, name, dir: settings.outDir || null });
      current = outputPath;
      S.progress = { base: done / d, weight: plans[i].outDuration / d, label: `Part ${i + 1} of ${plans.length} · ` };
      await runExport(plans[i], outputPath);
      SP.saved.push(outputPath);
      current = null;
      done += plans[i].outDuration;
    }
    const secs = (performance.now() - startedAt) / 1000;
    $('#split-saved').textContent = `Saved ${SP.saved.length} videos in ${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
  } catch (e) {
    if (current) invoke('remove_file', { path: current });
    const kept = SP.saved.length ? ` ${SP.saved.length} of ${parts.length} parts were saved.` : '';
    toast(String(e) === 'cancelled' ? `Split stopped.${kept}` : `Split failed: ${String(e).slice(0, 160)}.${kept}`, 6000);
    if (SP.saved.length) $('#split-saved').textContent = `Saved ${SP.saved.length} of ${parts.length} videos`;
  } finally {
    S.busy = null;
    S.progress = null;
    syncAll();
    renderSplit();
  }
}

$('#w-split').addEventListener('click', openSplit);
$$('#split-mode button').forEach((b) => b.addEventListener('click', () => setSplitMode(b.dataset.mode)));
$('#split-minus').addEventListener('click', () => setSplitCount(SP.count - 1));
$('#split-plus').addEventListener('click', () => setSplitCount(SP.count + 1));
$('#split-count').addEventListener('input', (e) => { const n = Number(e.target.value); if (n >= 2 && n <= 99) setSplitCount(n); });
$('#split-count').addEventListener('change', () => renderSplit());
$('#split-len').addEventListener('input', (e) => {
  const v = parseDuration(e.target.value);
  e.target.classList.toggle('invalid', e.target.value.trim() !== '' && !(v > 0));
  if (v > 0) setSplitLen(v);
});
$('#split-len').addEventListener('change', (e) => { e.target.classList.remove('invalid'); renderSplit(); });
$('#split-presets').addEventListener('click', (e) => {
  const v = Number(e.target.closest('button')?.dataset.v);
  if (v) setSplitLen(v);
});
for (const el of [$('#split-count'), $('#split-len')]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSplit(); } });
$('#split-go').addEventListener('click', runSplit);
$('#split-cancel').addEventListener('click', () => (S.busy === 'split' ? cancelJob() : splitDlg.close()));
$('#split-close').addEventListener('click', () => splitDlg.close());
$('#split-reveal').addEventListener('click', () => SP.saved[0] && invoke('reveal', { path: SP.saved[0] }));
// Don't let Esc or the X close it mid-split.
splitDlg.addEventListener('cancel', (e) => { if (S.busy === 'split') e.preventDefault(); });
$('#split-x').addEventListener('click', (e) => { if (S.busy === 'split') e.preventDefault(); });

function watchKey(e, k, handled) {
  if (S.quick) {
    if (k === 'Enter') { handled(); return S.quick.saved ? endQuickTrim(true) : quickSave(); }
    if (k === 'Escape') { handled(); return S.quick.saved ? endQuickTrim(true) : endQuickTrim(false); }
    if (k === 'i' || k === 'I') return quickSet('in', currentT());
    if (k === 'o' || k === 'O') return quickSet('out', currentT());
    if (k === 'Home') { handled(); return seek(S.inT); }
    if (k === 'End') { handled(); return seek(S.outT); }
  } else if (k === 't' || k === 'T') return startQuickTrim();
  else if (k === 'p' || k === 'P') return openSplit();
  if (k === 'f' || k === 'F') return toggleFullscreen();
  if (k === 'Escape' && isFullscreen()) return setFullscreen(false);
  if (k === ' ' || k === 'k' || k === 'K') { handled(); togglePlay(); }
  else if (k === 'ArrowLeft') { handled(); e.shiftKey ? seek(currentT() - 1) : stepFrame(-1); }
  else if (k === 'ArrowRight') { handled(); e.shiftKey ? seek(currentT() + 1) : stepFrame(1); }
  else if (k === 'j' || k === 'J') seek(currentT() - (e.shiftKey ? 10 : 5));
  else if (k === 'l' || k === 'L') seek(currentT() + (e.shiftKey ? 10 : 5));
  else if (k === 'm' || k === 'M') toggleMute();
  else if (k === 'ArrowUp') { handled(); setVolume((settings.muted ? 0 : settings.previewVolume) + 0.05); toast(`Volume ${Math.round(settings.previewVolume * 100)}%`, 700); }
  else if (k === 'ArrowDown') { handled(); setVolume(settings.previewVolume - 0.05); toast(settings.muted ? 'Muted' : `Volume ${Math.round(settings.previewVolume * 100)}%`, 700); }
  else if (k === '[') nudgeWatchRate(-1);
  else if (k === ']') nudgeWatchRate(1);
  else if (k === 'r' || k === 'R') setWatchRate(1);
  else if (k === 'i' || k === 'I') setLoopPoint('a');
  else if (k === 'o' || k === 'O') setLoopPoint('b');
  else if (k === 'x' || k === 'X') clearLoop();
  else if (k === '+' || k === '=') magnifyAt(1.25, vframe.clientWidth / 2, vframe.clientHeight / 2);
  else if (k === '-' || k === '_') magnifyAt(0.8, vframe.clientWidth / 2, vframe.clientHeight / 2);
  else if (k === '0') resetMag();
  else if (k === 'Home') { handled(); seek(S.loop.a ?? 0); }
  else if (k === 'End') { handled(); seek(S.loop.b ?? duration()); }
  else if (k === 'PageUp') { handled(); gotoSibling(-1); }
  else if (k === 'PageDown') { handled(); gotoSibling(1); }
  else if (k === '?') $('#help').showModal();
}

// ---------------------------------------------------------------------------
// Encoder detection
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// First launch: download the video engine (ffmpeg) once
// ---------------------------------------------------------------------------
async function ensureEngine() {
  if (await invoke('engine_ready')) return;
  const stages = { download: 'Downloading', verify: 'Checking', unpack: 'Unpacking' };
  const unlisten = await T.event.listen('engine-progress', (e) => {
    const { ratio, stage } = e.payload;
    overlay(`Setting up QuickCut. This one-time download (78 MB) is the video engine that keeps your edits lossless. ${stages[stage] || ''}${stage === 'download' ? ` ${Math.round(ratio * 100)}%` : '…'}`, ratio);
  });
  $('#empty-state').hidden = true;
  for (;;) {
    overlay('Setting up QuickCut. This one-time download (78 MB) is the video engine that keeps your edits lossless.', 0);
    $('#overlay-retry').hidden = true;
    try {
      await invoke('install_engine');
      if (await invoke('engine_ready')) break;
      throw new Error('The video engine was installed but does not start.');
    } catch (e) {
      overlay(`Setup didn't finish: ${String(e).slice(0, 220)}`, 0);
      $('#overlay-retry').hidden = false;
      await new Promise((r) => $('#overlay-retry').addEventListener('click', r, { once: true }));
    }
  }
  unlisten();
  overlay(null);
  $('#overlay-retry').hidden = true;
  if (!S.path) $('#empty-state').hidden = false;
}
const engineReady = ensureEngine();

// ---------------------------------------------------------------------------
// In-app updates
// ---------------------------------------------------------------------------
let pendingUpdate = null;
async function checkForUpdate(manual = false) {
  const status = $('#update-status');
  if (manual) status.textContent = 'Checking…';
  try {
    pendingUpdate = await invoke('check_update');
  } catch (e) {
    if (manual) status.textContent = `Couldn't check (${String(e).slice(0, 80)})`;
    return;
  }
  const btn = $('#btn-update');
  btn.hidden = !pendingUpdate;
  if (pendingUpdate) {
    btn.textContent = `Update to ${pendingUpdate.version}`;
    btn.title = pendingUpdate.notes || 'A new version of QuickCut is available';
    status.textContent = `Version ${pendingUpdate.version} is available`;
  } else if (manual) {
    status.textContent = "You're up to date";
  }
}
async function installUpdate() {
  if (!pendingUpdate) return;
  if (S.busy === 'export') return toast('Finish or cancel the export first');
  const btn = $('#btn-update');
  btn.disabled = true;
  btn.textContent = 'Downloading update…';
  const unlisten = await T.event.listen('update-progress', (e) => {
    const { downloaded, total } = e.payload;
    btn.textContent = total ? `Updating… ${Math.round((downloaded / total) * 100)}%` : 'Updating…';
  });
  try {
    await invoke('install_update'); // the app restarts into the new version
  } catch (e) {
    unlisten();
    btn.disabled = false;
    btn.textContent = `Update to ${pendingUpdate.version}`;
    toast(`Update failed: ${String(e).slice(0, 160)}`, 6000);
  }
}
$('#btn-update').addEventListener('click', installUpdate);
$('#btn-check-update').addEventListener('click', () => checkForUpdate(true));
invoke('app_version').then((v) => ($('#app-version').textContent = `v${v}`));
engineReady.then(() => setTimeout(() => checkForUpdate(false), 3000));

S.encodersReady = engineReady.then(() => invoke('detect_encoders', { candidates: ENCODER_CANDIDATES }))
  .then((list) => {
    S.encoders = list;
    const byVendor = {};
    for (const [fam, vendors] of Object.entries(ENCODERS)) {
      for (const [vendor, name] of Object.entries(vendors)) {
        if (name && list.includes(name)) (byVendor[vendor] ||= []).push(fam.toUpperCase());
      }
    }
    $('#set-encoders-found').textContent = 'Found: ' + (Object.entries(byVendor).map(([v, f]) => `${VENDOR_LABEL[v]} (${f.join(', ')})`).join(' · ') || 'none');
    updateExportInfo();
  })
  .catch((e) => {
    $('#set-encoders-found').textContent = `ffmpeg not found: ${e}`;
    toast("ffmpeg wasn't found. Keep the ffmpeg folder next to QuickCut.exe", 8000);
  });

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
async function pickAndOpen() {
  const p = await invoke('pick_video', { dir: settings.lastDir || null });
  if (p) openVideo(p);
}
$('#btn-open').addEventListener('click', pickAndOpen);
$('#btn-open-empty').addEventListener('click', pickAndOpen);
$('#btn-help').addEventListener('click', () => $('#help').showModal());
$('#e-help').addEventListener('click', () => $('#help').showModal());
$('#btn-play').addEventListener('click', togglePlay);
$('#btn-to-start').addEventListener('click', () => seek(S.inT));
$('#btn-back5').addEventListener('click', () => seek(currentT() - 5));
$('#btn-fwd5').addEventListener('click', () => seek(currentT() + 5));
$('#btn-back10').addEventListener('click', () => seek(currentT() - 10));
$('#btn-fwd10').addEventListener('click', () => seek(currentT() + 10));

// Hover time on the ruler / lanes
track.addEventListener('pointermove', (e) => {
  const pill = $('#tl-hover');
  if (!S.path || drag || e.target.closest('.tl-head')) return (pill.hidden = true);
  const x = e.clientX - strip.getBoundingClientRect().left;
  if (x < 0) return (pill.hidden = true);
  pill.hidden = false;
  pill.textContent = fmt(xToT(x));
  placeTip(pill, x, strip.clientWidth);
  pill.style.left = `${parseFloat(pill.style.left) + 8}px`; // the ruler has 8px padding
});
track.addEventListener('pointerleave', () => ($('#tl-hover').hidden = true));

// Scroll bar dragging
$('#tl-scroll').addEventListener('pointerdown', (e) => {
  if (!S.path) return;
  const bar = e.currentTarget;
  const thumb = $('#tl-thumb');
  const w = bar.clientWidth;
  const d = duration();
  const span = S.view.end - S.view.start;
  if (e.target !== thumb) {
    // Click on the track: center the view there.
    const t = ((e.clientX - bar.getBoundingClientRect().left) / w) * d;
    setView(t - span / 2, t + span / 2);
  }
  const x0 = e.clientX;
  const s0 = S.view.start;
  thumb.classList.add('active');
  bar.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const start = s0 + ((ev.clientX - x0) / w) * d;
    setView(start, start + span);
  };
  const up = () => {
    thumb.classList.remove('active');
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
});

// ---------------------------------------------------------------------------
// Timeline rows: each effect's controls sit at the left of its lane
// ---------------------------------------------------------------------------
// Pop-up menu for the value pickers. items: { label, hint, on, run, extras: [{ icon, title, run }] },
// { title }, '-', or { input: { label, value, placeholder, apply(text) -> false if invalid } }.
let popMenu = null;
function closeMenu() {
  if (!popMenu) return;
  popMenu.el.remove();
  popMenu = null;
}
function openMenu(anchor, items) {
  if (popMenu && popMenu.anchor === anchor) return closeMenu();
  closeMenu();
  const el = document.createElement('div');
  el.className = anchor.closest('#watchbar') ? 'menu pop frost' : 'menu pop';
  for (const it of items) {
    if (it === '-') { el.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); continue; }
    if (it.title) {
      const d = document.createElement('div');
      d.className = 'title';
      d.textContent = it.title;
      el.appendChild(d);
      continue;
    }
    if (it.input) {
      const l = document.createElement('label');
      l.textContent = it.input.label;
      const inp = document.createElement('input');
      Object.assign(inp, { value: it.input.value ?? '', placeholder: it.input.placeholder || '', spellcheck: false, autocomplete: 'off' });
      inp.addEventListener('input', () => inp.classList.remove('invalid'));
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') closeMenu();
        if (e.key !== 'Enter') return;
        if (it.input.apply(inp.value) === false) inp.classList.add('invalid');
        else closeMenu();
      });
      l.appendChild(inp);
      el.appendChild(l);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = it.on ? 'on' : '';
    const label = document.createElement('span');
    label.textContent = it.label;
    b.appendChild(label);
    if (it.on) b.insertAdjacentHTML('beforeend', icon('check'));
    else if (it.hint) {
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = it.hint;
      b.appendChild(k);
    }
    b.addEventListener('click', () => { closeMenu(); it.run(); });
    if (!it.extras) { el.appendChild(b); continue; }
    const row = document.createElement('div');
    row.className = 'item-row';
    row.appendChild(b);
    for (const x of it.extras) {
      const m = document.createElement('button');
      m.type = 'button';
      m.className = 'mini';
      m.title = x.title;
      m.innerHTML = icon(x.icon);
      m.addEventListener('click', x.run);
      row.appendChild(m);
    }
    el.appendChild(row);
  }
  document.body.appendChild(el);
  // Below the button if it fits, else above.
  const r = anchor.getBoundingClientRect();
  const below = r.bottom + 6 + el.offsetHeight <= innerHeight - 8;
  el.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - el.offsetHeight)}px`;
  el.style.left = `${clamp(r.left, 8, innerWidth - el.offsetWidth - 8)}px`;
  popMenu = { el, anchor };
}
document.addEventListener('pointerdown', (e) => {
  if (popMenu && !popMenu.el.contains(e.target) && !popMenu.anchor.contains(e.target)) closeMenu();
});
addEventListener('resize', closeMenu);

const pct = (v) => (v < 0.001 ? 'Muted' : `${Math.round(v * 100)}%`);
const parsePct = (text) => {
  const v = Number(String(text).replace('%', '').trim()) / 100;
  return isFinite(v) && v >= 0 && v <= 2 ? v : NaN;
};
const VOLUMES = [0, 0.5, 1, 1.5, 2];
const volumeItems = (current, set) => [
  ...VOLUMES.map((v) => ({ label: v === 0 ? 'Mute' : pct(v), on: Math.abs(current - v) < 1e-6, hint: v === 1 ? 'Original' : '', run: () => set(v) })),
  '-',
  { input: { label: 'Custom %', value: VOLUMES.some((v) => Math.abs(v - current) < 1e-6) ? '' : Math.round(current * 100), placeholder: '0–200',
    apply: (t) => { const v = parsePct(t); if (!isFinite(v)) return false; set(v); } } },
];

/** Zoom centre in video pixels (what the X / Y fields show). */
function zoomCenterPx(z) {
  const k = 1 / z.amount;
  return [Math.round((z.fx * (1 - k) + k / 2) * S.info.width), Math.round((z.fy * (1 - k) + k / 2) * S.info.height)];
}

function renderRows() {
  const has = !!S.path;
  $$('.tl-row[data-row]').forEach((r) => r.classList.toggle('focus', has && r.dataset.row === S.tool));
  // Trim
  if (document.activeElement !== $('#in-time')) $('#in-time').value = has ? fmt(S.inT) : '';
  if (document.activeElement !== $('#out-time')) $('#out-time').value = has ? fmt(S.outT) : '';
  $('#btn-reset-trim').hidden = !(has && (S.inT > 0.001 || S.outT < duration() - 0.001));
  // Amplitude
  const hasAudio = has && S.info.audioCount > 0;
  $('#amp-pick').disabled = !hasAudio;
  $('#amp-label').textContent = pct(S.origVolume);
  $('#amp-hint').textContent = !has ? '' : !hasAudio ? 'This video has no sound' : S.origVolume > 1.001 ? 'Loud parts may distort' : '';
  // Zoom: controls for the selected zoom
  if (!selectedZoom() && S.zooms.length) {
    const t = currentT();
    S.selectedZoom = (S.zooms.find((z) => t >= z.start && t <= z.end) || S.zooms[0]).id;
  }
  const z = selectedZoom();
  $('.tl-row[data-row="zoom"]').classList.toggle('is-on', !!z);
  if (z) {
    $('#zoom-label').textContent = `${fmtSpeed(z.amount)}×`;
    const [x, y] = zoomCenterPx(z);
    if (document.activeElement !== $('#zoom-x')) $('#zoom-x').value = x;
    if (document.activeElement !== $('#zoom-y')) $('#zoom-y').value = y;
  }
  // Speed
  $('.tl-row[data-row="slow"]').classList.toggle('is-on', S.slow.enabled);
  $('#speed-label').textContent = `${fmtSpeed(S.slow.speed)}×`;
  $('#speed-pick .muted').toggleAttribute('hidden', !S.slow.muteAudio); // SVG has no .hidden property
  $('#speed-pick').title = `${describeSpeed(S.slow.speed)}. Click to change the speed or its sound`;
  if (document.activeElement !== $('#slow-start')) $('#slow-start').value = fmt(S.slow.start);
  if (document.activeElement !== $('#slow-end')) $('#slow-end').value = fmt(S.slow.end);
  // Freeze
  if (!selectedFreeze()) S.selectedFreeze = S.freezes[0]?.id ?? null;
  const fz = selectedFreeze();
  $('.tl-row[data-row="freeze"]').classList.toggle('is-on', !!fz);
  if (fz) {
    $('#freeze-label').textContent = `${fmtSpeed(fz.hold)}s`;
    if (document.activeElement !== $('#freeze-at')) $('#freeze-at').value = fmt(fz.at);
  }
  // Sounds
  const sel = S.sfx.find((x) => x.id === S.selectedSfx);
  $('.tl-row[data-row="sound"]').classList.toggle('is-on', !!sel);
  if (sel) {
    $('#sfx-item-name').textContent = sel.name;
    $('#sfx-vol-pick').title = `${sel.name} at ${fmt(sel.at)}. Click to change its volume`;
    $('#sfx-vol-label').textContent = pct(sel.volume);
  }
}

// Clicking a row's controls makes it the focused row (keys T M Z N A do the same).
$$('.tl-row[data-row] .tl-head').forEach((h) => h.addEventListener('pointerdown', () => {
  const row = h.closest('.tl-row').dataset.row;
  if (S.path && S.tool !== row) setTool(row);
}));

// Trim
bindTimeField($('#in-time'), (t) => setIn(t));
bindTimeField($('#out-time'), (t) => setOut(t));
$('#btn-reset-trim').addEventListener('click', () => { S.inT = 0; S.outT = duration(); afterTrimChange(); });
// Amplitude
$('#amp-pick').addEventListener('click', (e) => openMenu(e.currentTarget, volumeItems(S.origVolume, (v) => { S.origVolume = v; syncAll(); })));

// Zoom
$('#zoom-add').addEventListener('click', addZoomAtPlayhead);
$('#zoom-add-another').addEventListener('click', addZoomAtPlayhead);
$('#zoom-remove').addEventListener('click', () => S.selectedZoom && removeZoom(S.selectedZoom));
const ZOOMS = [1.25, 1.5, 2, 3];
const EASES = [['smooth', 'Smooth', 'gentle'], ['quick', 'Quick', ''], ['snap', 'Snap', 'punch in']];
$('#zoom-pick').addEventListener('click', (e) => {
  const z = selectedZoom();
  if (!z) return;
  const set = (patch) => { Object.assign(z, patch); S.tool = 'zoom'; syncAll(); };
  openMenu(e.currentTarget, [
    { title: 'Zoom in' },
    ...ZOOMS.map((v) => ({ label: `${v}×`, on: z.amount === v, run: () => set({ amount: v }) })),
    { input: { label: 'Custom ×', value: ZOOMS.includes(z.amount) ? '' : fmtSpeed(z.amount), placeholder: '1.1–8',
      apply: (t) => { const v = parseSpeed(t); if (!(v >= 1.05 && v <= 8)) return false; set({ amount: Math.round(v * 100) / 100 }); } } },
    '-',
    { title: 'Ease' },
    ...EASES.map(([v, label, hint]) => ({ label, hint, on: z.ease === v, run: () => set({ ease: v }) })),
  ]);
});
/** X / Y: move the zoom's centre to a pixel of the video. */
function bindZoomAxis(el, axis) {
  const commit = () => {
    const z = selectedZoom();
    const v = Number(el.value);
    if (z && isFinite(v)) {
      const [x, y] = zoomCenterPx(z);
      const W = S.info.width;
      const H = S.info.height;
      aimAt(z, (axis === 'x' ? v : x) / W, (axis === 'y' ? v : y) / H);
      renderZoomBox();
      updateExportInfo();
    }
    syncAll();
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Escape') el.value = ''; el.blur(); if (e.key === 'Escape') syncAll(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      el.value = Math.round(Number(el.value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
      commit();
    }
  });
}
bindZoomAxis($('#zoom-x'), 'x');
bindZoomAxis($('#zoom-y'), 'y');

// Speed multiplier: any value from 0.1× to 16× ("2", "0.25", "1/4", "3x").
const SPEED_MIN = 0.1;
const SPEED_MAX = 16;
function parseSpeed(text) {
  const t = String(text).trim().toLowerCase().replace(/[×x\s]/g, '').replace(',', '.');
  const frac = /^(\d*\.?\d+)\/(\d*\.?\d+)$/.exec(t);
  const v = frac ? Number(frac[1]) / Number(frac[2]) : Number(t);
  return isFinite(v) && v > 0 ? v : NaN;
}
function setSpeed(v) {
  S.slow.speed = Math.round(clamp(v, SPEED_MIN, SPEED_MAX) * 1000) / 1000;
  syncAll();
}
const SPEEDS = [0.25, 0.5, 0.75, 1.5, 2, 4];
$('#slow-add').addEventListener('click', addSlowAtPlayhead);
$('#slow-remove').addEventListener('click', () => { S.slow.enabled = false; syncAll(); });
$('#speed-pick').addEventListener('click', (e) => openMenu(e.currentTarget, [
  { title: 'Speed' },
  ...SPEEDS.map((v) => ({ label: `${v}×`, hint: describeSpeed(v), on: Math.abs(S.slow.speed - v) < 1e-6, run: () => setSpeed(v) })),
  { input: { label: 'Custom ×', value: SPEEDS.some((v) => Math.abs(S.slow.speed - v) < 1e-6) ? '' : fmtSpeed(S.slow.speed), placeholder: '0.1–16',
    apply: (t) => { const v = parseSpeed(t); if (!(v >= SPEED_MIN && v <= SPEED_MAX)) return false; setSpeed(v); } } },
  '-',
  { title: 'Sound' },
  { label: 'Keep', hint: 'natural pitch', on: !S.slow.muteAudio, run: () => { S.slow.muteAudio = false; syncAll(); } },
  { label: 'Mute', on: S.slow.muteAudio, run: () => { S.slow.muteAudio = true; syncAll(); } },
]));
bindTimeField($('#slow-start'), (t) => {
  S.slow.start = clamp(t, 0, S.slow.end - 0.1);
  syncAll();
});
bindTimeField($('#slow-end'), (t) => {
  S.slow.end = clamp(t, S.slow.start + 0.1, duration());
  syncAll();
});

// Freeze frames: hold one frame for a few seconds, then carry on (adds time; silent while held)
function addFreezeAtPlayhead() {
  if (!S.path) return;
  const f1 = 1 / fps();
  const at = clamp(Math.floor(currentT() * fps() + 1e-6) / fps(), S.inT, Math.max(S.inT, S.outT - f1));
  let f = S.freezes.find((x) => Math.abs(x.at - at) < f1 / 2);
  if (!f) {
    f = { id: uid(), at, hold: Number(settings.freezeHold) > 0 ? Number(settings.freezeHold) : 2 };
    S.freezes.push(f);
    S.freezes.sort((a, b) => a.at - b.at);
  }
  S.selectedFreeze = f.id;
  S.tool = 'freeze';
  video.pause();
  syncAll();
}
function removeFreeze(id) {
  S.freezes = S.freezes.filter((f) => f.id !== id);
  if (S.selectedFreeze === id) S.selectedFreeze = null;
  syncAll();
}
function selectedFreeze() { return S.freezes.find((f) => f.id === S.selectedFreeze) || null; }
$('#freeze-add').addEventListener('click', addFreezeAtPlayhead);
$('#freeze-add-another').addEventListener('click', addFreezeAtPlayhead);
$('#freeze-remove').addEventListener('click', () => S.selectedFreeze && removeFreeze(S.selectedFreeze));
const HOLDS = [0.5, 1, 2, 3, 5];
$('#freeze-pick').addEventListener('click', (e) => {
  const f = selectedFreeze();
  if (!f) return;
  const set = (v) => {
    f.hold = Math.round(clamp(v, 0.1, 60) * 100) / 100;
    settings.freezeHold = f.hold; // the next freeze starts with the same hold
    saveSettings();
    S.tool = 'freeze';
    syncAll();
  };
  openMenu(e.currentTarget, [
    { title: 'Hold the frame for' },
    ...HOLDS.map((v) => ({ label: `${v}s`, on: Math.abs(f.hold - v) < 1e-6, run: () => set(v) })),
    { input: { label: 'Seconds', value: HOLDS.includes(f.hold) ? '' : fmtSpeed(f.hold), placeholder: '0.1–60',
      apply: (t) => { const v = /^\s*\d*\.?\d+\s*$/.test(t) ? Number(t) : parseDuration(t); if (!(v >= 0.1 && v <= 60)) return false; set(v); } } },
  ]);
});
bindTimeField($('#freeze-at'), (t) => {
  const f = selectedFreeze();
  if (!f) return syncAll();
  f.at = clamp(Math.floor(t * fps() + 1e-6) / fps(), S.inT, Math.max(S.inT, S.outT - 1 / fps()));
  S.freezes.sort((a, b) => a.at - b.at);
  video.pause();
  seek(f.at + 0.5 / fps());
  syncAll();
});

// Sounds: the library lives in the Add menu (1–9 drop one at the playhead)
function openSoundMenu(anchor) {
  const items = library.map((item, i) => ({
    label: item.name,
    hint: i < 9 ? String(i + 1) : '',
    run: () => placeSound(item),
    extras: [
      { icon: 'play', title: 'Listen', run: () => previewLibrarySound(item) },
      { icon: 'x', title: 'Remove from this list', run: () => {
        library = library.filter((l) => l.id !== item.id);
        saveLibrary();
        closeMenu();
        openSoundMenu(anchor);
      } },
    ],
  }));
  if (!items.length) items.push({ title: 'No sounds yet. Add your own MP3 or WAV files' });
  items.push('-', { label: 'Choose sound files…', run: async () => addToLibrary(await invoke('pick_sounds')) });
  openMenu(anchor, items);
}
$('#sfx-add').addEventListener('click', (e) => openSoundMenu(e.currentTarget));
$('#sfx-vol-pick').addEventListener('click', (e) => {
  const s = S.sfx.find((x) => x.id === S.selectedSfx);
  if (s) openMenu(e.currentTarget, volumeItems(s.volume, (v) => { s.volume = v; syncAll(); }));
});
$('#sfx-item-remove').addEventListener('click', () => S.selectedSfx && removeSfx(S.selectedSfx));

$('#adv-toggle').addEventListener('click', (e) => {
  const adv = $('#advanced');
  adv.hidden = !adv.hidden;
  e.currentTarget.classList.toggle('open', !adv.hidden);
});

// Export sheet
$$('#save-seg button').forEach((b) => b.addEventListener('click', () => {
  S.save.mode = b.dataset.mode;
  S.confirmReplace = false;
  updateExportInfo();
}));
$('#save-name').addEventListener('input', (e) => {
  S.save.name = e.target.value;
  S.save.nameEdited = true;
  updateExportInfo();
});
$('#save-name').addEventListener('change', (e) => {
  if (!e.target.value.trim()) {
    S.save.name = defaultSaveName();
    S.save.nameEdited = false;
  }
  updateExportInfo();
});
$('#save-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.target.blur(); doExport(); }
});
$('#save-folder-change').addEventListener('click', async () => {
  const d = await invoke('pick_folder');
  if (d) { settings.outDir = d; saveSettings(); updateExportInfo(); }
});
$('#save-folder-reset').addEventListener('click', () => { settings.outDir = ''; saveSettings(); updateExportInfo(); });
$('#exact').addEventListener('change', (e) => {
  S.exact = e.target.checked;
  syncAll();
});
$('#set-quality').addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); updateExportInfo(); });
$('#set-encoder').addEventListener('change', (e) => { settings.encoder = e.target.value; saveSettings(); updateExportInfo(); });
$('#btn-export').addEventListener('click', onExportButton);
$('#btn-cancel').addEventListener('click', cancelJob);

// Keyboard
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' && !['range', 'checkbox'].includes(e.target.type);
  const ctrl = e.ctrlKey || e.metaKey;
  if (document.querySelector('dialog[open]')) return;
  if (popMenu && e.key === 'Escape') { e.preventDefault(); return closeMenu(); }

  if (ctrl && (e.key === 's' || e.key === 'e')) { e.preventDefault(); if (S.mode !== 'edit') setMode('edit'); return doExport(); }
  if (ctrl && e.key === 'o') { e.preventDefault(); return pickAndOpen(); }
  if (e.key === 'Escape' && S.confirmReplace) { S.confirmReplace = false; return updateExportInfo(); }
  if (typing || tag === 'select' || ctrl || e.altKey) return;

  const k = e.key;
  const handled = () => e.preventDefault();
  if (k === 'w' || k === 'W') return setMode('watch');
  if (k === 'e' || k === 'E') return setMode('edit');
  if (S.mode === 'watch') return watchKey(e, k, handled);
  if (k === ' ' || k === 'k' || k === 'K') { handled(); togglePlay(); }
  else if (k === 'ArrowLeft') { handled(); e.shiftKey ? seek(currentT() - 1) : step(-1); }
  else if (k === 'ArrowRight') { handled(); e.shiftKey ? seek(currentT() + 1) : step(1); }
  else if (k === 'j' || k === 'J') seek(currentT() - (e.shiftKey ? 10 : 5));
  else if (k === 'l' || k === 'L') seek(currentT() + (e.shiftKey ? 10 : 5));
  else if (k === 'i' || k === 'I') setIn(currentT());
  else if (k === 'o' || k === 'O') setOut(currentT());
  else if (k === 'Home') { handled(); seek(S.inT); }
  else if (k === 'End') { handled(); seek(S.outT); }
  else if (k === 'x' || k === 'X') { S.inT = 0; S.outT = duration(); afterTrimChange(); }
  else if (k === 's' || k === 'S') addSlowAtPlayhead();
  else if (k === 'h' || k === 'H') addFreezeAtPlayhead();
  else if (k === 't' || k === 'T') setTool('trim');
  else if (k === 'm' || k === 'M') setTool('slow');
  else if (k === 'n' || k === 'N') setTool('sound');
  else if (k === 'a' || k === 'A') setTool('amp');
  else if (k === 'p' || k === 'P') openSplit();
  else if (k === 'PageUp') { handled(); gotoSibling(-1); }
  else if (k === 'PageDown') { handled(); gotoSibling(1); }
  else if (k === 'Delete' || k === 'Backspace') {
    if (S.tool === 'freeze' && S.selectedFreeze) removeFreeze(S.selectedFreeze);
    else if (S.tool === 'zoom' && S.selectedZoom) removeZoom(S.selectedZoom);
    else if (S.selectedSfx) removeSfx(S.selectedSfx);
  }
  else if (k === 'f' || k === 'F') zoomToSelection();
  else if (k === 'z' || k === 'Z') setTool('zoom');
  else if (k === '+' || k === '=') zoom(0.5);
  else if (k === '-' || k === '_') zoom(2);
  else if (k === '0') setView(0, duration());
  else if (k === '?') $('#help').showModal();
  else if (/^[1-9]$/.test(k)) {
    const item = library[Number(k) - 1];
    if (item) placeSound(item);
    else { setTool('sound'); toast(`No sound #${k} yet. Add some with "Add sounds"`); }
  }
});

// Blur buttons after click so Space keeps meaning play/pause.
document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });

// Drag & drop files onto the window
T.webview.getCurrentWebview().onDragDropEvent(async (e) => {
  const p = e.payload;
  $('#drop-target').hidden = !(p.type === 'enter' || p.type === 'over');
  if (p.type !== 'drop' || !p.paths?.length) return;
  const [videos, audio] = await invoke('classify', { paths: p.paths });
  if (audio.length) addToLibrary(audio);
  if (videos.length) openVideo(videos[0]);
  else if (!audio.length) toast("That file type isn't supported");
});

// Startup
syncAll();
invoke('startup_file').then((p) => p && openVideo(p));
