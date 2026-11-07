// Generates the seek-bar anchor shapes used in src/style.css (#w-h-in/#w-h-out/#w-la/#w-lb).
// Change W/H/F (fillet radius) or the colours, run `node scripts/anchor-shapes.cjs`, and paste the urls.

// Anchor shapes: a 14x22 body (5px corners) whose inner side flows into the 6px line through
// concave 3px fillets and a 3px neck. Output: CSS data-URL backgrounds, start + end (mirrored).
const W = 14, H = 22, R = 5, F = 3, NECK = 3, LINE = 6; // R <= (H - LINE) / 2 - F, or the corner meets the fillet
const LT = (H - LINE) / 2, LB = LT + LINE; // the line, centred on the body
function path(mirror) {
  // Drawn for the START anchor (body x 0..10, neck to the right up to x=13), then mirrored for the end.
  const X = (x) => (mirror ? W + NECK - x : x);
  const p = [
    `M${X(R)} 0`, `H${X(W - R)}`,
    `Q${X(W)} 0 ${X(W)} ${R}`,           // top-right convex corner
    `V${LT - F}`,                        // down to where the fillet starts
    `A${F} ${F} 0 0 ${mirror ? 1 : 0} ${X(W + F)} ${LT}`, // concave fillet into the line's top edge
    `H${X(W + NECK)}`, `V${LB}`, `H${X(W + F)}`,
    `A${F} ${F} 0 0 ${mirror ? 1 : 0} ${X(W)} ${LB + F}`, // concave fillet from the line's bottom edge
    `V${H - R}`, `Q${X(W)} ${H} ${X(W - R)} ${H}`,
    `H${X(R)}`, `Q${X(0)} ${H} ${X(0)} ${H - R}`, `V${R}`, `Q${X(0)} 0 ${X(R)} 0`, 'Z',
  ];
  return p.join(' ');
}
// Solid fill, the same colour as the line it flows into.
function svg(mirror, color) {
  const s = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W + NECK} ${H}'><path fill='${color}' d='${path(mirror)}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(s).replace(/'/g, '%27')}")`;
}
const colors = {
  trim: '#2a86ff', trimHover: '#4796ff',
  loop: '#f5c46a', loopHover: '#f8d38c',
};
const out = {};
for (const [k, c] of Object.entries(colors)) out[k] = { start: svg(false, c), end: svg(true, c) };
module.exports = out;
if (require.main === module) {
  const fs = require('fs');
  // Preview sheet at 8x on the bar's colours
  const cell = (u, line) => `<div style="position:relative;width:200px;height:200px;background:#b9b6a8"><div style="position:absolute;left:0;right:0;top:${9*8}px;height:${6*8}px;background:${line}"></div><div style='position:absolute;left:${(100-5*8)}px;top:${3*8}px;width:${13*8}px;height:${18*8}px;background:${u} 0 0/100% 100%'></div></div>`;
  fs.writeFileSync('/tmp/hi/anchor-sheet.html', `<body style="margin:0;display:flex;gap:10px;padding:10px;background:#333">${cell(out.trim.start, '#2a86ff')}${cell(out.trim.end, '#2a86ff')}${cell(out.loop.start, '#f5c46a')}${cell(out.loop.end, '#f5c46a')}</body>`);
}
