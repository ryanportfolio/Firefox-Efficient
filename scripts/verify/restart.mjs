// Restart check: unload tabs, quit Firefox, start it again on the same profile with session restore, then
// select each unloaded tab and open a brand-new tab. Every tab must load; none may show the crash page.
//
// Scenarios (all run unless RESTART_SCENARIOS=a,b,c picks some):
//   temporary  add-on loaded as a temporary add-on (gone after the restart), tabs unloaded by the add-on's API
//   permanent  add-on installed permanently (still there after the restart), tabs unloaded by the add-on's API
//   native     no add-on, tabs unloaded by Firefox's own unload (control: Firefox without the add-on)
// FIREFOX_BINARY_BEFORE / FIREFOX_BINARY_AFTER run the two halves on different Firefox builds (an update).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launch, extEval, chromeEval, stripState, FIREFOX_BINARY } from './lib.mjs';
import { startFixtureServer } from './fixtures/server.mjs';

const BEFORE = process.env.FIREFOX_BINARY_BEFORE || FIREFOX_BINARY;
const AFTER = process.env.FIREFOX_BINARY_AFTER || FIREFOX_BINARY;
const ALL = ['temporary', 'permanent', 'native'];
const scenarios = (process.env.RESTART_SCENARIOS || ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const unknown = scenarios.filter((s) => !ALL.includes(s));
if (unknown.length || !scenarios.length) {
  console.error(`RESTART_SCENARIOS must name one or more of ${ALL.join(', ')}; got ${JSON.stringify(process.env.RESTART_SCENARIOS)}`);
  process.exit(2);
}
const PREFS = {
  'browser.startup.page': 3, // restore the previous session
  'browser.sessionstore.resume_from_crash': true,
  'xpinstall.signatures.required': false, // permanent install of an unsigned build (ESR honours this)
  'app.update.disabledForTesting': true, // an older FIREFOX_BINARY_BEFORE copy must never update itself
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens fixture pages in the background and waits until each shows its title (the page's ?t= value).
async function openTabs(driver, urls) {
  const missing = await chromeEval(driver, async (list) => {
    const w = Services.wm.getMostRecentWindow('navigator:browser');
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    for (const url of list) w.gBrowser.addTab(url, { triggeringPrincipal: principal, inBackground: true });
    const want = list.map((u) => new URL(u).searchParams.get('t'));
    const deadline = Date.now() + 30000;
    let left = want;
    while (Date.now() < deadline) {
      left = want.filter((t) => !w.gBrowser.tabs.some((tab) => tab.label === t && !tab.linkedBrowser.webProgress.isLoadingDocument));
      if (!left.length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return left;
  }, urls);
  if (missing.length) throw new Error(`tabs did not finish loading: ${missing.join(', ')}`);
}

async function unload(driver, scenario, titles) {
  if (scenario === 'native') {
    return chromeEval(driver, (want) => {
      const w = Services.wm.getMostRecentWindow('navigator:browser');
      const done = [];
      for (const tab of w.gBrowser.tabs) if (want.includes(tab.label) && !tab.selected) { w.gBrowser.discardBrowser(tab); done.push(tab.label); }
      return done;
    }, titles);
  }
  return extEval(driver, async (want) => {
    const done = [];
    for (const t of await browser.tabs.query({})) {
      if (want.includes(t.title) && !t.active) { await browser.tabs.discard(t.id); done.push(t.title); }
    }
    await new Promise((r) => setTimeout(r, 500));
    return done;
  }, titles);
}

// Select a tab by label and wait until it shows the expected fixture page (its document, not just its saved
// address) or the crash page. An error page, about:blank or a timeout is a failure.
async function visit(driver, label, expectedUrl) {
  return chromeEval(driver, async (want, url) => {
    for (const w of Services.wm.getEnumerator('navigator:browser')) {
      const tab = w.gBrowser.tabs.find((t) => t.label === want);
      if (!tab) continue;
      w.gBrowser.selectedTab = tab;
      const b = tab.linkedBrowser;
      const deadline = Date.now() + 15000;
      let doc = '';
      while (Date.now() < deadline) {
        doc = b.documentURI ? b.documentURI.spec : '';
        if (tab.hasAttribute('crashed') || doc.startsWith('about:tabcrashed')) return { label: want, loaded: false, crashed: true, doc };
        const done = !tab.hasAttribute('pending') && !b.webProgress.isLoadingDocument;
        if (done && doc === url && b.contentTitle === want) return { label: want, loaded: true, crashed: false, doc };
        await new Promise((r) => setTimeout(r, 200));
      }
      return { label: want, loaded: false, crashed: false, timeout: true, doc, title: b.contentTitle };
    }
    return { label: want, missing: true };
  }, label, expectedUrl);
}

// Every target tab must really be unloaded before the restart (Firefox can refuse a discard silently).
async function assertUnloaded(driver, titles, fail) {
  const strip = await stripState(driver);
  for (const t of titles) {
    const tab = strip.find((s) => s.label === t);
    if (!tab || !tab.pending) fail(`${t} was not unloaded before the restart`);
  }
  return strip.map((t) => ({ label: t.label, pending: t.pending }));
}

async function runScenario(scenario, server) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), `tab-unloader-restart-${scenario}-`));
  const titles = ['R1', 'R2', 'R3'];
  const result = { scenario, failures: [] };
  const fail = (m) => result.failures.push(m);
  try {
    // ---- before the restart
    const a = await launch({ name: `restart-${scenario}-a`, profileDir, binary: BEFORE, extraPrefs: PREFS,
      addon: scenario === 'native' ? 'none' : scenario });
    try {
      result.before = a.browserVersion;
      await openTabs(a.driver, [...titles, 'KEEP'].map((t) => `${server.url}page.html?t=${t}`));
      result.unloaded = await unload(a.driver, scenario, titles);
      result.stripBefore = await assertUnloaded(a.driver, titles, fail);
    } finally {
      // driver.quit() is a normal quit, so Firefox writes its session. A forced kill would make the second
      // launch test crash recovery instead, so it fails the scenario.
      const report = await a.close();
      result.quit = report.quit;
      const forced = report.killed.filter((k) => k.phase === 'firefox' && k.result === 'killed');
      if (report.quit !== 'ok' || forced.length) fail(`Firefox did not quit normally (quit ${report.quit}, ${forced.length} process(es) killed)`);
    }
    if (result.failures.length) {
      result.ok = false;
      return result;
    }

    // ---- after the restart, same profile; the add-on is not reinstalled
    const b = await launch({ name: `restart-${scenario}-b`, profileDir, binary: AFTER, extraPrefs: PREFS, addon: 'none' });
    try {
      result.after = b.browserVersion;
      await sleep(3000); // let session restore finish
      const strip = await stripState(b.driver);
      result.stripAfter = strip.map((t) => ({ label: t.label, pending: t.pending, crashed: t.crashed }));
      for (const t of titles) if (!strip.some((s) => s.label === t)) fail(`${t} not restored`);
      result.addonAfter = await chromeEval(b.driver, async () => {
        const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        const x = await AddonManager.getAddonByID('tab-unloader@ryanportfolio');
        return x ? { active: x.isActive, temporary: x.temporarilyInstalled } : null;
      });
      if (scenario === 'permanent' && !(result.addonAfter && result.addonAfter.active)) fail('permanent add-on not active after restart');
      if (scenario === 'temporary' && result.addonAfter) fail('temporary add-on still present after restart');
      result.visits = [];
      for (const t of [...titles, 'KEEP']) {
        const v = await visit(b.driver, t, `${server.url}page.html?t=${t}`);
        result.visits.push(v);
        if (!v.loaded) fail(`${t}: ${v.crashed ? 'crash page' : v.missing ? 'missing' : 'did not load'}`);
      }
      await openTabs(b.driver, [`${server.url}page.html?t=NEW`]);
      const n = await visit(b.driver, 'NEW', `${server.url}page.html?t=NEW`);
      result.newTab = n;
      if (!n.loaded) fail(`new tab: ${n.crashed ? 'crash page' : 'did not load'}`);
    } finally {
      await b.close();
    }
  } catch (err) {
    fail(`error: ${err.message}`);
  } finally {
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  result.ok = result.failures.length === 0;
  return result;
}

const server = await startFixtureServer();
const results = [];
try {
  for (const s of scenarios) results.push(await runScenario(s, server));
} finally {
  await server.close();
}
const failures = results.flatMap((r) => r.failures.map((f) => `${r.scenario}: ${f}`));
console.log(JSON.stringify({ ok: failures.length === 0, before: BEFORE, after: AFTER, results, failures }));
process.exitCode = failures.length ? 1 : 0;
