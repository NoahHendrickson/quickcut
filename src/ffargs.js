// Pure ffmpeg command building. No DOM or Tauri APIs, so it is unit-testable in Node.
//
// Quality strategy:
//   * Trim only            -> stream copy: the video AND audio bits are untouched.
//                             The start snaps to the keyframe at/before the in-point.
//   * Trim + sound effects -> video stream copied untouched, only audio re-encoded.
//   * Slow motion / exact  -> video re-encoded at near-lossless quality, on the GPU if possible.

export const ENCODERS = {
  h264: { nvenc: 'h264_nvenc', amf: 'h264_amf', qsv: 'h264_qsv', cpu: 'libx264' },
  hevc: { nvenc: 'hevc_nvenc', amf: 'hevc_amf', qsv: 'hevc_qsv', cpu: 'libx265' },
  av1: { nvenc: 'av1_nvenc', amf: 'av1_amf', qsv: 'av1_qsv', cpu: null },
};

export const ENCODER_CANDIDATES = [
  ...new Set(Object.values(ENCODERS).flatMap((f) => Object.values(f)).filter(Boolean)),
];

export const VENDOR_LABEL = { nvenc: 'NVIDIA GPU', amf: 'AMD GPU', qsv: 'Intel GPU', cpu: 'CPU' };

// Constant-quality levels. Lower = better. "high" is visually lossless for
// gameplay/camera footage; "max" is for when file size doesn't matter at all.
export const QUALITY = {
  high: { cpu264: 16, cpu265: 18, hw: 18 },
  max: { cpu264: 12, cpu265: 14, hw: 14 },
};

const COPY_EXTS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'ts', 'm2ts', 'mts'];
const EPS = 0.001;

const fmt = (n) => (Math.round(n * 1e6) / 1e6).toString();

/** Summarise ffprobe JSON into what the editor needs. */
export function parseProbe(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const streams = data.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const rate = (r) => {
    if (!r || r === '0/0') return 0;
    const [a, b] = r.split('/').map(Number);
    return b ? a / b : a;
  };
  const fps = v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30 : 30;
  // Phone videos store rotation as metadata; ffmpeg auto-rotates, so swap W/H for 90°.
  const rotation = v ? Math.abs(Number((v.side_data_list || []).find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0)) % 180 : 0;
  const pixfmt = (v && v.pix_fmt) || '';
  const bitDepth = /p1[02]|10le|12le|p010/.test(pixfmt) ? 10 : 8;
  const fmtInfo = data.format || {};
  const formatName = fmtInfo.format_name || '';
  const duration = Number(fmtInfo.duration) || Number(v && v.duration) || 0;
  return {
    duration,
    start: Number(fmtInfo.start_time) || 0,
    size: Number(fmtInfo.size) || 0,
    bitrate: Number(fmtInfo.bit_rate) || 0,
    hasVideo: !!v,
    vcodec: v ? v.codec_name : null,
    width: v ? (rotation === 90 ? v.height : v.width) : 0,
    height: v ? (rotation === 90 ? v.width : v.height) : 0,
    fps,
    pixfmt,
    bitDepth,
    hdr: !!v && ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
    audioCount: audio.length,
    audioCodec: audio[0] ? audio[0].codec_name : null,
    sampleRate: audio[0] ? Number(audio[0].sample_rate) || 48000 : 48000,
    // MP4/MOV seek by PTS. For other containers ffmpeg pulls the seek point back
    // ~0.13s when the video has B-frames, so lossless cuts must aim a bit later.
    seekToPts: /(^|,)(mov|mp4)(,|$)/.test(formatName),
  };
}

/** Pick the encoder family to match the source, then the best available vendor. */
export function pickEncoder(src, available, pref = 'auto') {
  let family = src.vcodec === 'hevc' ? 'hevc' : src.vcodec === 'av1' ? 'av1' : 'h264';
  if (family === 'h264' && src.bitDepth > 8) family = 'hevc'; // keep 10-bit / HDR
  const vendors = pref === 'cpu' ? ['cpu'] : ['nvenc', 'amf', 'qsv', 'cpu'];
  const families = family === 'av1' ? ['av1', 'hevc'] : [family];
  for (const fam of families) {
    for (const vendor of vendors) {
      const name = ENCODERS[fam][vendor];
      if (name && available.includes(name)) return { name, vendor, family: fam };
    }
  }
  return { name: 'libx264', vendor: 'cpu', family: 'h264' };
}

export function encoderArgs(enc, quality, ext) {
  const q = QUALITY[quality] || QUALITY.high;
  let a;
  switch (enc.vendor) {
    case 'nvenc':
      a = ['-c:v', enc.name, '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', q.hw, '-b:v', '0'];
      break;
    case 'amf':
      a = ['-c:v', enc.name, '-quality', 'quality', '-rc', 'cqp', '-qp_i', q.hw, '-qp_p', q.hw + 2];
      if (enc.family === 'h264') a.push('-qp_b', q.hw + 2);
      break;
    case 'qsv':
      a = ['-c:v', enc.name, '-preset', 'slow', '-global_quality', q.hw];
      break;
    default:
      a =
        enc.name === 'libx265'
          ? ['-c:v', 'libx265', '-preset', 'medium', '-crf', q.cpu265, '-x265-params', 'log-level=error']
          : ['-c:v', 'libx264', '-preset', 'medium', '-crf', q.cpu264];
  }
  if (enc.family === 'hevc' && ['mp4', 'mov', 'm4v'].includes(ext)) a.push('-tag:v', 'hvc1');
  return a.map(String);
}

/** atempo only accepts 0.5..2 per instance, so chain it for bigger changes. */
export function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s < 0.5 - 1e-9) {
    parts.push(0.5);
    s /= 0.5;
  }
  while (s > 2 + 1e-9) {
    parts.push(2);
    s /= 2;
  }
  if (Math.abs(s - 1) > 1e-9 || parts.length === 0) parts.push(Math.round(s * 1e6) / 1e6);
  return parts.map((p) => `atempo=${p}`).join(',');
}

// Keyframe lists are [[pts, dts], ...] (seconds from file start) as returned by
// the backend; plain numbers (pts only) are accepted too.
const kPts = (k) => (Array.isArray(k) ? k[0] : k);

// ---------------------------------------------------------------------------
// Zoom effect (After Effects-style punch-in: ease in, hold, ease out)
// ---------------------------------------------------------------------------
// A zoom: { start, end, amount, fx, fy, ease } in source seconds. (fx, fy) is the
// anchor in 0..1 frame coordinates: that point stays put while everything
// scales around it, exactly like scaling a layer around its anchor point in AE.

export const ZOOM_EASES = { smooth: 0.6, quick: 0.3, snap: 0.12 }; // ramp seconds

/** Ramp length for a zoom, never more than half its length. */
export const zoomRamp = (z) => Math.min(ZOOM_EASES[z.ease] ?? ZOOM_EASES.smooth, (z.end - z.start) / 2);

/** Smootherstep: zero velocity and acceleration at both ends, like AE "Easy Ease". */
const ease = (p) => p * p * p * (p * (p * 6 - 15) + 10);

/** Zoom state at source time t: { scale, fx, fy }. */
export function zoomAt(zooms, t) {
  for (const z of zooms || []) {
    if (t <= z.start || t >= z.end) continue;
    const r = zoomRamp(z);
    const p = Math.min(1, (t - z.start) / r, (z.end - t) / r);
    return { scale: 1 + (z.amount - 1) * ease(Math.max(0, p)), fx: z.fx, fy: z.fy };
  }
  return { scale: 1, fx: 0.5, fy: 0.5 };
}

/**
 * Filter graph that applies the zooms (times relative to the output's t=0),
 * from label `inp` to label `out`. Each frame is scaled up and laid onto a
 * fixed W×H canvas at an offset that keeps the anchor point still. Positions
 * round at output resolution (<= 1px) and 10-bit / HDR stays 10-bit.
 * (crop can't be used: it clamps to the first frame's size.)
 */
export function zoomGraph(zooms, w, h, inp, out, pixfmt = '') {
  const parts = zooms.map((z) => {
    const r = fmt(zoomRamp(z));
    return `st(0,clip((t-${fmt(z.start)})/${r},0,1));st(1,clip((${fmt(z.end)}-t)/${r},0,1));` +
      `st(2,max(min(ld(0),ld(1)),0)*between(t,${fmt(z.start)},${fmt(z.end)}));` +
      `st(3,ld(3)+${fmt(z.amount - 1)}*ld(2)*ld(2)*ld(2)*(ld(2)*(ld(2)*6-15)+10))`;
  });
  const Z = `(st(3,1);${parts.join(';')};ld(3))`;
  const anchor = (k) => zooms.map((z) => `between(t,${fmt(z.start)},${fmt(z.end)})*${fmt(z[k])}`).join('+');
  const sw = `2*trunc(${w}*${Z}/2)`;
  const sh = `2*trunc(${h}*${Z}/2)`;
  return `${inp}split[zbase][zsrc];` +
    `[zsrc]scale=w='${sw}':h='${sh}':eval=frame:flags=bicubic[zbig];` +
    `[zbase][zbig]overlay=x='-(${sw}-${w})*(${anchor('fx')})':y='-(${sh}-${h})*(${anchor('fy')})':eval=frame:format=auto` +
    // overlay may pick a format with alpha; go back to the source's own format.
    `${/^[a-z0-9]+$/.test(pixfmt) ? `,format=${pixfmt}` : ''}${out}`;
}

/** Choose the keyframe the lossless cut will actually start on. */
export function snapToKeyframe(keyframes, t) {
  if (!keyframes || !keyframes.length) return 0;
  let best = null;
  for (const k of keyframes.map(kPts)) if (k <= t + 0.0005 && (best === null || k > best)) best = k;
  return best === null ? Math.min(...keyframes.map(kPts)) : best;
}

/**
 * Work out how an export will be done.
 * edit = { inT, outT, exact, keyframeIn, slow:{enabled,start,end,speed,muteAudio},
 *          sfx:[{path,at,volume}], origVolume }
 */
export function planExport(src, edit) {
  const slowOn =
    !!edit.slow &&
    edit.slow.enabled &&
    Math.abs(edit.slow.speed - 1) > 1e-6 &&
    Math.min(edit.slow.end, edit.outT) - Math.max(edit.slow.start, edit.inT) > 0.01;
  const zoomsIn = (edit.zooms || []).filter((z) => z.amount > 1.001 && z.end > edit.inT && z.start < edit.outT);
  const copyVideo = !slowOn && !edit.exact && zoomsIn.length === 0 && src.hasVideo;
  const reasons = [];
  if (slowOn) reasons.push(edit.slow.speed < 1 ? 'slow motion' : 'speed-up');
  if (zoomsIn.length) reasons.push('zoom');
  if (edit.exact) reasons.push('frame-exact start');

  const start = copyVideo ? Math.min(edit.keyframeIn ?? edit.inT, edit.inT) : edit.inT;
  const dur = Math.max(0, edit.outT - start);

  // Speed segments in output-relative time (0 = start).
  const segments = [];
  if (slowOn) {
    const a = Math.max(0, Math.min(dur, edit.slow.start - start));
    const b = Math.max(0, Math.min(dur, edit.slow.end - start));
    if (a > EPS) segments.push({ from: 0, to: a, speed: 1 });
    segments.push({ from: a, to: b, speed: edit.slow.speed, slow: true });
    if (dur - b > EPS) segments.push({ from: b, to: dur, speed: 1 });
  } else {
    segments.push({ from: 0, to: dur, speed: 1 });
  }
  const outDuration = segments.reduce((acc, s) => acc + (s.to - s.from) / s.speed, 0);

  // Map a source timestamp to output time.
  const mapTime = (t) => {
    const rel = t - start;
    let acc = 0;
    for (const s of segments) {
      if (rel <= s.to + 1e-9) return acc + Math.max(0, rel - s.from) / s.speed;
      acc += (s.to - s.from) / s.speed;
    }
    return acc;
  };

  const sfx = (edit.sfx || [])
    .map((s) => ({ ...s, outAt: mapTime(s.at) }))
    .filter((s) => s.at >= start - 1e-6 && s.outAt < outDuration - 0.01 && s.volume > 0);

  const origVolume = edit.origVolume ?? 1;
  const audioProcessed =
    sfx.length > 0 || Math.abs(origVolume - 1) > 1e-6 || (slowOn && src.audioCount > 0);
  const mergesTracks = audioProcessed && src.audioCount > 1;

  let ext = (src.ext || 'mp4').toLowerCase();
  if (copyVideo) {
    if (!COPY_EXTS.includes(ext)) ext = 'mkv';
    if (audioProcessed && ext === 'webm') ext = 'mkv'; // AAC can't go in WebM
  } else {
    ext = ext === 'mkv' ? 'mkv' : ext === 'mov' ? 'mov' : 'mp4';
  }

  let mode, summary;
  if (copyVideo && !audioProcessed) {
    mode = 'copy';
    summary = 'Lossless: video and audio copied untouched';
  } else if (copyVideo) {
    mode = 'copy-video';
    summary = 'Lossless video (copied untouched), audio remixed';
  } else {
    mode = 'reencode';
    summary = `High-quality re-encode (${reasons.join(' + ') || 'required'})`;
  }

  return {
    // Zooms relative to the output's start (before any slow-mo is applied).
    zooms: zoomsIn.map((z) => ({ ...z, start: z.start - start, end: z.end - start })),
    mode, summary, reasons, start, dur, outDuration, segments, sfx, ext,
    audioProcessed, mergesTracks, origVolume, slowOn,
    muteSlow: slowOn && !!edit.slow.muteAudio,
    snapDelta: copyVideo ? edit.inT - start : 0,
    // How far past the keyframe to put -ss so ffmpeg lands exactly on it.
    seekPad: copyVideo ? (src.seekToPts ? 0.001 : 0.135) : 0,
    // Where stream copy stops reading. When the out-point is the next part's
    // keyframe, stop just before that keyframe's decode time so B-frame
    // reordering can't pull it (and its neighbours) into this part.
    copyEnd: copyVideo && edit.endDts != null && edit.endDts <= edit.outT ? edit.endDts - 0.0005 : edit.outT,
  };
}

/** Build the audio part of a filter graph. Returns { graph: string[], label } or null. */
function audioGraph(src, plan, audioInput, sfxInputBase) {
  const g = [];
  let label;
  if (src.audioCount === 0) {
    g.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${fmt(plan.outDuration)}[abase]`);
    label = 'abase';
  } else if (src.audioCount === 1) {
    label = `${audioInput}:a:0`;
  } else {
    const ins = Array.from({ length: src.audioCount }, (_, i) => `[${audioInput}:a:${i}]`).join('');
    g.push(`${ins}amix=inputs=${src.audioCount}:duration=longest:normalize=0[amerged]`);
    label = 'amerged';
  }

  if (plan.slowOn && src.audioCount > 0) {
    const n = plan.segments.length;
    const outs = plan.segments.map((_, i) => `as${i}`);
    g.push(n > 1 ? `[${label}]asplit=${n}${outs.map((o) => `[${o}in]`).join('')}` : `[${label}]anull[as0in]`);
    plan.segments.forEach((s, i) => {
      const trim = i === n - 1 ? `atrim=start=${fmt(s.from)}` : `atrim=start=${fmt(s.from)}:end=${fmt(s.to)}`;
      let chain = `[${outs[i]}in]${trim},asetpts=PTS-STARTPTS`;
      if (s.speed !== 1) chain += `,${atempoChain(s.speed)}`;
      if (s.slow && plan.muteSlow) chain += ',volume=0';
      g.push(`${chain}[${outs[i]}]`);
    });
    g.push(`${outs.map((o) => `[${o}]`).join('')}concat=n=${n}:v=0:a=1[aslow]`);
    label = 'aslow';
  }

  if (Math.abs(plan.origVolume - 1) > 1e-6) {
    g.push(`[${label}]volume=${fmt(plan.origVolume)}[avol]`);
    label = 'avol';
  }

  if (plan.sfx.length) {
    const mixIns = [`[${label}]`];
    plan.sfx.forEach((s, i) => {
      const ms = Math.max(0, Math.round(s.outAt * 1000));
      g.push(`[${sfxInputBase + i}:a]volume=${fmt(s.volume)},adelay=${ms}:all=1[sfx${i}]`);
      mixIns.push(`[sfx${i}]`);
    });
    g.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:duration=first:dropout_transition=0:normalize=0[aout]`);
    label = 'aout';
  }

  if (!g.length) return null;
  return { graph: g, label };
}

/** Full ffmpeg argument list for an export. */
export function buildExportArgs(src, plan, opts) {
  const { inputPath, outputPath, encoder, quality = 'high' } = opts;
  const args = ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];

  const end = plan.copyEnd ?? plan.start + plan.dur;
  let audioInput = 0;
  if (plan.mode === 'reencode') {
    args.push('-hwaccel', 'auto', '-ss', fmt(plan.start), '-t', fmt(plan.dur), '-i', inputPath);
  } else {
    // Stream copy: aim just past the keyframe so the demuxer lands exactly on it.
    const ss = plan.start + plan.seekPad;
    if (plan.mode === 'copy-video') {
      // Shift the copied video back so it starts at 0 like the decoded audio input.
      args.push('-itsoffset', fmt(plan.seekPad));
    }
    args.push('-ss', fmt(ss), '-t', fmt(end - ss), '-i', inputPath);
    if (plan.mode === 'copy-video' && src.audioCount > 0) {
      // Decoded audio seeks sample-accurately, so give it its own input starting
      // exactly on the keyframe the video copy starts on.
      args.push('-ss', fmt(plan.start), '-t', fmt(plan.dur), '-i', inputPath);
      audioInput = 1;
    }
  }
  const sfxBase = audioInput + 1;
  plan.sfx.forEach((s) => args.push('-i', s.path));

  const graph = [];
  let vMap = '0:V:0';
  let vSrc = '[0:V:0]';
  if (plan.mode === 'reencode' && plan.zooms && plan.zooms.length) {
    graph.push(zoomGraph(plan.zooms, src.width, src.height, '[0:V:0]', '[vzoom]', src.pixfmt));
    vSrc = '[vzoom]';
    vMap = '[vzoom]';
  }
  if (plan.mode === 'reencode' && plan.slowOn) {
    const n = plan.segments.length;
    graph.push(
      n > 1
        ? `${vSrc}split=${n}${plan.segments.map((_, i) => `[vs${i}in]`).join('')}`
        : `${vSrc}null[vs0in]`,
    );
    plan.segments.forEach((s, i) => {
      const trim = i === n - 1 ? `trim=start=${fmt(s.from)}` : `trim=start=${fmt(s.from)}:end=${fmt(s.to)}`;
      // Sped-up parts drop frames back to the source frame rate instead of
      // packing them in (a 60 fps clip at 4x would otherwise become 240 fps).
      const pts = s.speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${fmt(s.speed)}${s.speed > 1 ? `,fps=${fmt(src.fps || 30)}` : ''}`;
      graph.push(`[vs${i}in]${trim},setpts=${pts}[vs${i}]`);
    });
    graph.push(`${plan.segments.map((_, i) => `[vs${i}]`).join('')}concat=n=${n}:v=1:a=0[vout]`);
    vMap = '[vout]';
  }

  let aMap = null;
  if (plan.audioProcessed) {
    const ag = audioGraph(src, plan, audioInput, sfxBase);
    if (ag) {
      graph.push(...ag.graph);
      aMap = ag.label.includes(':') ? ag.label : `[${ag.label}]`;
    }
  }

  if (graph.length) args.push('-filter_complex', graph.join(';'));

  if (src.hasVideo) args.push('-map', vMap);
  if (aMap) args.push('-map', aMap);
  else if (src.audioCount > 0) args.push('-map', '0:a?');

  if (plan.mode === 'reencode') {
    args.push(...encoderArgs(encoder, quality, plan.ext));
    if (plan.slowOn) args.push('-fps_mode', 'vfr');
  } else {
    args.push('-c:v', 'copy');
  }

  if (aMap || (plan.mode === 'reencode' && src.audioCount > 0 && plan.audioProcessed)) {
    args.push('-c:a', 'aac', '-b:a', '320k');
  } else if (src.audioCount > 0) {
    args.push('-c:a', 'copy');
  }

  args.push('-map_metadata', '0', '-map_chapters', '-1');
  if (plan.mode !== 'reencode') args.push('-avoid_negative_ts', 'make_zero');
  if (['mp4', 'mov', 'm4v'].includes(plan.ext)) args.push('-movflags', '+faststart');
  args.push('-max_muxing_queue_size', '4096');
  args.push(outputPath);
  return args;
}

/** Low-res, keyframe-dense preview copy for videos the webview can't play (e.g. some HEVC). */
export function buildProxyArgs(inputPath, outputPath) {
  return [
    '-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-hwaccel', 'auto', '-i', inputPath,
    '-map', '0:V:0', '-map', '0:a:0?',
    '-vf', "scale=-2:'min(720,ih)',format=yuv420p",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-g', '15',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    outputPath,
  ];
}

export function formatTime(t, withMs = true) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  const base = h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  return withMs ? `${base}.${String(ms).padStart(3, '0')}` : base;
}

/** Parse "1:23.4", "83.4", "1:02:03" into seconds. */
export function parseTime(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (!parts.length || parts.some((p) => !isFinite(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// ---------------------------------------------------------------------------
// Splitting into parts
// ---------------------------------------------------------------------------

/** n-1 evenly spaced split points inside [inT, outT]. */
export function evenSplitPoints(inT, outT, n) {
  const pts = [];
  for (let i = 1; i < n; i++) pts.push(inT + ((outT - inT) * i) / n);
  return pts;
}

/**
 * Nearest keyframe to t, strictly inside (lo, hi), as {t: pts, dts}.
 * Falls back to {t, dts: null} when there is none in range.
 */
export function nearestKeyframe(keyframes, t, lo, hi) {
  let best = null;
  for (const k of keyframes || []) {
    const pts = kPts(k);
    if (pts <= lo + 0.01 || pts >= hi - 0.01) continue;
    if (best === null || Math.abs(pts - t) < Math.abs(best.t - t)) best = { t: pts, dts: Array.isArray(k) ? k[1] : pts };
  }
  return best || { t, dts: null };
}

/**
 * Turn split points into [{index, inT, outT}] parts. Points are sorted, clamped
 * to the range, and points closer than minGap to a neighbour are dropped (e.g.
 * two points that snapped to the same keyframe).
 */
export function partsFromPoints(inT, outT, points, minGap = 0.05) {
  const cuts = [inT];
  for (const p of [...points].sort((a, b) => a - b)) {
    if (p - cuts[cuts.length - 1] >= minGap && outT - p >= minGap) cuts.push(p);
  }
  cuts.push(outT);
  const parts = [];
  for (let i = 0; i < cuts.length - 1; i++) parts.push({ index: i + 1, inT: cuts[i], outT: cuts[i + 1] });
  return parts;
}
