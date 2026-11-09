// Runs the real QuickCut frontend in Chrome with a mock Tauri bridge that
// executes the same commands the Rust backend does (real ffprobe/ffmpeg).
import { startApp } from './harness.mjs';

const { page, browser, server, errors, SHOTS } = await startApp();
await page.waitForFunction(() => typeof window.__dropHandler === 'function', null, { timeout: 20000 });
await page.evaluate((p) => window.__dropHandler({ payload: { type: 'drop', paths: [p] } }), '/tmp/qc-test/src.mp4');
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
const idle = () => page.evaluate(() => document.body.classList.contains('idle'));
const hiddenAfter = async () => { const t0 = Date.now(); await page.waitForFunction(() => document.body.classList.contains('idle'), null, { timeout: 5000 }); return Date.now() - t0; };
const frame = await page.evaluate(() => { const r = document.querySelector('#vframe').getBoundingClientRect(); const s = document.querySelector('#stage').getBoundingClientRect(); return { videoH: Math.round(r.height), stageH: Math.round(s.height), winH: innerHeight }; });
console.log('video gets the whole window:', frame.stageH === frame.winH, JSON.stringify(frame));
await page.mouse.move(600, 300);
console.log('paused, still mouse   -> hidden after', await hiddenAfter(), 'ms');
await page.screenshot({ path: `${SHOTS}/74-dock-hidden.png` });
const t0 = Date.now(); await page.mouse.move(610, 305); const back = !(await idle());
console.log('mouse moves           -> back immediately:', back, `(${Date.now() - t0} ms)`);
await page.waitForTimeout(150);
await page.screenshot({ path: `${SHOTS}/75-dock-shown.png` });
await page.keyboard.press('Space');
console.log('playing, still mouse  -> hidden after', await hiddenAfter(), 'ms');
await page.keyboard.press('Space');
await hiddenAfter(); // (the key press itself brought it back)
// Fake "moves" with the cursor standing still must not bring it back
await page.mouse.move(610, 305); // same spot: Chrome delivers a duplicate 'move' here
console.log('cursor standing still  -> stays hidden:', await idle());
// Hovering the bar keeps it
const bar = await page.locator('#watchbar').boundingBox();
await page.mouse.move(bar.x + 300, bar.y + bar.height / 2);
await page.waitForTimeout(1600);
console.log('mouse resting on bar  -> still shown after 1.6s:', !(await idle()));
// Leaving the window hides it right away
await page.mouse.move(600, 300); await page.waitForTimeout(50);
const t1 = Date.now();
await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null })));
await page.waitForFunction(() => document.body.classList.contains('idle'), null, { timeout: 2000 });
console.log('mouse leaves window   -> hidden after', Date.now() - t1, 'ms');
// Quick trim: the bar is in use, never hides
await page.mouse.move(620, 310); await page.keyboard.press('t'); await page.waitForTimeout(1500);
console.log('quick trimming        -> stays shown:', !(await idle()));
await page.keyboard.press('Escape');
console.log('errors:', JSON.stringify(errors));
await browser.close(); server.close();
