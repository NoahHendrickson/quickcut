// Runs the test/ui-*.mjs scripts one after another (npm run test:ui): each drives the real
// frontend in headless Chrome against a mock backend that runs real ffmpeg (see harness.mjs).
// A script fails when it exits non-zero: a step timed out, a check failed, or the page
// logged an error (which includes anything the app's Content-Security-Policy blocked).
//
//   node test/run-ui.mjs            all of them
//   node test/run-ui.mjs flow split only test/ui-flow.mjs and test/ui-split.mjs
//
// Needs Google Chrome, ffmpeg, and the clips from test/make-media.sh in /tmp/qc-test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = '/tmp/qc-test';
if (!fs.existsSync(`${MEDIA}/src.mp4`)) {
  console.error(`No test media in ${MEDIA}. Run: sh test/make-media.sh ${MEDIA}`);
  process.exit(1);
}

// The same starting point every time: the scripts save next to their source clip, and
// leftovers from an earlier run would change the names (and the counts) they see.
function resetFixtures() {
  for (const f of fs.readdirSync(MEDIA)) if (/^(src|work)_(edit|part)/.test(f)) fs.rmSync(path.join(MEDIA, f));
  fs.rmSync(`${MEDIA}/trash`, { recursive: true, force: true });
  fs.copyFileSync(`${MEDIA}/src.mp4`, `${MEDIA}/work.mp4`); // ui-flow replaces this one
  fs.rmSync('/tmp/qc-split', { recursive: true, force: true }); // ui-split splits in here
  fs.mkdirSync('/tmp/qc-split', { recursive: true });
  fs.copyFileSync(`${MEDIA}/src.mp4`, '/tmp/qc-split/src.mp4');
  fs.mkdirSync('/tmp/hi', { recursive: true }); // close-up screenshots
}

const only = process.argv.slice(2);
const scripts = fs.readdirSync(here).filter((f) => /^ui-.*\.mjs$/.test(f)).sort()
  .filter((f) => !only.length || only.some((o) => f === `ui-${o}.mjs` || f === o));
if (!scripts.length) {
  console.error(`No script matches ${only.join(', ')}`);
  process.exit(1);
}

const failed = [];
for (const f of scripts) {
  resetFixtures();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, f)], { encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 26 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  // Checks a script makes are worth seeing either way; the full log only when it failed.
  const lines = out.trimEnd().split('\n');
  for (const l of ok ? lines.filter((x) => /^(PASS|FAIL) /.test(x)) : lines) console.log(`      ${l.slice(0, 400)}`);
  if (!ok) failed.push(f);
}
console.log(failed.length ? `\n${failed.length} of ${scripts.length} failed: ${failed.join(', ')}` : `\nAll ${scripts.length} passed`);
process.exit(failed.length ? 1 : 0);
