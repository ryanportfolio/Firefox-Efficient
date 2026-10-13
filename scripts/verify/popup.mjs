// Popup check: real headed Firefox with the addon from src/. Opens popup/popup.html in its own
// popup-type window (so it is not a normal window), drives its DOM through WebDriver and reads the
// results back from the browser. Prints one JSON line (last stdout line); exit code 0 only if every
// check passes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { By } from 'selenium-webdriver';
import { launch, extEval, screenshot, EXT_BASE, WINDOW_RECT, ROOT } from './lib.mjs';
import { startFixtureServer } from './fixtures/server.mjs';

const POPUP_URL = `${EXT_BASE}/popup/popup.html`;
const POPUP_SIZE = { width: 400, height: 600 };

// screenshot() saves under D:\screenshots\Firefox-Efficient\, or under .tmp/screenshots in the repo when
// D: is not writable. Either is fine; the file must be a non-empty PNG.
const SHOT_DIRS = ['D:\\screenshots\\Firefox-Efficient\\', path.join(ROOT, '.tmp', 'screenshots') + path.sep];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function readShot(file) {
  const bytes = await readFile(file);
  return {
    file,
    bytes: bytes.length,
    allowedDir: SHOT_DIRS.some((dir) => file.toLowerCase().startsWith(dir.toLowerCase())),
    png: bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
  };
}

const result = {};
const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail !== undefined ? `${name}: ${detail}` : name);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll fn until it returns a truthy value or the timeout passes; returns the last value. */
async function waitFor(fn, timeoutMs = 10000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let value;
  for (;;) {
    value = await fn();
    if (value || Date.now() > deadline) return value;
    await sleep(intervalMs);
  }
}

const tabInfo = (driver, ids) =>
  extEval(
    driver,
    async (tabIds) => {
      const out = {};
      for (const id of tabIds) {
        const t = await browser.tabs.get(id);
        out[id] = { windowId: t.windowId, active: t.active, discarded: t.discarded, audible: t.audible, url: t.url, lastAccessed: t.lastAccessed };
      }
      return out;
    },
    ids,
  );

const activeTabOf = (driver, windowId) =>
  extEval(driver, async (wid) => (await browser.tabs.query({ windowId: wid, active: true }))[0].id, windowId);

const readLastNormal = (driver) =>
  extEval(driver, async () => {
    const store = browser.storage.session || browser.storage.local;
    return {
      area: browser.storage.session ? 'session' : 'local',
      lastNormalWindowId: (await store.get('lastNormalWindowId')).lastNormalWindowId,
    };
  });

const readSettings = (driver) => extEval(driver, () => browser.storage.local.get(['paused', 'neverUnload']));

/**
 * Focus a normal window with browser.windows.update(id, {focused: true}) and poll storage until
 * focus.js has recorded it as lastNormalWindowId. Focus is requested again on every poll, so a focus
 * request the OS dropped or a focus change that raced it does not fail the check. Each extEval also
 * switches WebDriver back to the window that was current before it, so the caller should be on a
 * handle inside the target window (or on a popup-type window, which focus.js ignores).
 * Returns { recorded, attempts, ms, last } read from the browser.
 */
async function focusAndWaitRecorded(driver, windowId, timeoutMs = 5000) {
  const started = Date.now();
  let attempts = 0;
  let last;
  for (;;) {
    attempts++;
    last = await extEval(
      driver,
      async (wid) => {
        await browser.windows.update(wid, { focused: true });
        const store = browser.storage.session || browser.storage.local;
        for (let i = 0; i < 5; i++) {
          const v = (await store.get('lastNormalWindowId')).lastNormalWindowId;
          if (v === wid) return v;
          await new Promise((r) => setTimeout(r, 100));
        }
        return (await store.get('lastNormalWindowId')).lastNormalWindowId;
      },
      windowId,
    );
    if (last === windowId || Date.now() - started > timeoutMs) break;
  }
  return { recorded: last === windowId, attempts, ms: Date.now() - started, last };
}

/** Rows rendered in the popup page (driver must be on the popup window). */
const popupRows = (driver) =>
  driver.executeScript(
    `return Array.from(document.querySelectorAll('[data-tab-id]')).map((r) => ({
       id: Number(r.dataset.tabId),
       discarded: r.dataset.discarded,
       hasUnload: !!r.querySelector('.unload'),
       unloadTitle: r.querySelector('.unload') ? r.querySelector('.unload').title : null,
     }));`,
  );

// The popup rebuilds its tab list on every tab event, so a row found a moment ago can be replaced
// before the click lands. A stale element was not clicked: find it again and retry.
const click = async (driver, css) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await driver.findElement(By.css(css)).click();
    } catch (err) {
      if (!err || err.name !== 'StaleElementReferenceError' || attempt >= 5) throw err;
      await sleep(100);
    }
  }
};

let session = null;
let server = null;
try {
  server = await startFixtureServer();
  session = await launch({ name: 'popup' });
  const { driver } = session;

  // 1. Setup. W1 = the test's normal window; T1 is its existing tab.
  const w1Handle = await driver.getWindowHandle();
  const page = (t) => `${server.url}page.html?t=${t}`;
  await driver.get(page('T1'));

  const ids = await extEval(
    driver,
    async (urls, rect) => {
      const normal = await browser.tabs.query({ windowType: 'normal' });
      if (normal.length !== 1) throw new Error(`expected 1 normal tab at start, found ${normal.length}`);
      const T1 = normal[0].id;
      const W1 = normal[0].windowId;
      await TabUnloaderSettings.set({ neverUnload: ['localhost'] });
      const made = {};
      for (const key of ['T2', 'T3', 'T4', 'T5']) {
        made[key] = (await browser.tabs.create({ windowId: W1, url: urls[key], active: false })).id;
      }
      const w2 = await browser.windows.create({ type: 'normal', url: [urls.U1, urls.U2], ...rect });
      return { W1, T1, ...made, W2: w2.id, U1: w2.tabs[0].id, U2: w2.tabs[1].id };
    },
    {
      T2: page('T2'),
      T3: page('T3'),
      T4: `${server.url}audio.html?t=T4`,
      T5: `${server.altUrl}page.html?t=T5`,
      U1: page('U1'),
      U2: page('U2'),
    },
    { left: WINDOW_RECT.x, top: WINDOW_RECT.y, width: 900, height: 700 },
  );
  result.ids = ids;
  // Focus W2 explicitly; focus.js must record it. WebDriver stays on W1's handle here, so every
  // extEval inside the helper ends by switching back to W1 (focusing it); the helper re-requests W2
  // focus on each poll and reads storage inside the same call, before that switch back.
  result.focusW2 = await focusAndWaitRecorded(driver, ids.W2);
  check('setup: focus tracking recorded W2 after it was focused', result.focusW2.recorded, JSON.stringify(result.focusW2));
  const allTabIds = ['T1', 'T2', 'T3', 'T4', 'T5', 'U1', 'U2'].map((k) => ids[k]);

  const loaded = await waitFor(async () => {
    const st = await extEval(
      driver,
      async (tabIds) => Promise.all(tabIds.map(async (id) => browser.tabs.get(id))).then((ts) => ts.map((t) => ({ status: t.status, audible: t.audible }))),
      allTabIds,
    );
    return st.every((s) => s.status === 'complete') ? st : null;
  }, 20000);
  check('setup: all tabs loaded', !!loaded);

  // Firefox holds back autoplay in tabs that were never in the foreground, so show T4 once.
  await extEval(driver, async (id) => browser.tabs.update(id, { active: true }), ids.T4);
  const audible = await waitFor(async () => extEval(driver, async (id) => (await browser.tabs.get(id)).audible, ids.T4), 10000);
  check('setup: T4 audible', audible === true, `got ${audible}`);

  // Activate T3, then T1 in W1, then focus W1 last. Returning from extEval switches WebDriver back to
  // T1's handle, which focuses W1 again.
  await extEval(
    driver,
    async (o) => {
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      await browser.tabs.update(o.T3, { active: true });
      await pause(300);
      await browser.tabs.update(o.T1, { active: true });
      await pause(300);
    },
    ids,
  );
  result.focusW1 = await focusAndWaitRecorded(driver, ids.W1);
  result.setup = {
    lastNormalAfterSetup: await readLastNormal(driver),
    w1ActiveTab: await activeTabOf(driver, ids.W1),
    w2ActiveTab: await activeTabOf(driver, ids.W2),
    tabs: await tabInfo(driver, allTabIds),
  };
  check('setup: storage lastNormalWindowId == W1', result.focusW1.recorded && result.setup.lastNormalAfterSetup.lastNormalWindowId === ids.W1, JSON.stringify({ focusW1: result.focusW1, read: result.setup.lastNormalAfterSetup }));
  check('setup: W1 active tab is T1', result.setup.w1ActiveTab === ids.T1, `got ${result.setup.w1ActiveTab}`);
  check('setup: W2 active tab is U1', result.setup.w2ActiveTab === ids.U1, `got ${result.setup.w2ActiveTab}`);
  {
    const t = result.setup.tabs;
    const others = ['T2', 'T4', 'T5'].map((k) => t[ids[k]].lastAccessed);
    check('setup: T3 is the most recently used other tab in W1', others.every((v) => (t[ids.T3].lastAccessed || 0) > (v || 0)), JSON.stringify({ T3: t[ids.T3].lastAccessed, others }));
  }

  // 2. Open the popup page in its own popup-type window.
  const handlesBefore = await driver.getAllWindowHandles();
  result.popupWindow = await extEval(
    driver,
    async (url, rect) => {
      const w = await browser.windows.create({ type: 'popup', url, ...rect });
      return { id: w.id, type: w.type };
    },
    POPUP_URL,
    { left: WINDOW_RECT.x, top: WINDOW_RECT.y, width: POPUP_SIZE.width, height: POPUP_SIZE.height },
  );
  check('popup window type is popup', result.popupWindow.type === 'popup', result.popupWindow.type);
  const popupHandle = await waitFor(async () => (await driver.getAllWindowHandles()).find((h) => !handlesBefore.includes(h)), 10000);
  if (!popupHandle) throw new Error('popup window handle did not appear');
  await driver.switchTo().window(popupHandle);
  await driver.manage().window().setRect({ x: WINDOW_RECT.x, y: WINDOW_RECT.y, ...POPUP_SIZE });
  result.popupUrl = await driver.getCurrentUrl();
  check('popup url', result.popupUrl === POPUP_URL, result.popupUrl);

  // Expected rows: exactly the 7 tabs this script created, grouped by window (W1 then W2), each
  // window in tab-strip order. Built from the script's own ids, not from tabs.query.
  const expectedIds = allTabIds;
  const rows2 = await waitFor(async () => {
    const rows = await popupRows(driver);
    return rows.length >= expectedIds.length ? rows : null;
  }, 10000);
  const tabs2 = await tabInfo(driver, expectedIds);
  const rowIds2 = (rows2 || (await popupRows(driver))).map((r) => r.id);
  result.step2 = {
    rowIds: rowIds2,
    expectedIds,
    rows: rows2,
    discardedFromTabsGet: Object.fromEntries(expectedIds.map((id) => [id, tabs2[id].discarded])),
  };
  check(
    'step2: rows are exactly the 7 test tabs (no extra, none missing, no duplicates)',
    rowIds2.length === expectedIds.length && new Set(rowIds2).size === rowIds2.length && expectedIds.every((id) => rowIds2.includes(id)),
    JSON.stringify(result.step2),
  );
  check('step2: rows in order T1..T5 (W1) then U1, U2 (W2)', JSON.stringify(rowIds2) === JSON.stringify(expectedIds), JSON.stringify(rowIds2));
  check(
    'step2: data-discarded matches tabs.get',
    !!rows2 && rows2.every((r) => !!tabs2[r.id] && r.discarded === String(tabs2[r.id].discarded)),
    JSON.stringify(rows2),
  );
  check('step2: loaded rows have an "Unload tab" X', !!rows2 && rows2.every((r) => r.discarded === 'true' || r.unloadTitle === 'Unload tab'), JSON.stringify(rows2));
  check('step2: no normal tab discarded yet', Object.values(result.step2.discardedFromTabsGet).every((d) => d === false), JSON.stringify(result.step2.discardedFromTabsGet));

  const rowDiscarded = async (id) => (await popupRows(driver)).find((r) => r.id === id)?.discarded;

  // 3. X on T2 (background tab).
  await click(driver, `[data-tab-id="${ids.T2}"] .unload`);
  await waitFor(async () => (await rowDiscarded(ids.T2)) === 'true', 10000);
  result.step3 = { tabs: await tabInfo(driver, [ids.T1, ids.T2]), rowT2: await rowDiscarded(ids.T2) };
  check('step3: T2 discarded', result.step3.tabs[ids.T2].discarded === true, JSON.stringify(result.step3));
  check('step3: T2 row shows unloaded', result.step3.rowT2 === 'true', result.step3.rowT2);
  check('step3: T1 untouched', result.step3.tabs[ids.T1].discarded === false && result.step3.tabs[ids.T1].active === true, JSON.stringify(result.step3.tabs[ids.T1]));

  // 4. X on T1 (current tab): W1 switches to T3 (most recent loaded other tab), then T1 is discarded.
  await click(driver, `[data-tab-id="${ids.T1}"] .unload`);
  await waitFor(async () => (await rowDiscarded(ids.T1)) === 'true', 10000);
  result.step4 = {
    w1ActiveTab: await activeTabOf(driver, ids.W1),
    tabs: await tabInfo(driver, [ids.T1, ids.T3]),
    rowT1: await rowDiscarded(ids.T1),
  };
  check('step4: W1 active tab is T3', result.step4.w1ActiveTab === ids.T3, `got ${result.step4.w1ActiveTab}`);
  check('step4: T1 discarded', result.step4.tabs[ids.T1].discarded === true, JSON.stringify(result.step4.tabs[ids.T1]));
  check('step4: T3 loaded', result.step4.tabs[ids.T3].discarded === false, JSON.stringify(result.step4.tabs[ids.T3]));

  // 5. Unload all others.
  await click(driver, '#unload-others');
  await waitFor(async () => (await rowDiscarded(ids.U2)) === 'true', 10000);
  await sleep(500); // let any wrongful discards land before reading
  const t5 = await tabInfo(driver, allTabIds);
  result.step5 = {
    discarded: Object.fromEntries(['T1', 'T2', 'T3', 'T4', 'T5', 'U1', 'U2'].map((k) => [k, t5[ids[k]].discarded])),
    audibleT4: t5[ids.T4].audible,
    status: await driver.findElement(By.id('status')).getText(),
    rows: await popupRows(driver),
  };
  check('step5: T4 still audible (the reason it was skipped)', result.step5.audibleT4 === true);
  check('step5: U2 discarded', result.step5.discarded.U2 === true);
  for (const k of ['T3', 'T4', 'T5', 'U1']) check(`step5: ${k} not discarded`, result.step5.discarded[k] === false);
  check(
    'step5: rows match tabs.get',
    result.step5.rows.every((r) => r.discarded === String(t5[r.id] ? t5[r.id].discarded : 'missing')),
    JSON.stringify(result.step5.rows),
  );

  // 6. Never unload this site / this page (current tab is now T3).
  await waitFor(async () => driver.executeScript('return !document.getElementById("never-site").disabled && !document.getElementById("never-page").disabled;'), 5000);
  await click(driver, '#never-site');
  await waitFor(async () => (await readSettings(driver)).neverUnload?.includes('127.0.0.1'), 5000);
  await click(driver, '#never-page');
  const t3Url = (await tabInfo(driver, [ids.T3]))[ids.T3].url;
  await waitFor(async () => (await readSettings(driver)).neverUnload?.includes(t3Url), 5000);
  result.step6 = { t3Url, neverUnload: (await readSettings(driver)).neverUnload, status: await driver.findElement(By.id('status')).getText() };
  check('step6: neverUnload includes 127.0.0.1', result.step6.neverUnload.includes('127.0.0.1'), JSON.stringify(result.step6));
  check('step6: neverUnload includes T3 exact URL', result.step6.neverUnload.includes(t3Url), JSON.stringify(result.step6));

  // 7. Pause switch.
  await click(driver, '#pause');
  const pausedOn = await waitFor(async () => (await readSettings(driver)).paused === true, 5000);
  const boxOn = await driver.findElement(By.id('pause')).isSelected();
  await click(driver, '#pause');
  const pausedOff = await waitFor(async () => (await readSettings(driver)).paused === false, 5000);
  const boxOff = await driver.findElement(By.id('pause')).isSelected();
  result.step7 = { pausedAfterFirstClick: pausedOn ? true : (await readSettings(driver)).paused, checkboxAfterFirstClick: boxOn, pausedAfterSecondClick: pausedOff ? false : (await readSettings(driver)).paused, checkboxAfterSecondClick: boxOff };
  check('step7: paused true after first click', result.step7.pausedAfterFirstClick === true && boxOn === true, JSON.stringify(result.step7));
  check('step7: paused false after second click', result.step7.pausedAfterSecondClick === false && boxOff === false, JSON.stringify(result.step7));

  // 8. X on the current tab (T3) while a discarded tab of W1 is more recently used than every loaded
  // one: the replacement must be the most recently used LOADED tab, and no discarded tab gets reloaded.
  {
    const w1Keys = ['T1', 'T2', 'T3', 'T4', 'T5'];
    const before = await tabInfo(driver, w1Keys.map((k) => ids[k]));
    const others = w1Keys.filter((k) => k !== 'T3').map((k) => ({ key: k, ...before[ids[k]] }));
    const loadedOthers = others.filter((t) => !t.discarded);
    const discardedOthers = others.filter((t) => t.discarded);
    const newestLoaded = loadedOthers.reduce((a, b) => ((b.lastAccessed || 0) > (a ? a.lastAccessed || 0 : -1) ? b : a), null);
    const newestDiscarded = discardedOthers.reduce((a, b) => ((b.lastAccessed || 0) > (a ? a.lastAccessed || 0 : -1) ? b : a), null);
    result.step8 = {
      before: Object.fromEntries(w1Keys.map((k) => [k, { active: before[ids[k]].active, discarded: before[ids[k]].discarded, lastAccessed: before[ids[k]].lastAccessed }])),
      newestLoaded: newestLoaded && newestLoaded.key,
      newestDiscarded: newestDiscarded && newestDiscarded.key,
    };
    check('step8 precondition: T3 is the active tab of W1', before[ids.T3].active === true && before[ids.T3].discarded === false, JSON.stringify(result.step8.before));
    check(
      'step8 precondition: a discarded tab is more recently used than every loaded tab',
      !!newestLoaded && !!newestDiscarded && (newestDiscarded.lastAccessed || 0) > (newestLoaded.lastAccessed || 0),
      JSON.stringify(result.step8),
    );
    await click(driver, `[data-tab-id="${ids.T3}"] .unload`);
    await waitFor(async () => (await rowDiscarded(ids.T3)) === 'true', 10000);
    await sleep(300);
    const after = await tabInfo(driver, w1Keys.map((k) => ids[k]));
    result.step8.w1ActiveTab = await activeTabOf(driver, ids.W1);
    result.step8.after = Object.fromEntries(w1Keys.map((k) => [k, { active: after[ids[k]].active, discarded: after[ids[k]].discarded }]));
    check('step8: W1 active tab is the most recently used loaded tab', !!newestLoaded && result.step8.w1ActiveTab === ids[newestLoaded.key], JSON.stringify(result.step8));
    check('step8: T3 discarded', after[ids.T3].discarded === true, JSON.stringify(result.step8.after));
    check('step8: previously discarded tabs stay discarded', discardedOthers.every((t) => after[ids[t.key]].discarded === true), JSON.stringify(result.step8.after));
  }

  // Focusing the popup-type windows must not have changed the remembered normal window.
  result.lastNormalAtEnd = await readLastNormal(driver);
  check('popup windows ignored by focus tracking', result.lastNormalAtEnd.lastNormalWindowId === ids.W1, JSON.stringify(result.lastNormalAtEnd));

  // 9. Screenshot of the popup window.
  await driver.manage().window().setRect({ x: WINDOW_RECT.x, y: WINDOW_RECT.y, ...POPUP_SIZE });
  await sleep(300);
  result.popupRect = await driver.manage().window().getRect();
  result.screenshot = await screenshot(driver, 'popup');
  result.screenshotFile = await readShot(result.screenshot);
  check('screenshot', result.screenshotFile.allowedDir && result.screenshotFile.png, JSON.stringify(result.screenshotFile));
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
