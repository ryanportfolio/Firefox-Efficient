// Facts the README shows, read from the add-on's own source at build time. Nothing here is typed by hand:
// change the add-on and the README changes with it, or the build fails because a fact went missing.
//
// Line endings: this repo is checked out with CRLF on Windows and LF on Linux CI. Every byte count is taken
// after normalizing CRLF to LF, so local builds and CI agree.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out.sort();
}

function fail(msg) {
  throw new Error(`facts: ${msg}`);
}

// Human labels for each keep reason in background.js keepReason(). The build fails if the code gains or loses
// a reason, so the art can never show a rule the add-on does not have, or miss one it does.
// Each completes "Kept loaded while the tab is ...".
export const EXEMPT_LABELS = {
  active: 'on screen',
  pinned: 'pinned',
  audible: 'playing sound',
  sharing: 'using camera, mic or screen share',
  'never-unload': 'on your never-unload list',
};
// "discarded" is a keep reason too, but it means "already unloaded", not an exemption.
const NOT_EXEMPTIONS = new Set(['discarded']);

export function readFacts() {
  const manifest = JSON.parse(read('src/manifest.json'));
  const background = read('src/background.js');

  // Default idle limit: run settings.js in a sandbox and read its frozen DEFAULTS.
  const sandbox = { browser: {}, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read('src/settings.js'), sandbox);
  const idleMinutes = sandbox.TabUnloaderSettings?.DEFAULTS?.idleMinutes;
  if (!Number.isInteger(idleMinutes)) fail('DEFAULTS.idleMinutes not found in src/settings.js');

  const period = background.match(/const PERIOD_MINUTES = (\d+);/);
  if (!period) fail('PERIOD_MINUTES not found in src/background.js');
  const wake = background.match(/const WAKE_GAP_MS = (\d+) \* 60000;/);
  if (!wake) fail('WAKE_GAP_MS not found in src/background.js');

  const keepBody = background.match(/function keepReason\([^)]*\) \{([\s\S]*?)\n\}/);
  if (!keepBody) fail('keepReason() not found in src/background.js');
  const reasons = [...keepBody[1].matchAll(/return "([a-z-]+)";/g)].map((m) => m[1]);
  const exemptions = reasons.filter((r) => !NOT_EXEMPTIONS.has(r));
  const labelled = Object.keys(EXEMPT_LABELS);
  const missing = exemptions.filter((r) => !labelled.includes(r));
  const extra = labelled.filter((r) => !exemptions.includes(r));
  if (missing.length || extra.length) {
    fail(`keepReason() reasons and EXEMPT_LABELS disagree: missing labels ${JSON.stringify(missing)}, stale labels ${JSON.stringify(extra)}`);
  }

  const files = walk('src');
  const sourceBytes = files.reduce((n, f) => n + Buffer.byteLength(read(f), 'utf8'), 0);
  const scriptText = files.filter((f) => /\.(js|html)$/.test(f)).map(read).join('\n');
  const webText = files.filter((f) => /\.(js|html|css|svg)$/.test(f)).map(read).join('\n');
  // Requests the add-on's own code makes: script APIs, plus remote URLs in markup and CSS.
  const networkCalls = (webText.match(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|url\(\s*['"]?(https?:)?\/\/|(?:src|href|action)\s*=\s*['"](https?:)?\/\//g) || []).length;
  // Images whose address comes from a tab (the toolbar list shows each tab's icon by its URL); Firefox may
  // fetch those from the tab's own site. Any other .src assignment is counted as a request above.
  const iconLoads = (scriptText.match(/\.src\s*=\s*tab\.favIconUrl/g) || []).length;
  const otherSrc = (scriptText.match(/\.src\s*=/g) || []).length - iconLoads;
  const imports = (scriptText.match(/^\s*import\s|\bimport\s*\(|\brequire\s*\(/gm) || []).length;

  const pkg = JSON.parse(read('package.json'));
  const runtimeDeps = Object.keys(pkg.dependencies || {}).length;

  const collected = manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required;
  if (!Array.isArray(collected)) fail('data_collection_permissions.required missing from src/manifest.json');

  const minVersion = (manifest.browser_specific_settings?.gecko?.strict_min_version || '').split('.')[0];
  if (!minVersion) fail('strict_min_version missing from src/manifest.json');

  return {
    android: Boolean(manifest.browser_specific_settings?.gecko_android),
    name: manifest.name,
    version: manifest.version,
    minFirefox: Number(minVersion),
    idleMinutes,
    checkMinutes: Number(period[1]),
    wakeGapMinutes: Number(wake[1]),
    exemptions, // in keepReason() order
    permissions: manifest.permissions || [],
    hostPermissions: (manifest.host_permissions || []).length,
    contentScripts: (manifest.content_scripts || []).length,
    networkCalls: networkCalls + otherSrc,
    iconLoads,
    imports,
    runtimeDeps,
    dataCollected: collected.filter((c) => c !== 'none'),
    sourceFiles: files.length,
    sourceKB: Math.round(sourceBytes / 1024),
  };
}
