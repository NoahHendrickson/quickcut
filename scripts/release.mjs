#!/usr/bin/env node
// Build, sign and publish a QuickCut release that installed apps update to.
//
//   node scripts/release.mjs 1.1.0 "What changed"
//
// Needs: the signing key at ~/.tauri/quickcut.key (never commit it; back it up:
// without it, installed copies can't verify future updates), `gh` logged in,
// and the Windows cross-compile tools (see README).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'NoahHendrickson/quickcut';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [version, notes = ''] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Usage: node scripts/release.mjs <x.y.z> ["release notes"]');
  process.exit(1);
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root }).toString().trim();

// 1. Version bump (tauri.conf.json is what the updater compares against).
const confPath = path.join(root, 'src-tauri/tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (version !== conf.version && !newer(version, conf.version)) {
  console.error(`Version ${version} must be newer than ${conf.version}`);
  process.exit(1);
}
conf.version = version;
fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
const cargoPath = path.join(root, 'src-tauri/Cargo.toml');
fs.writeFileSync(cargoPath, fs.readFileSync(cargoPath, 'utf8').replace(/^version = ".*?"/m, `version = "${version}"`));
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// 2. Tests must pass: ffmpeg end to end + Rust, then the UI flows in headless Chrome.
run('npm', ['test']);
run('npm', ['run', 'test:ui']);

// 3. Build the signed Windows installer (cross-compiled from macOS).
const keyPath = path.join(os.homedir(), '.tauri/quickcut.key');
if (!fs.existsSync(keyPath)) throw new Error(`Missing signing key ${keyPath}`);
run('npx', ['tauri', 'build', '--runner', 'cargo-xwin', '--target', 'x86_64-pc-windows-msvc'], {
  env: {
    ...process.env,
    PATH: `/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:${process.env.PATH}`,
    TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyPath, 'utf8'),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  },
});
const bundleDir = path.join(root, 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis');
const setupName = `QuickCut_${version}_x64-setup.exe`;
const setup = path.join(bundleDir, setupName);
const sig = fs.readFileSync(`${setup}.sig`, 'utf8').trim();

// 4. Release files: versioned installer (what updates download), a stable-name
//    copy (for a permanent download link) and the update feed.
const relDir = path.join(root, 'dist/release', version);
fs.mkdirSync(relDir, { recursive: true });
fs.copyFileSync(setup, path.join(relDir, setupName));
fs.copyFileSync(setup, path.join(relDir, 'QuickCut-Setup.exe'));
fs.writeFileSync(path.join(relDir, 'latest.json'), `${JSON.stringify({
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: sig,
      url: `https://github.com/${REPO}/releases/download/v${version}/${setupName}`,
    },
  },
}, null, 2)}\n`);

// 5. Commit, tag, push, publish.
run('git', ['add', '-A']);
if (out('git', ['status', '--porcelain'])) {
  run('git', ['commit', '-m', `Release ${version}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`]);
}
run('git', ['tag', `v${version}`]);
run('git', ['push', 'origin', 'HEAD', `v${version}`]);
run('gh', ['release', 'create', `v${version}`, '--repo', REPO, '--title', `QuickCut ${version}`,
  '--notes', notes || `QuickCut ${version}`, '--latest',
  path.join(relDir, setupName), path.join(relDir, 'QuickCut-Setup.exe'), path.join(relDir, 'latest.json')]);
console.log(`\nPublished v${version}. Installed copies will offer the update on their next launch.`);
console.log(`Download link: https://github.com/${REPO}/releases/latest/download/QuickCut-Setup.exe`);
