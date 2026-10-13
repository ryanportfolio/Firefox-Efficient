// Verification helpers: launch real headed Firefox with the addon loaded from src/,
// run code inside an extension page, take screenshots.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { start as startGeckodriver } from 'geckodriver';
import firefox from 'selenium-webdriver/firefox.js';
import commandModule from 'selenium-webdriver/lib/command.js';
import httpModule from 'selenium-webdriver/http/index.js';

const { Command } = commandModule;
const { Executor, HttpClient } = httpModule;

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const SRC_DIR = path.join(ROOT, 'src');
export const FIREFOX_BINARY = process.env.FIREFOX_BINARY || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
export const ADDON_ID = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'manifest.json'), 'utf8'))
  .browser_specific_settings.gecko.id;
// Fixed internal UUID so extension pages live at a known moz-extension://<uuid>/ base.
export const EXT_UUID = '0a7e5c3d-1b2f-4c6e-9d8a-7f1e2b3c4d5e';
export const EXT_BASE = `moz-extension://${EXT_UUID}`;
export const WINDOW_RECT = { x: -2400, y: -2400, width: 1280, height: 800 };
// Pinned so runs are repeatable and need no network once cached (download goes to os.tmpdir()).
const GECKODRIVER_VERSION = process.env.GECKODRIVER_VERSION || '0.37.1';
const SCREENSHOT_DIR = 'D:\\screenshots\\Firefox-Efficient';

const harnessHandles = new WeakMap();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(url, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`geckodriver exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${url}/status`);
      if (res.ok) {
        await res.arrayBuffer();
        return;
      }
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`geckodriver did not answer at ${url} within ${timeoutMs} ms`);
}

/** True if a process with this PID exists (any owner). Says nothing about who owns it. */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Process creation stamps can be rounded down to the system timer tick (about 16 ms), so a process
// started right after launch() began may carry a stamp slightly before the Date.now() taken then.
const CLOCK_SLACK_MS = 100;
// How long close() waits for driver.quit() before it terminates the processes itself.
const QUIT_DEADLINE_MS = Number(process.env.VERIFY_QUIT_DEADLINE_MS) || 10000;

/** Run a PowerShell script (passed encoded, so no quoting issues) and return its stdout. */
function powershell(script, timeoutMs = 60000) {
  const encoded = Buffer.from(
    `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`,
    'utf16le',
  ).toString('base64');
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`powershell exited with ${out.status}: ${out.stderr}`);
  return out.stdout;
}

/**
 * One live listing of every process (one PowerShell call): Map pid -> { pid, ppid, created (Unix ms),
 * name, cmd }.
 */
function processSnapshot() {
  const out = powershell(
    `$list = @(Get-CimInstance Win32_Process | ForEach-Object {
       [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine;
         created = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } })
     ConvertTo-Json -Compress -Depth 2 -InputObject $list`,
  );
  const snap = new Map();
  for (const p of JSON.parse(out)) snap.set(p.pid, { ...p, cmd: p.cmd || '' });
  return snap;
}

/**
 * Terminate processes only if each PID still names the same process (same creation time). The check and
 * the kill use one process handle, so a PID that Windows reused in between is never hit. One PowerShell
 * call for the whole list. Returns [{ pid, result: 'killed' | 'gone' | 'mismatch' | 'error: ...' }].
 */
function killVerified(recs) {
  if (!recs.length) return [];
  const list = recs.map((r) => `,@(${Number(r.pid)},${Number(r.created)})`).join('; ');
  const out = powershell(
    `$res = @(foreach ($e in @(${list})) {
       $id = $e[0]; $created = [long]$e[1]
       try { $p = [Diagnostics.Process]::GetProcessById($id) } catch { [pscustomobject]@{ pid = $id; result = 'gone' }; continue }
       try {
         $null = $p.Handle  # opens and keeps one handle; StartTime and Kill below reuse it
         $start = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()
         if ([Math]::Abs($start - $created) -gt 1) { [pscustomobject]@{ pid = $id; result = 'mismatch' }; continue }
         $p.Kill(); $null = $p.WaitForExit(5000)
         [pscustomobject]@{ pid = $id; result = 'killed' }
       } catch {
         # Terminating a process that is already exiting fails with "Access is denied".
         $msg = $_.Exception.Message; $ended = $false
         try { $ended = $p.WaitForExit(2000) } catch { }
         if ($ended) { [pscustomobject]@{ pid = $id; result = 'gone' } }
         else { [pscustomobject]@{ pid = $id; result = 'error: ' + $msg } }
       }
     })
     ConvertTo-Json -Compress -InputObject $res`,
  );
  return JSON.parse(out);
}

/**
 * Work out, from a live snapshot, which processes this launch started. Nothing cached is trusted:
 * - geckodriver and the guard are our own ChildProcess objects; while Node has not seen them exit it
 *   holds their process handles, so their PIDs cannot have been reused.
 * - the browser set is every firefox.exe started by our geckodriver, plus the Firefox root launch()
 *   learned and any firefox.exe whose command line holds this launch's unique profile path (covers a
 *   Firefox whose geckodriver parent is gone), plus everything under those.
 * Every process must have been created after this launch started, and a child after its parent.
 */
function findOwned(state, snap) {
  const minCreated = state.launchStart - CLOCK_SLACK_MS;
  const fresh = (rec) => !!rec && rec.created >= minCreated;
  const profileKey = state.profileDir ? state.profileDir.toLowerCase() : null;
  // The profile path must end where the match ends (quote, whitespace, path separator or end of the
  // command line), so a concurrent launch whose folder name merely starts with ours is not counted.
  const hasProfile = (rec) => {
    if (!profileKey) return false;
    const cmd = rec.cmd.toLowerCase();
    for (let i = cmd.indexOf(profileKey); i !== -1; i = cmd.indexOf(profileKey, i + 1)) {
      if (/^(?:$|["'\s\\/])/.test(cmd.slice(i + profileKey.length, i + profileKey.length + 1))) return true;
    }
    return false;
  };
  const isFirefox = (rec) => /^firefox\.exe$/i.test(rec.name);
  const children = new Map();
  for (const rec of snap.values()) {
    if (!children.has(rec.ppid)) children.set(rec.ppid, []);
    children.get(rec.ppid).push(rec);
  }
  const addTree = (root, into) => {
    const stack = [root];
    while (stack.length) {
      const parent = stack.pop();
      if (into.has(parent.pid)) continue;
      into.set(parent.pid, parent);
      for (const child of children.get(parent.pid) || []) {
        if (child.pid !== parent.pid && fresh(child) && child.created >= parent.created && !into.has(child.pid)) stack.push(child);
      }
    }
  };
  const liveChild = (cp, namePattern) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null || !cp.pid) return null;
    const rec = snap.get(cp.pid);
    return fresh(rec) && namePattern.test(rec.name) ? rec : null;
  };

  const geckodriver = liveChild(state.gdChild, /^geckodriver/i);
  const browser = new Map();
  if (geckodriver) {
    for (const child of children.get(geckodriver.pid) || []) {
      if (isFirefox(child) && fresh(child) && child.created >= geckodriver.created) addTree(child, browser);
    }
  }
  const learned = state.firefoxPid ? snap.get(state.firefoxPid) : null;
  if (fresh(learned) && isFirefox(learned) && (browser.has(learned.pid) || hasProfile(learned))) addTree(learned, browser);
  for (const rec of snap.values()) {
    if (isFirefox(rec) && fresh(rec) && hasProfile(rec) && !browser.has(rec.pid)) addTree(rec, browser);
  }

  const guardRoot = liveChild(state.guardChild, /^powershell/i);
  const guard = new Map();
  if (guardRoot) addTree(guardRoot, guard);
  // Processes under geckodriver itself that are not Firefox (e.g. its console host) go with geckodriver.
  const gdTree = new Map();
  if (geckodriver) {
    addTree(geckodriver, gdTree);
    for (const pid of browser.keys()) gdTree.delete(pid);
  }
  // Parents before children, so a Firefox root goes down before it can start replacements.
  const order = (m) => [...m.values()].sort((a, b) => a.created - b.created);
  return { browser: order(browser), geckodriver: order(gdTree), guard: order(guard) };
}

/**
 * Start scripts/verify/offscreen-guard.ps1 for this geckodriver: it moves any Firefox main window started
 * under geckodriver off every display the moment it shows up (Firefox clamps new windows onto a screen,
 * so without it each new window flashes on one of the user's displays until WebDriver moves it).
 * Returns the ChildProcess at once (so the caller can clean it up) and a promise that settles on READY.
 */
function startOffscreenGuard(rootPid) {
  const guard = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'offscreen-guard.ps1'),
      '-RootPid', String(rootPid), '-X', String(WINDOW_RECT.x), '-Y', String(WINDOW_RECT.y),
      ...(process.env.VERIFY_DEBUG === 'trace' ? ['-Trace'] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let output = '';
  const collect = (chunk) => (output += chunk);
  guard.stdout.on('data', collect);
  guard.stderr.on('data', collect);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`offscreen guard not ready after 20 s: ${output}`)), 20000);
    guard.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    guard.stdout.on('data', () => {
      if (output.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    guard.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`offscreen guard exited with code ${code}: ${output}`));
    });
  }).then(() => {
    guard.removeAllListeners('exit');
    guard.stdout.removeAllListeners('data');
    guard.stderr.removeAllListeners('data');
    // VERIFY_DEBUG=1 prints each window the guard moved to stderr; VERIFY_DEBUG=trace also prints every
    // window event of the test Firefox.
    if (process.env.VERIFY_DEBUG) guard.stdout.on('data', (chunk) => process.stderr.write(`[offscreen-guard] ${chunk}`));
    guard.stdout.resume();
    guard.stderr.resume();
  });
  return { guard, ready };
}

function prefs() {
  return {
    'media.volume_scale': '0.0',
    'media.autoplay.default': 0,
    'media.autoplay.blocking_policy': 0,
    'browser.tabs.unloadOnLowMemory': false,
    'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: EXT_UUID }),
    'browser.shell.checkDefaultBrowser': false,
    'browser.aboutwelcome.enabled': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'browser.warnOnQuit': false,
    'browser.tabs.warnOnClose': false,
  };
}

const waitExit = async (cp, ms) => {
  for (let t = 0; t < ms && cp && cp.exitCode === null && cp.signalCode === null; t += 100) await sleep(100);
};

/**
 * Stop everything one launch started and delete its files. Safe to run at any point of launch().
 * Order: driver.quit() (bounded), Firefox tree, geckodriver, offscreen guard, log handle, profile, log.
 */
async function cleanup(state) {
  const started = Date.now();
  const report = { quit: 'skipped', killed: [], skippedCandidates: [], leftover: [], elapsedMs: 0 };
  const kill = (phase, recs) => {
    for (const r of killVerified(recs)) {
      const rec = recs.find((x) => x.pid === r.pid);
      report.killed.push({ phase, pid: r.pid, name: rec && rec.name, created: rec && rec.created, result: r.result });
    }
  };

  if (state.driver) {
    // Test hook: VERIFY_FAULT=hang-quit stands in for a quit() that never settles.
    const quit = state.fault === 'hang-quit' ? new Promise(() => {}) : state.driver.quit();
    let timer;
    const deadline = new Promise((resolve) => (timer = setTimeout(() => resolve('timeout'), QUIT_DEADLINE_MS)));
    report.quit = await Promise.race([quit.then(() => 'ok', () => 'error'), deadline]);
    clearTimeout(timer);
  }

  let processError = null;
  if (state.gdChild || state.profileDir) {
    try {
      await stopProcesses(state, report, kill);
    } catch (err) {
      processError = err;
    }
  }

  if (state.gdLog !== null) {
    try {
      fs.closeSync(state.gdLog);
    } catch {
      // already closed
    }
    state.gdLog = null;
  }
  if (state.profileDir && state.ownsProfile) await fsp.rm(state.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (state.xpiDir) await fsp.rm(state.xpiDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (state.gdLogPath && !state.keepLog) await fsp.rm(state.gdLogPath, { force: true });
  report.elapsedMs = Date.now() - started;
  if (process.env.VERIFY_DEBUG) process.stderr.write(`[cleanup] ${JSON.stringify(report)}\n`);
  if (processError || report.leftover.length) {
    const err = new Error(
      processError
        ? `process cleanup failed: ${processError.message}`
        : `processes still running after close(): ${report.leftover.join(', ')}`,
    );
    err.report = report;
    throw err;
  }
  return report;
}

async function stopProcesses(state, report, kill) {
  let owned = findOwned(state, processSnapshot());
  // Cached PIDs (test hook VERIFY_INJECT_PID) are hints only: one that is not in the live owned set
  // is left alone.
  const ownedPids = new Set([...owned.browser, ...owned.geckodriver, ...owned.guard].map((r) => r.pid));
  report.skippedCandidates = state.candidatePids.filter((pid) => !ownedPids.has(pid));
  // After a clean quit Firefox exits by itself; give it a moment before forcing it.
  if (report.quit === 'ok' && owned.browser.length) {
    for (let i = 0; i < 50 && owned.browser.some((r) => pidAlive(r.pid)); i++) await sleep(100);
    owned = findOwned(state, processSnapshot());
  }
  // Firefox tree first; repeat in case a process started between listing and kill.
  for (let round = 0; round < 5 && owned.browser.length; round++) {
    kill('firefox', owned.browser);
    owned = findOwned(state, processSnapshot());
  }
  if (owned.geckodriver.length) {
    kill('geckodriver', owned.geckodriver);
    await waitExit(state.gdChild, 3000);
  }
  // The guard exits by itself once geckodriver is gone.
  await waitExit(state.guardChild, 3000);
  owned = findOwned(state, processSnapshot());
  if (owned.guard.length) {
    kill('guard', owned.guard);
    await waitExit(state.guardChild, 3000);
  }
  if (state.gdChild || state.guardChild) {
    owned = findOwned(state, processSnapshot());
    report.leftover = [...owned.browser, ...owned.geckodriver, ...owned.guard].map((r) => `${r.name}:${r.pid}`);
  }
}

/**
 * Start geckodriver and a headed Firefox with a fresh profile and the addon from src/
 * installed as a temporary addon.
 * @param {{ name?: string, profileDir?: string, addon?: 'temporary'|'permanent'|'none', binary?: string,
 *   extraPrefs?: object }} [opts]
 *   name is used in the profile folder name and logs. profileDir reuses an existing profile (the caller owns
 *   it; close() leaves it on disk), which is how a test restarts the browser. addon 'permanent' installs a
 *   packed build that survives a restart (needs xpinstall.signatures.required false, which ESR honours);
 *   'none' installs nothing and opens no harness page. binary overrides FIREFOX_BINARY for this launch.
 * @returns {Promise<{ driver: import('selenium-webdriver').WebDriver, extBase: string, addonId: string,
 *   profileDir: string, firefoxPid: number, geckodriverPid: number, browserVersion: string,
 *   initialRect: { x: number, y: number, width: number, height: number }, close: () => Promise<object> }>}
 *   close() resolves to a cleanup report; calling it again returns the same promise. When launch()
 *   rejects, it has already cleaned up and the error carries `launchState` (paths, PIDs, cleanup report).
 */
export async function launch({ name = 'run', profileDir = null, addon = 'temporary', binary = FIREFOX_BINARY, extraPrefs = {} } = {}) {
  const safeName = String(name).replace(/[^a-z0-9_-]/gi, '_');
  // Everything launch() allocates is recorded here the moment it exists, so cleanup() can undo it.
  const state = {
    launchStart: Date.now(),
    // Test hooks (scripts/verify/cleanup-check.mjs): VERIFY_FAULT=before-geckodriver |
    // after-firefox-start | hang-quit; VERIFY_INJECT_PID=<pid>[,<pid>] adds PIDs to the cached list.
    fault: process.env.VERIFY_FAULT || '',
    candidatePids: String(process.env.VERIFY_INJECT_PID || '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
    profileDir: null,
    ownsProfile: !profileDir,
    xpiDir: null,
    gdLogPath: null,
    gdLog: null,
    keepLog: false,
    gdChild: null,
    guardChild: null,
    driver: null,
    firefoxPid: 0,
  };
  let closing = null;
  const close = () => (closing ??= cleanup(state));

  try {
    state.profileDir = profileDir || (await fsp.mkdtemp(path.join(os.tmpdir(), `tab-unloader-${safeName}-`)));
    const port = await freePort();
    // geckodriver output goes to a temp log; close() deletes it unless launch() failed.
    state.gdLogPath = path.join(os.tmpdir(), `tab-unloader-${safeName}-geckodriver-${port}.log`);
    state.gdLog = fs.openSync(state.gdLogPath, 'w');
    if (state.fault === 'before-geckodriver') throw new Error('VERIFY_FAULT=before-geckodriver');
    state.gdChild = await startGeckodriver({
      port,
      host: '127.0.0.1',
      allowSystemAccess: true, // lets chromeEval() use the privileged context (Firefox 138+)
      geckoDriverVersion: GECKODRIVER_VERSION,
      spawnOpts: { stdio: ['ignore', state.gdLog, state.gdLog], windowsHide: true },
    });
    const child = state.gdChild;
    const serverUrl = `http://127.0.0.1:${port}`;
    await waitForStatus(serverUrl, child);
    const { guard, ready } = startOffscreenGuard(child.pid);
    state.guardChild = guard;
    await ready;

    const options = new firefox.Options();
    options.setBinary(binary);
    options.addArguments('-profile', state.profileDir, '-no-remote');
    for (const [k, v] of Object.entries({ ...prefs(), ...extraPrefs })) options.setPreference(k, v);

    state.driver = firefox.Driver.createSession(options, new Executor(new HttpClient(serverUrl)));
    const caps = await state.driver.getCapabilities();
    if (state.fault === 'after-firefox-start') {
      // Stands in for a session that failed after Firefox started: no driver to quit, no Firefox PID.
      state.driver = null;
      throw new Error('VERIFY_FAULT=after-firefox-start');
    }
    state.firefoxPid = caps.get('moz:processID') || 0;
    const { driver } = state;

    await driver.manage().setTimeouts({ script: 30000, pageLoad: 30000 });
    // Rect before the explicit move (the offscreen guard normally has already moved it).
    const initialRect = await driver.manage().window().getRect();
    await driver.manage().window().setRect(WINDOW_RECT);

    let addonId = null;
    if (addon !== 'none') {
      const target = addon === 'permanent' ? await packAddon(state) : SRC_DIR;
      addonId = await driver.execute(
        new Command('install addon').setParameter('path', target).setParameter('temporary', addon !== 'permanent'),
      );
      if (addonId !== ADDON_ID) throw new Error(`installed addon id ${addonId}, expected ${ADDON_ID}`);
      await openHarness(driver);
    }

    return {
      driver,
      extBase: EXT_BASE,
      addonId,
      profileDir: state.profileDir,
      firefoxPid: state.firefoxPid,
      geckodriverPid: child.pid,
      guardPid: guard.pid,
      browserVersion: caps.get('browserVersion'),
      initialRect,
      close,
    };
  } catch (err) {
    state.keepLog = !!state.gdLogPath;
    if (state.gdLogPath) console.error(`launch failed; geckodriver log kept at ${state.gdLogPath}`);
    let cleanupReport = null;
    let cleanupError = null;
    try {
      cleanupReport = await close();
    } catch (cleanupErr) {
      cleanupError = String(cleanupErr && cleanupErr.message);
      cleanupReport = cleanupErr && cleanupErr.report;
    }
    if (err && typeof err === 'object') {
      err.launchState = {
        profileDir: state.profileDir,
        gdLogPath: state.gdLogPath,
        geckodriverPid: state.gdChild ? state.gdChild.pid : 0,
        guardPid: state.guardChild ? state.guardChild.pid : 0,
        firefoxPid: state.firefoxPid,
        cleanup: cleanupReport,
        cleanupError,
      };
    }
    throw err;
  }
}

// Packs src/ into an .xpi for a permanent install (a permanent install needs a file, not a folder).
async function packAddon(state) {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'tab-unloader-xpi-'));
  state.xpiDir = out; // removed by cleanup(); Firefox copies the file into the profile on install
  const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'web-ext.cmd' : 'web-ext');
  const r = spawnSync(bin, ['build', '--source-dir', SRC_DIR, '--artifacts-dir', out, '--filename', 'tab-unloader.xpi', '--overwrite-dest'],
    { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  const xpi = path.join(out, 'tab-unloader.xpi');
  if (r.status !== 0 || !fs.existsSync(xpi)) throw new Error(`web-ext build failed: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
  return xpi;
}

/** Tab-strip state from the browser itself: label, URL, pending (not loaded), crashed. */
export async function stripState(driver) {
  return chromeEval(driver, () => {
    const out = [];
    for (const w of Services.wm.getEnumerator('navigator:browser')) {
      for (const tab of w.gBrowser.tabs) {
        const b = tab.linkedBrowser;
        out.push({
          label: tab.label,
          url: b.currentURI ? b.currentURI.spec : null,
          pending: tab.hasAttribute('pending'),
          crashed: tab.hasAttribute('crashed') || /^about:tabcrashed/.test(b.documentURI ? b.documentURI.spec : ''),
          selected: tab.selected,
          remoteType: b.remoteType || null,
        });
      }
    }
    return out;
  });
}

export const HARNESS_URL = `${EXT_BASE}/popup/popup.html?harness=1`;

async function findHandleByUrl(driver, url) {
  const current = await driver.getWindowHandle();
  for (const handle of await driver.getAllWindowHandles()) {
    await driver.switchTo().window(handle);
    if ((await driver.getCurrentUrl()) === url) {
      await driver.switchTo().window(current);
      return handle;
    }
  }
  await driver.switchTo().window(current);
  return null;
}

/**
 * Open the harness page (popup.html?harness=1) in its own offscreen window of type "popup", so it is
 * not a "normal" window: tabs.query({ windowType: 'normal' }) and
 * windows.getLastFocused({ windowTypes: ['normal'] }) leave it out. A short-lived extension tab in the
 * current window creates it (windows.create needs an extension page) and is closed again, which
 * re-selects the tab that was active before. launch() calls this before returning.
 */
async function openHarness(driver) {
  const original = await driver.getWindowHandle();
  await driver.switchTo().newWindow('tab');
  await driver.get(`${EXT_BASE}/popup/popup.html?harness=bootstrap`);
  await driver.wait(
    async () => driver.executeScript('return typeof browser === "object" && !!browser.windows;'),
    10000,
    'extension APIs not available in the bootstrap page',
  );
  await driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     browser.windows
       .create({ type: 'popup', url: arguments[0], left: arguments[1], top: arguments[2], width: arguments[3], height: arguments[4] })
       .then((w) => done(w.id), (e) => done(String(e)));`,
    HARNESS_URL,
    WINDOW_RECT.x,
    WINDOW_RECT.y,
    WINDOW_RECT.width,
    WINDOW_RECT.height,
  );
  await driver.close();
  await driver.switchTo().window(original);
  let handle = null;
  for (let i = 0; i < 50 && !handle; i++) {
    handle = await findHandleByUrl(driver, HARNESS_URL);
    if (!handle) await sleep(100);
  }
  if (!handle) throw new Error('harness window did not appear');
  await driver.switchTo().window(handle);
  await driver.manage().window().setRect(WINDOW_RECT);
  await driver.wait(
    async () => driver.executeScript('return typeof browser === "object" && typeof TabUnloaderSettings === "object";'),
    10000,
    'extension APIs not available in the harness page',
  );
  await driver.switchTo().window(original);
  harnessHandles.set(driver, handle);
  return handle;
}

async function harnessHandle(driver) {
  const known = harnessHandles.get(driver);
  if (known && (await driver.getAllWindowHandles()).includes(known)) return known;
  return openHarness(driver);
}

/**
 * Run a function inside the harness extension page, where browser.* and TabUnloaderSettings are
 * available. The function source is inlined, so it cannot close over Node variables; pass data as
 * JSON-serializable args. Returns the JSON-round-tripped result. The WebDriver context switches to the
 * harness window for the call and back to the window that was current before it (switching windows
 * focuses them).
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {string|Function} fn (async) function or its source
 * @param {...any} args
 */
export async function extEval(driver, fn, ...args) {
  const source = typeof fn === 'function' ? fn.toString() : String(fn);
  const previous = await driver.getWindowHandle();
  const handle = await harnessHandle(driver);
  if (previous !== handle) await driver.switchTo().window(handle);
  try {
    const script = `
      const done = arguments[arguments.length - 1];
      const args = Array.prototype.slice.call(arguments, 0, -1);
      if (location.href !== ${JSON.stringify(HARNESS_URL)} || typeof TabUnloaderSettings !== 'object') {
        done({ ok: false, error: 'harness window was navigated away: ' + location.href });
      } else {
        Promise.resolve()
          .then(() => (${source}).apply(null, args))
          .then(
            (value) => done({ ok: true, json: value === undefined ? null : JSON.stringify(value) }),
            (err) => done({ ok: false, error: String((err && err.stack) || err) }),
          );
      }`;
    const res = await driver.executeAsyncScript(script, ...args);
    if (!res || !res.ok) throw new Error(`extEval failed: ${res ? res.error : 'no result'}`);
    return res.json === null ? undefined : JSON.parse(res.json);
  } finally {
    if (previous !== handle) await driver.switchTo().window(previous);
  }
}

/**
 * Run a function in Firefox's privileged (chrome) context, e.g. to read prefs.
 * Same calling rules as extEval. Needs geckodriver --allow-system-access, which launch() passes.
 */
export async function chromeEval(driver, fn, ...args) {
  const source = typeof fn === 'function' ? fn.toString() : String(fn);
  await driver.setContext('chrome');
  try {
    return await driver.executeScript(`return (${source}).apply(null, arguments);`, ...args);
  } finally {
    await driver.setContext('content');
  }
}

/** Save a PNG of the current window's viewport. Returns the file path. */
export async function screenshot(driver, name) {
  const png = Buffer.from(await driver.takeScreenshot(), 'base64');
  const file = `${String(name).replace(/[^a-z0-9_.-]/gi, '_')}.png`;
  try {
    await fsp.mkdir(SCREENSHOT_DIR, { recursive: true });
    const target = path.join(SCREENSHOT_DIR, file);
    await fsp.writeFile(target, png);
    return target;
  } catch (err) {
    const fallbackDir = path.join(ROOT, '.tmp', 'screenshots');
    await fsp.mkdir(fallbackDir, { recursive: true });
    const target = path.join(fallbackDir, file);
    await fsp.writeFile(target, png);
    console.error(`screenshot: ${SCREENSHOT_DIR} not writable (${err.code || err.message}); saved to ${target}`);
    return target;
  }
}
