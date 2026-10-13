// Smoke check: real headed Firefox with the addon from src/. Prints one JSON line (last stdout line)
// whose values are all read back from the running browser. Exit code 0 only if every check passes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launch, extEval, chromeEval, screenshot, WINDOW_RECT, ROOT } from './lib.mjs';
import { startFixtureServer } from './fixtures/server.mjs';

const MATCH_CASES = [
  { entry: 'youtube.com', url: 'https://www.youtube.com/watch?v=1', expect: true },
  { entry: 'youtube.com', url: 'https://notyoutube.com/', expect: false },
  { entry: '127.0.0.1', url: 'http://127.0.0.1:5000/x', expect: true },
  { entry: 'https://x.com/home', url: 'https://x.com/home', expect: true },
  { entry: 'https://x.com/home', url: 'https://x.com/home?a=1', expect: false },
];
const VALIDATE_CASES = [
  { input: 'not a url!!', expectOk: false },
  { input: 'example.com', expectOk: true },
  { input: 'https://x.com/home', expectOk: true },
];

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
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
};

let session = null;
let server = null;
try {
  server = await startFixtureServer();
  session = await launch({ name: 'smoke' });
  const { driver } = session;

  const caps = await driver.getCapabilities();
  result.firefoxVersion = caps.get('browserVersion');
  // The add-on supports Firefox 140 or later.
  check('firefoxVersion', Number.parseInt(String(result.firefoxVersion), 10) >= 140, `got ${result.firefoxVersion}`);

  result.addonId = session.addonId;
  check('addonId', result.addonId === 'tab-unloader@ryanportfolio', `got ${result.addonId}`);

  await driver.get(`${server.url}page.html?t=Smoke`);

  result.manifestVersion = await extEval(driver, () => browser.runtime.getManifest().manifest_version);
  check('manifestVersion', result.manifestVersion === 3, `got ${result.manifestVersion}`);

  const defaultsRead = await extEval(driver, async () => ({
    storageKeys: Object.keys(await browser.storage.local.get(null)),
    settings: await TabUnloaderSettings.get(),
  }));
  result.defaults = defaultsRead.settings;
  check('storage empty before defaults read', defaultsRead.storageKeys.length === 0, defaultsRead.storageKeys.join(','));
  check(
    'defaults',
    JSON.stringify(result.defaults) === JSON.stringify({ idleMinutes: 30, paused: false, neverUnload: [] }),
    JSON.stringify(result.defaults),
  );

  result.matching = await extEval(
    driver,
    (matchCases, validateCases) => ({
      matches: matchCases.map((c) => ({ ...c, got: TabUnloaderSettings.matches(c.url, [c.entry]) })),
      validate: validateCases.map((c) => ({ ...c, got: TabUnloaderSettings.validateEntry(c.input) })),
    }),
    MATCH_CASES,
    VALIDATE_CASES,
  );
  for (const c of result.matching.matches) {
    check(`matches(${c.url}, [${c.entry}])`, c.got === c.expect, `got ${c.got}, expected ${c.expect}`);
  }
  for (const c of result.matching.validate) {
    check(`validateEntry(${c.input})`, c.got && c.got.ok === c.expectOk, JSON.stringify(c.got));
    if (c.got && !c.got.ok) check(`validateEntry(${c.input}) error message`, typeof c.got.error === 'string' && c.got.error.length > 0);
  }

  // Host entries are stored in the form Firefox's URL parser gives the tab's hostname.
  result.hostNormalization = await extEval(driver, () => {
    const S = TabUnloaderSettings;
    const ipv4 = S.validateEntry('127.000.0.001');
    const idn = S.validateEntry('bücher.de');
    return {
      ipv4,
      legacyIpv4Matches: S.matches('http://127.0.0.1/x', ['127.000.0.001']),
      singleLabel: S.validateEntry('com'),
      localhost: S.validateEntry('localhost'),
      idn,
      idnMatches: idn.ok ? S.matches('https://bücher.de/', [idn.value]) : null,
      mixedCase: S.validateEntry('Example.COM'),
    };
  });
  {
    const h = result.hostNormalization;
    const show = (v) => JSON.stringify(v);
    check('validateEntry(127.000.0.001)', h.ipv4.ok === true && h.ipv4.value === '127.0.0.1', show(h.ipv4));
    check('matches(http://127.0.0.1/x, [127.000.0.001])', h.legacyIpv4Matches === true, `got ${h.legacyIpv4Matches}`);
    check('validateEntry(com) rejected', h.singleLabel.ok === false && typeof h.singleLabel.error === 'string' && h.singleLabel.error.length > 0, show(h.singleLabel));
    check('validateEntry(localhost)', h.localhost.ok === true && h.localhost.value === 'localhost', show(h.localhost));
    check('validateEntry(bücher.de)', h.idn.ok === true && h.idn.value === 'xn--bcher-kva.de', show(h.idn));
    check('matches(https://bücher.de/, [validated value])', h.idnMatches === true, `got ${h.idnMatches}`);
    check('validateEntry(Example.COM)', h.mixedCase.ok === true && h.mixedCase.value === 'example.com', show(h.mixedCase));
  }

  // Never-unload changes made at the same time must all land: the background page applies them one at
  // a time. Three adds started together from the harness page, then two removes started together.
  result.concurrent = await extEval(driver, async () => {
    const S = TabUnloaderSettings;
    const stored = async () => (await browser.storage.local.get('neverUnload')).neverUnload;
    const harnessIsBackground = browser.extension.getBackgroundPage() === window;
    const adds = await Promise.all([S.addEntry('a.example.com'), S.addEntry('b.example.com'), S.addEntry('c.example.com')]);
    const afterAdds = await stored();
    // Start the removes from all three entries even if an add was lost, so they are tested on their own.
    await S.set({ neverUnload: ['a.example.com', 'b.example.com', 'c.example.com'] });
    const removes = await Promise.all([S.removeEntry('a.example.com'), S.removeEntry('b.example.com')]);
    const afterRemoves = await stored();
    return { harnessIsBackground, adds, afterAdds, removes, afterRemoves };
  });
  {
    const c = result.concurrent;
    const sorted = (list) => (Array.isArray(list) ? list.slice().sort() : list);
    check('concurrent: harness page is not the background page', c.harnessIsBackground === false, `got ${c.harnessIsBackground}`);
    check('concurrent adds: results ok', c.adds.every((r) => r && r.ok === true), JSON.stringify(c.adds));
    check(
      'concurrent adds: all three stored',
      JSON.stringify(sorted(c.afterAdds)) === JSON.stringify(['a.example.com', 'b.example.com', 'c.example.com']),
      JSON.stringify(c.afterAdds),
    );
    check('concurrent removes: results ok', c.removes.every((r) => r && r.ok === true), JSON.stringify(c.removes));
    check('concurrent removes: only c.example.com left', JSON.stringify(c.afterRemoves) === JSON.stringify(['c.example.com']), JSON.stringify(c.afterRemoves));
  }

  // The same from two extension pages at once: the options page in a tab of the normal window and the
  // harness page each start changes, together.
  result.concurrentTwoPages = await extEval(driver, async (optionsPath) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const stored = async () => (await browser.storage.local.get('neverUnload')).neverUnload;
    const [normal] = await browser.windows.getAll({ windowTypes: ['normal'] });
    const tab = await browser.tabs.create({ windowId: normal.id, url: browser.runtime.getURL(optionsPath), active: false });
    try {
      let view = null;
      for (let i = 0; i < 100 && !view; i++) {
        view = browser.extension
          .getViews({ type: 'tab' })
          .find((v) => v.location.pathname === '/' + optionsPath && typeof v.TabUnloaderSettings === 'object' && v.document.readyState === 'complete');
        if (!view) await sleep(100);
      }
      if (!view) throw new Error('options page did not load');
      const other = view.TabUnloaderSettings;
      const S = TabUnloaderSettings;
      const otherIsBackground = view.browser.extension.getBackgroundPage() === view;
      const results = await Promise.all([
        other.addEntry('d.example.com'),
        S.addEntry('e.example.com'),
        other.addEntry('f.example.com'),
        S.removeEntry('c.example.com'),
        other.addEntry('g.example.com'),
      ]);
      return { otherIsBackground, results: JSON.parse(JSON.stringify(results)), stored: await stored() };
    } finally {
      await browser.tabs.remove(tab.id);
    }
  }, 'options/options.html');
  {
    const c = result.concurrentTwoPages;
    check('two pages: options page is not the background page', c.otherIsBackground === false, `got ${c.otherIsBackground}`);
    check('two pages: results ok', c.results.every((r) => r && r.ok === true), JSON.stringify(c.results));
    check(
      'two pages: all changes stored',
      JSON.stringify(Array.isArray(c.stored) ? c.stored.slice().sort() : c.stored) ===
        JSON.stringify(['d.example.com', 'e.example.com', 'f.example.com', 'g.example.com']),
      JSON.stringify(c.stored),
    );
  }

  result.windowRect = await driver.manage().window().getRect();
  check(
    'windowRect',
    result.windowRect.x <= WINDOW_RECT.x + 100 && result.windowRect.y <= WINDOW_RECT.y + 100,
    JSON.stringify(result.windowRect),
  );

  result.volumeScale = await chromeEval(driver, () => Services.prefs.getCharPref('media.volume_scale'));
  check('volumeScale', result.volumeScale === '0.0', `got ${result.volumeScale}`);

  result.screenshot = await screenshot(driver, 'smoke');
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
