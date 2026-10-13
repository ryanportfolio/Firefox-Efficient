// Options page check: real headed Firefox with the addon from src/. Opens options/options.html in a tab of
// the normal window, drives it through WebDriver and reads storage back through extEval. Prints one JSON
// line (last stdout line) whose values are all read from the running browser. Exit code 0 only if every
// check passes.
import { stat } from 'node:fs/promises';
import { By, Key } from 'selenium-webdriver';
import { launch, extEval, screenshot, EXT_BASE } from './lib.mjs';

const OPTIONS_URL = `${EXT_BASE}/options/options.html`;

const result = {};
const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const readStorage = (driver) => extEval(driver, () => browser.storage.local.get(null));

/** Poll storage until pred(storage) is true or the timeout passes; returns the last read. */
async function waitStorage(driver, pred, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = await readStorage(driver);
  while (!pred(last) && Date.now() < deadline) {
    await sleep(100);
    last = await readStorage(driver);
  }
  return last;
}

async function waitReady(driver) {
  await driver.wait(
    async () => (await driver.executeScript('return document.body && document.body.dataset.ready;')) === 'true',
    10000,
    'options page did not finish loading settings',
  );
}

const idleValue = (driver) => driver.findElement(By.id('idle-minutes')).getAttribute('value');
const listedEntries = (driver) =>
  driver.executeScript('return [...document.querySelectorAll("#entries [data-entry]")].map((li) => li.dataset.entry);');

/** Poll the page's entry list until pred(list) is true or the timeout passes; returns the last read. */
async function waitList(driver, pred, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = await listedEntries(driver);
  while (!pred(last) && Date.now() < deadline) {
    await sleep(100);
    last = await listedEntries(driver);
  }
  return last;
}

async function errorState(driver, id) {
  const el = await driver.findElement(By.id(id));
  return { displayed: await el.isDisplayed(), text: (await el.getText()).trim() };
}

async function typeInto(driver, id, text) {
  const el = await driver.findElement(By.id(id));
  await el.clear();
  await el.sendKeys(text);
  return el;
}

async function saveIdle(driver, text) {
  await typeInto(driver, 'idle-minutes', text);
  await driver.findElement(By.id('save-idle')).click();
}

let session = null;
try {
  session = await launch({ name: 'options' });
  const { driver } = session;

  // Open the options page in a tab of the test's normal window.
  await driver.get(OPTIONS_URL);
  await waitReady(driver);
  result.pageUrl = await driver.getCurrentUrl();
  check('pageUrl', result.pageUrl === OPTIONS_URL, result.pageUrl);
  result.windowType = await extEval(
    driver,
    async (url) => {
      const tabs = (await browser.tabs.query({})).filter((t) => t.url === url);
      if (tabs.length !== 1) return { count: tabs.length };
      const win = await browser.windows.get(tabs[0].windowId);
      return { count: 1, type: win.type };
    },
    OPTIONS_URL,
  );
  check('options tab in a normal window', result.windowType.count === 1 && result.windowType.type === 'normal', JSON.stringify(result.windowType));

  // 1. Fresh page shows the defaults.
  result.step1 = { idleInput: await idleValue(driver), entries: await listedEntries(driver), storage: await readStorage(driver) };
  check('1 idle input shows 30', result.step1.idleInput === '30', `got ${JSON.stringify(result.step1.idleInput)}`);
  check('1 entries empty', same(result.step1.entries, []), JSON.stringify(result.step1.entries));

  // 2. Save 45, then reload.
  await saveIdle(driver, '45');
  const s2 = await waitStorage(driver, (s) => s.idleMinutes === 45);
  const saved2 = await driver.findElement(By.id('idle-saved'));
  result.step2 = {
    storedIdleMinutes: s2.idleMinutes,
    storedType: typeof s2.idleMinutes,
    savedShown: await saved2.isDisplayed(),
    savedText: (await saved2.getText()).trim(),
  };
  check('2 storage idleMinutes === 45', s2.idleMinutes === 45, `got ${JSON.stringify(s2.idleMinutes)}`);
  check('2 Saved confirmation shown', result.step2.savedShown && result.step2.savedText.length > 0, JSON.stringify(result.step2));
  await driver.navigate().refresh();
  await waitReady(driver);
  result.step2.idleInputAfterReload = await idleValue(driver);
  check('2 input shows 45 after reload', result.step2.idleInputAfterReload === '45', `got ${JSON.stringify(result.step2.idleInputAfterReload)}`);

  // 3. Invalid minutes are refused and storage keeps 45.
  result.step3 = {};
  for (const bad of ['0', '2.5']) {
    await saveIdle(driver, bad);
    await driver.wait(async () => (await errorState(driver, 'idle-error')).displayed, 3000).catch(() => {});
    const err = await errorState(driver, 'idle-error');
    await sleep(300); // give any (wrong) write a chance to land before reading storage
    const s3 = await readStorage(driver);
    result.step3[bad] = { inputValue: await idleValue(driver), error: err, storedIdleMinutes: s3.idleMinutes };
    check(`3 [${bad}] #idle-error displayed`, err.displayed, JSON.stringify(err));
    check(`3 [${bad}] #idle-error text`, err.text.length > 0, JSON.stringify(err));
    check(`3 [${bad}] storage still 45`, s3.idleMinutes === 45, `got ${JSON.stringify(s3.idleMinutes)}`);
  }

  // 4. Add a site (button) and an exact page (Enter key).
  await typeInto(driver, 'entry-input', 'example.com');
  await driver.findElement(By.id('add-entry')).click();
  await waitStorage(driver, (s) => same(s.neverUnload, ['example.com']));
  const input4 = await typeInto(driver, 'entry-input', 'https://x.com/home');
  await input4.sendKeys(Key.ENTER);
  const want4 = ['example.com', 'https://x.com/home'];
  const s4 = await waitStorage(driver, (s) => same(s.neverUnload, want4));
  result.step4 = { storedNeverUnload: s4.neverUnload, listed: await waitList(driver, (l) => same(l, want4)) };
  check('4 storage has both entries', same(s4.neverUnload, want4), JSON.stringify(s4.neverUnload));
  check('4 list shows both entries', same(result.step4.listed, want4), JSON.stringify(result.step4.listed));

  // 5. Remove example.com through its .remove button.
  await driver.findElement(By.css('[data-entry="example.com"] .remove')).click();
  const want5 = ['https://x.com/home'];
  const s5 = await waitStorage(driver, (s) => same(s.neverUnload, want5));
  result.step5 = { storedNeverUnload: s5.neverUnload, listed: await waitList(driver, (l) => same(l, want5)) };
  check('5 storage only https://x.com/home', same(s5.neverUnload, want5), JSON.stringify(s5.neverUnload));
  check('5 list only https://x.com/home', same(result.step5.listed, want5), JSON.stringify(result.step5.listed));

  // 6. An invalid entry is refused and storage is unchanged.
  const before6 = await readStorage(driver);
  await typeInto(driver, 'entry-input', 'not a url!!');
  await driver.findElement(By.id('add-entry')).click();
  await driver.wait(async () => (await errorState(driver, 'entry-error')).displayed, 3000).catch(() => {});
  const err6 = await errorState(driver, 'entry-error');
  await sleep(300);
  const s6 = await readStorage(driver);
  result.step6 = { error: err6, storageBefore: before6, storageAfter: s6, listed: await listedEntries(driver) };
  check('6 #entry-error displayed', err6.displayed, JSON.stringify(err6));
  check('6 #entry-error text', err6.text.length > 0, JSON.stringify(err6));
  check('6 storage unchanged', same(s6, before6), `${JSON.stringify(before6)} -> ${JSON.stringify(s6)}`);

  // 7. Reload: the list comes back from storage.
  await driver.navigate().refresh();
  await waitReady(driver);
  result.step7 = { listed: await listedEntries(driver), idleInput: await idleValue(driver) };
  check('7 list after reload', same(result.step7.listed, ['https://x.com/home']), JSON.stringify(result.step7.listed));

  // 7b. Changes made elsewhere (here: the harness page, as the popup would) show up without a reload.
  await extEval(driver, async () => {
    await TabUnloaderSettings.addEntry('youtube.com');
    await TabUnloaderSettings.set({ idleMinutes: 60 });
  });
  const want7b = ['https://x.com/home', 'youtube.com'];
  result.step7b = { listed: await waitList(driver, (l) => same(l, want7b)) };
  const deadline7b = Date.now() + 5000;
  let idle7b = await idleValue(driver);
  while (idle7b !== '60' && Date.now() < deadline7b) {
    await sleep(100);
    idle7b = await idleValue(driver);
  }
  result.step7b.idleInput = idle7b;
  check('7b list follows storage changes', same(result.step7b.listed, want7b), JSON.stringify(result.step7b.listed));
  check('7b idle input follows storage changes', idle7b === '60', `got ${JSON.stringify(idle7b)}`);

  // 8. Screenshot of the options page.
  result.screenshot = await screenshot(driver, 'options');
  const shotSize = (await stat(result.screenshot)).size;
  check('8 screenshot', /^D:\\screenshots\\Firefox-Efficient\\/i.test(result.screenshot) && shotSize > 0, `${result.screenshot} (${shotSize} bytes)`);
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
}

result.ok = failures.length === 0;
result.failures = failures;
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
