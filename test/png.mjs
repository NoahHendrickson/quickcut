import zlib from 'node:zlib';
// Minimal PNG decoder (8-bit RGB/RGBA) for measuring screenshots.
export function PNG(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), ct = buf[25];
  const chunks = []; let p = 8;
  while (p < buf.length) { const n = buf.readUInt32BE(p); const t = buf.toString('ascii', p + 4, p + 8); if (t === 'IDAT') chunks.push(buf.subarray(p + 8, p + 8 + n)); p += 12 + n; }
  const raw = zlib.inflateSync(Buffer.concat(chunks)); const bpp = ct === 6 ? 4 : 3; const stride = w * bpp;
  const d = Buffer.alloc(w * h * 4); let prev = Buffer.alloc(stride); let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q]; const line = Buffer.from(raw.subarray(q + 1, q + 1 + stride)); q += 1 + stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255; else if (f === 2) line[x] = (line[x] + b) & 255; else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
    }
    for (let x = 0; x < w; x++) { d[(y * w + x) * 4] = line[x * bpp]; d[(y * w + x) * 4 + 1] = line[x * bpp + 1]; d[(y * w + x) * 4 + 2] = line[x * bpp + 2]; }
    prev = line;
  }
  return { w, h, d, scale: Number(process.env.DPR || 2) };
}
