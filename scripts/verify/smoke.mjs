// Smoke check: real headed Firefox with the addon from src/. Prints one JSON line (last stdout line)
// whose values are all read back from the running browser. Exit code 0 only if every check passes.
import { stat } from 'node:fs/promises';
import { launch, extEval, chromeEval, screenshot, WINDOW_RECT } from './lib.mjs';
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
  check('firefoxVersion', /^140\./.test(String(result.firefoxVersion)), `got ${result.firefoxVersion}`);

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

  result.windowRect = await driver.manage().window().getRect();
  check(
    'windowRect',
    result.windowRect.x <= WINDOW_RECT.x + 100 && result.windowRect.y <= WINDOW_RECT.y + 100,
    JSON.stringify(result.windowRect),
  );

  result.volumeScale = await chromeEval(driver, () => Services.prefs.getCharPref('media.volume_scale'));
  check('volumeScale', result.volumeScale === '0.0', `got ${result.volumeScale}`);

  result.screenshot = await screenshot(driver, 'smoke');
  const shotSize = (await stat(result.screenshot)).size;
  check('screenshot', /^D:\\screenshots\\Firefox-Efficient\\/i.test(result.screenshot) && shotSize > 0, `${result.screenshot} (${shotSize} bytes)`);
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
