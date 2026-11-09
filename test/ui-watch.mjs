// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server, errors, SHOTS } = await startApp();
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
