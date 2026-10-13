// Auto-unload check: real headed Firefox with the addon from src/. Drives the background script's
// runCheck message with real and simulated clock values and reads tab state back from the browser.
// Prints one JSON line (last stdout line). Exit code 0 only if every check passes.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, extEval, screenshot } from './lib.mjs';
import { startFixtureServer } from './fixtures/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60000;
const WAIT_MS = 65000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = {};
const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
};

const runCheck = (driver, now) =>
  extEval(driver, (n) => browser.runtime.sendMessage(n === null ? { type: 'runCheck' } : { type: 'runCheck', now: n }), now ?? null);

const tabStates = (driver, ids) =>
  extEval(
    driver,
    async (idList) => {
      const out = {};
      for (const [name, id] of Object.entries(idList)) {
        const t = await browser.tabs.get(id);
        out[name] = { id, discarded: t.discarded, active: t.active, pinned: t.pinned, audible: t.audible, status: t.status, title: t.title };
      }
      return out;
    },
    ids,
  );

const activate = (driver, id) => extEval(driver, (tabId) => browser.tabs.update(tabId, { active: true }).then(() => null), id);

async function waitForTab(driver, id, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let tab;
  while (Date.now() < deadline) {
    tab = await extEval(driver, (tabId) => browser.tabs.get(tabId), id);
    if (predicate(tab)) return tab;
    await sleep(250);
  }
  throw new Error(`${label}: timed out, last state ${JSON.stringify(tab && { status: tab.status, discarded: tab.discarded, audible: tab.audible, title: tab.title })}`);
}

const pick = (states, names) => Object.fromEntries(names.map((n) => [n, states[n].discarded]));

let session = null;
let server = null;
try {
  server = await startFixtureServer();
  session = await launch({ name: 'auto' });
  const { driver } = session;

  // 1. Exactly one alarm, once a minute.
  result.alarms = await extEval(driver, () => browser.alarms.getAll());
  check(
    'alarm',
    result.alarms.length === 1 && result.alarms[0].name === 'tab-unloader-check' && result.alarms[0].periodInMinutes === 1,
    JSON.stringify(result.alarms),
  );

  // 2. Settings. Paused, so the real alarm unloads nothing during the wait.
  const exactUrl = `${server.url}page.html?t=EXACT`;
  await extEval(driver, (exact) => TabUnloaderSettings.set({ idleMinutes: 1, neverUnload: ['localhost', exact], paused: true }), exactUrl);
  result.settings = await extEval(driver, () => TabUnloaderSettings.get());
  check('settings stored', result.settings.idleMinutes === 1 && result.settings.paused === true && result.settings.neverUnload.length === 2, JSON.stringify(result.settings));

  // 3. Test tabs in the normal window. The first tab is the window's existing one.
  await driver.get(`${server.url}page.html?t=ACTIVE`);
  const ids = {};
  ids.ACTIVE = await extEval(driver, async () => {
    const [tab] = await browser.tabs.query({ windowType: 'normal', active: true });
    return tab.id;
  });
  const windowId = await extEval(driver, (id) => browser.tabs.get(id).then((t) => t.windowId), ids.ACTIVE);
  const specs = [
    ['P1', `${server.url}page.html?t=P1`],
    ['P2', `${server.url}page.html?t=P2`],
    ['PIN', `${server.url}page.html?t=PIN`],
    ['AUD', `${server.url}audio.html?t=AUD`],
    ['HOST', `${server.altUrl}page.html?t=HOST`],
    ['EXACT', exactUrl],
    ['FRESH', `${server.url}page.html?t=FRESH`],
  ];
  for (const [name, url] of specs) {
    // Opened in the foreground so each tab has been visited (background autoplay waits for a first visit).
    ids[name] = await extEval(driver, (w, u) => browser.tabs.create({ windowId: w, url: u, active: true }).then((t) => t.id), windowId, url);
    await waitForTab(driver, ids[name], (t) => t.status === 'complete' && t.title === name, `load ${name}`);
  }

  // A file: page, which the addon must treat like any other idle tab. Try tabs.create first; Firefox
  // refuses file: URLs there for extensions, so fall back to a WebDriver-opened tab in the same window.
  const fileUrl = `${pathToFileURL(path.join(here, 'fixtures', 'page.html')).href}?t=FILE`;
  result.fileUrl = fileUrl;
  result.fileTabsCreate = await extEval(
    driver,
    (w, u) => browser.tabs.create({ windowId: w, url: u, active: true }).then((t) => ({ ok: true, id: t.id }), (e) => ({ ok: false, error: String((e && e.message) || e) })),
    windowId,
    fileUrl,
  );
  if (result.fileTabsCreate.ok) {
    ids.FILE = result.fileTabsCreate.id;
    result.fileOpenedWith = 'tabs.create';
  } else {
    const activeHandle = await driver.getWindowHandle();
    await driver.switchTo().newWindow('tab');
    await driver.get(fileUrl);
    await driver.switchTo().window(activeHandle);
    ids.FILE = await extEval(driver, () => browser.tabs.query({}).then((tabs) => tabs.filter((t) => /^file:.*\?t=FILE$/.test(t.url)).map((t) => t.id))).then((found) => {
      if (found.length !== 1) throw new Error(`FILE tab lookup found ${JSON.stringify(found)}`);
      return found[0];
    });
    result.fileOpenedWith = 'WebDriver newWindow(tab) + get';
  }
  const fileTab = await waitForTab(driver, ids.FILE, (t) => t.status === 'complete' && /^file:.*\?t=FILE$/.test(t.url), 'load FILE');
  result.fileTabUrl = fileTab.url;

  await extEval(driver, (id) => browser.tabs.update(id, { pinned: true }).then(() => null), ids.PIN);
  const aud = await waitForTab(driver, ids.AUD, (t) => t.audible === true, 'AUD audible');
  result.audAudible = aud.audible;
  await activate(driver, ids.ACTIVE);
  result.setup = await tabStates(driver, ids);
  result.setupWindowIds = await extEval(driver, (list) => Promise.all(Object.values(list).map((id) => browser.tabs.get(id).then((t) => t.windowId))), ids);
  check('setup: all tabs in one normal window', result.setupWindowIds.every((w) => w === windowId), JSON.stringify(result.setupWindowIds));
  check('setup: ACTIVE is active', result.setup.ACTIVE.active === true);
  check('setup: PIN pinned', result.setup.PIN.pinned === true);
  check('setup: AUD audible', result.setup.AUD.audible === true, `audible ${result.setup.AUD.audible}`);
  check('setup: nothing discarded', Object.values(result.setup).every((s) => !s.discarded), JSON.stringify(pick(result.setup, Object.keys(ids))));

  // 4. Let every tab pass the 1 minute idle limit.
  const waitStart = Date.now();
  await sleep(WAIT_MS);
  result.waitedMs = Date.now() - waitStart;

  // 5. Paused: nothing unloads.
  result.pausedReport = await runCheck(driver);
  check('paused report', result.pausedReport && result.pausedReport.paused === true && result.pausedReport.discarded.length === 0, JSON.stringify(result.pausedReport));
  const afterPaused = await tabStates(driver, ids);
  result.afterPaused = pick(afterPaused, Object.keys(ids));
  check('paused: nothing discarded', Object.values(afterPaused).every((s) => !s.discarded), JSON.stringify(result.afterPaused));

  // The real alarm would otherwise run checks with the real clock between the simulated ones below
  // (moving lastCheckAt and triggering an extra wake), so stop it for the rest of the run.
  result.alarmCleared = await extEval(driver, () => browser.alarms.clear('tab-unloader-check'));
  check('alarm cleared', result.alarmCleared === true, `got ${result.alarmCleared}`);

  // 6. Unpaused: only the idle, unprotected tabs unload.
  await extEval(driver, () => TabUnloaderSettings.set({ paused: false }));
  await activate(driver, ids.FRESH);
  await activate(driver, ids.ACTIVE);
  result.idleReport = await runCheck(driver);
  const afterIdle = await tabStates(driver, ids);
  result.afterIdle = pick(afterIdle, Object.keys(ids));
  for (const name of ['P1', 'P2', 'FILE']) check(`idle: ${name} discarded`, afterIdle[name].discarded === true, `report ${JSON.stringify(result.idleReport)}`);
  for (const name of ['ACTIVE', 'PIN', 'AUD', 'HOST', 'EXACT', 'FRESH']) check(`idle: ${name} kept`, afterIdle[name].discarded === false);
  result.idleKeptReasons = Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, result.idleReport.kept[id] ?? (result.idleReport.discarded.includes(id) ? 'discarded now' : 'missing')]));
  const expectedReasons = { ACTIVE: 'active', PIN: 'pinned', AUD: 'audible', HOST: 'never-unload', EXACT: 'never-unload', FRESH: 'recent' };
  for (const [name, reason] of Object.entries(expectedReasons)) {
    check(`idle: ${name} reason`, result.idleKeptReasons[name] === reason, `got ${result.idleKeptReasons[name]}, expected ${reason}`);
  }
  check(
    'idle report lists P1, P2 and FILE',
    [ids.P1, ids.P2, ids.FILE].every((id) => result.idleReport.discarded.includes(id)),
    JSON.stringify(result.idleReport.discarded),
  );
  // The harness tab is the active tab of a popup-type window: present in the report only because the
  // check covers every window, and kept because it is active.
  result.harnessTabId = await extEval(driver, () => browser.tabs.getCurrent().then((t) => t.id));
  result.harnessReason = result.idleReport.kept[result.harnessTabId] ?? 'missing';
  check('idle: harness tab (popup window) in report as active', result.harnessReason === 'active', `got ${result.harnessReason}`);

  // 7. Sleep rule: a check gap over 3 minutes restarts idle time from the wake.
  await activate(driver, ids.P1);
  await waitForTab(driver, ids.P1, (t) => t.status === 'complete' && !t.discarded && t.title === 'P1', 'P1 reload');
  await activate(driver, ids.ACTIVE);
  const T = Date.now();
  result.sleepT = T;
  result.wakeReport = await runCheck(driver, T + 10 * MIN);
  result.p1AfterWake = (await tabStates(driver, { P1: ids.P1 })).P1.discarded;
  check('wake report', result.wakeReport && result.wakeReport.wake === true, JSON.stringify(result.wakeReport));
  check(
    'wake: report discarded list empty',
    result.wakeReport && Array.isArray(result.wakeReport.discarded) && result.wakeReport.discarded.length === 0,
    JSON.stringify(result.wakeReport),
  );
  check('wake: P1 kept', result.p1AfterWake === false);
  result.wake30sReport = await runCheck(driver, T + 10 * MIN + 30000);
  result.p1After30s = (await tabStates(driver, { P1: ids.P1 })).P1.discarded;
  check('wake + 30 s: P1 kept', result.p1After30s === false, `report ${JSON.stringify(result.wake30sReport)}`);
  result.wake2mReport = await runCheck(driver, T + 12 * MIN);
  result.p1After2m = (await tabStates(driver, { P1: ids.P1 })).P1.discarded;
  check('wake + 2 min: P1 discarded', result.p1After2m === true, `report ${JSON.stringify(result.wake2mReport)}`);

  // 8. Clicking an unloaded tab reloads it.
  await activate(driver, ids.P2);
  const p2 = await waitForTab(driver, ids.P2, (t) => t.status === 'complete' && !t.discarded, 'P2 reload');
  result.p2Reloaded = { discarded: p2.discarded, status: p2.status, title: p2.title };
  check('click: P2 reloaded', p2.discarded === false && p2.title === 'P2', JSON.stringify(result.p2Reloaded));

  // 9. Screenshot of the window (P2 is the active tab).
  result.screenshot = await screenshot(driver, 'auto');
  result.screenshotBytes = (await stat(result.screenshot)).size;
} catch (err) {
  failures.push(`error: ${(err && err.stack) || err}`);
} finally {
  if (session) {
    try {
      await session.close();
    } catch (err) {
      failures.push(`close: ${err.message}`);
    }
  }
  if (server) await server.close();
}

result.ok = failures.length === 0;
result.failures = failures;
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
