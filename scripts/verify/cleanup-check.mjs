// Cleanup check: four real launches through lib.mjs with injected faults, judged from live process
// listings taken by this script (not from what lib.mjs says about itself).
//   F1 VERIFY_FAULT=before-geckodriver  launch rejects before geckodriver starts
//   F2 VERIFY_FAULT=after-firefox-start launch rejects after Firefox started, before its PID is known
//   F3 VERIFY_FAULT=hang-quit           driver.quit() never settles; close() must still finish in time
//   F4 VERIFY_INJECT_PID=<decoy>        a harmless process's PID sits in the harness's cached list
// Each case runs launch() in a child Node process. The child reports when launch()/close() is done and
// then waits; the process listings are taken while it is still alive, because Windows ends a Node
// process's children together with it, which would hide leaks. Prints one JSON line last; exit code 0
// only if every assertion passes.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const CLOSE_BOUND_MS = 30000;
const CHILD_TIMEOUT_MS = 240000;
const PROCESSES_LOG = 'C:\\Users\\Home\\CoreWise\\_wt\\Firefox-Efficient\\tab-unloader\\.tmp\\long-horizon\\tab-unloader\\processes.log';

// ---------------------------------------------------------------- child: one launch with a fault

async function childRole(caseId) {
  const { launch } = await import('./lib.mjs');
  const out = { caseId, launchCalledAt: Date.now() };
  // Listen from the start: the parent may end stdin before the RESULT line (e.g. if it crashed).
  const released = new Promise((resolve) => {
    process.stdin.once('data', resolve);
    process.stdin.once('end', resolve);
  });
  try {
    const t0 = Date.now();
    out.launchCalledAt = t0;
    const session = await launch({ name: process.env.CC_NAME });
    out.launched = true;
    out.launchMs = Date.now() - t0;
    out.profileDir = session.profileDir;
    out.firefoxPid = session.firefoxPid;
    out.geckodriverPid = session.geckodriverPid;
    out.guardPid = session.guardPid;
    const t1 = Date.now();
    const first = session.close();
    const second = session.close();
    out.closeSamePromise = first === second;
    try {
      out.report = await first;
    } catch (err) {
      out.closeError = err.message;
      out.report = err.report || null;
    }
    out.closeMs = Date.now() - t1;
    // A third call after completion must also settle at once, without new work.
    const t2 = Date.now();
    await session.close().catch(() => {});
    out.thirdCloseMs = Date.now() - t2;
  } catch (err) {
    out.launched = false;
    out.error = String(err && err.message);
    out.launchState = (err && err.launchState) || null;
  }
  process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
  // Stay alive until the parent has taken its listing.
  await released;
  process.stdin.pause();
}

// ---------------------------------------------------------------- parent: run cases, judge live state

function ps(script) {
  const encoded = Buffer.from(
    `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`,
    'utf16le',
  ).toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60000 },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message} ${stderr}`)) : resolve(stdout)),
    );
  });
}

/** Live listing of every process: Map pid -> { pid, ppid, name, cmd, created (Unix ms) }. */
async function snapshot() {
  const out = await ps(
    `$l = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId;
       name = $_.Name; cmd = $_.CommandLine; created = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } })
     ConvertTo-Json -Compress -Depth 2 -InputObject $l`,
  );
  const map = new Map();
  for (const p of JSON.parse(out)) map.set(p.pid, { ...p, cmd: p.cmd || '' });
  return map;
}

const alive = (snap, rec) => {
  const now = snap.get(rec.pid);
  return !!now && now.created === rec.created;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (r) => ({ pid: r.pid, name: r.name, created: r.created });

/** Processes started under the child (created after it), walked through the live tree. */
function descendants(snap, root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const parent = stack.pop();
    for (const p of snap.values()) {
      if (p.ppid === parent.pid && p.pid !== parent.pid && p.created >= parent.created && !found.some((f) => f.pid === p.pid)) {
        found.push(p);
        stack.push(p);
      }
    }
  }
  return found;
}

function tmpEntries(prefix) {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()));
}

/** Prove nothing holds the file open: reopen it for writing, then delete it. */
function releaseFile(file) {
  const res = { file, existed: fs.existsSync(file), reopened: false, deleted: false };
  if (!res.existed) return res;
  try {
    fs.closeSync(fs.openSync(file, 'r+'));
    res.reopened = true;
  } catch (err) {
    res.reopenError = err.code || err.message;
  }
  try {
    fs.rmSync(file);
    res.deleted = !fs.existsSync(file);
  } catch (err) {
    res.deleteError = err.code || err.message;
  }
  return res;
}

async function runCase(caseId, env, decoy) {
  const name = `cc${process.pid}${caseId}`;
  const prefix = `tab-unloader-${name}-`;
  const prefixLc = prefix.toLowerCase();
  const out = { caseId, env, failures: [] };
  const fail = (msg) => out.failures.push(msg);

  const caseStart = Date.now();
  const before = await snapshot();
  const preFirefox = [...before.values()].filter((p) => /^firefox\.exe$/i.test(p.name));
  out.preexistingFirefox = preFirefox.length;

  const child = spawn(process.execPath, [SELF, '--child', caseId], {
    env: { ...process.env, ...env, CC_NAME: name },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true,
  });
  try {
    let stdout = '';
    let stderr = '';
    let result = null;
    child.stdout.on('data', (c) => {
      stdout += c;
      const m = stdout.match(/^RESULT (.*)$/m);
      if (m && !result) result = JSON.parse(m[1]);
    });
    child.stderr.on('data', (c) => (stderr += c));

    // While the child runs, record every process in its tree and every process naming its profile.
    const seen = new Map();
    // Keep the first command line read: a process that is exiting can list with an empty one.
    const remember = (p) => {
      const key = `${p.pid}@${p.created}`;
      if (!seen.has(key) || !seen.get(key).cmd) seen.set(key, p);
    };
    let childRec = null;
    const t0 = Date.now();
    while (!result && child.exitCode === null && Date.now() - t0 < CHILD_TIMEOUT_MS) {
      const snap = await snapshot();
      if (result) break; // listing raced with the end of the case; judge from the final listing only
      childRec = childRec || snap.get(child.pid) || null;
      if (childRec) for (const p of descendants(snap, childRec)) remember(p);
      for (const p of snap.values()) if (p.cmd.toLowerCase().includes(prefixLc)) remember(p);
      await sleep(200);
    }
    for (let i = 0; i < 50 && !result && child.exitCode === null; i++) await sleep(100);
    if (!result) {
      fail(`child gave no RESULT (exit ${child.exitCode}); stderr: ${stderr.slice(-2000)}`);
      return out;
    }
    out.child = result;

    // Final listing while the child is still alive and idle.
    const after = await snapshot();
    out.childAliveAtCheck = alive(after, childRec || { pid: child.pid, created: -1 });
    if (!out.childAliveAtCheck) fail('child exited before the final listing (leaks could be hidden)');
    // The child's own console host (started with the child, before it called launch()) is not the launch's.
    const ownRuntime = (p) => !!childRec && p.ppid === childRec.pid && p.created < result.launchCalledAt;
    out.childRuntime = [...seen.values()].filter(ownRuntime).map(brief);
    for (const [key, p] of seen) if (ownRuntime(p)) seen.delete(key);
    const seenList = [...seen.values()];
    out.seen = {
      firefox: seenList.filter((p) => /^firefox\.exe$/i.test(p.name)).length,
      firefoxWithProfile: seenList.filter((p) => /^firefox\.exe$/i.test(p.name) && p.cmd.toLowerCase().includes(prefixLc)).length,
      geckodriver: seenList.filter((p) => /^geckodriver/i.test(p.name)).length,
      guard: seenList.filter((p) => /offscreen-guard\.ps1/i.test(p.cmd)).length,
      total: seenList.length,
    };
    out.leftSeen = seenList.filter((p) => alive(after, p)).map(brief);
    out.leftUnderChild = childRec ? descendants(after, childRec).filter((p) => !ownRuntime(p)).map(brief) : [];
    out.leftWithProfile = [...after.values()].filter((p) => p.cmd.toLowerCase().includes(prefixLc)).map(brief);
    if (out.leftSeen.length) fail(`processes seen during the case still alive: ${JSON.stringify(out.leftSeen)}`);
    if (out.leftUnderChild.length) fail(`processes still under the child: ${JSON.stringify(out.leftUnderChild)}`);
    if (out.leftWithProfile.length) fail(`processes naming the profile still alive: ${JSON.stringify(out.leftWithProfile)}`);

    // Every firefox.exe that existed before the case must still be the same process.
    const killedByHarness = new Set(
      [...((result.report && result.report.killed) || []), ...((result.launchState && result.launchState.cleanup && result.launchState.cleanup.killed) || [])]
        .filter((k) => k.result === 'killed')
        .map((k) => `${k.pid}@${k.created}`),
    );
    const missing = preFirefox.filter((p) => !alive(after, p));
    out.preexistingFirefoxAfter = preFirefox.length - missing.length;
    out.preexistingMissing = missing.map((p) => {
      // Find the topmost firefox.exe above it in the "before" listing, to tell who owned it.
      let root = p;
      for (let parent = before.get(root.ppid); parent && /^firefox\.exe$/i.test(parent.name) && parent.created <= root.created; parent = before.get(root.ppid)) root = parent;
      const rootParent = before.get(root.ppid);
      return {
        ...brief(p),
        killedByHarness: killedByHarness.has(`${p.pid}@${p.created}`),
        root: brief(root),
        rootAlive: alive(after, root),
        rootParent: rootParent ? rootParent.name : null,
      };
    });
    for (const m of out.preexistingMissing) {
      // Pass only when the process ended for a reason outside this case: the harness did not kill it,
      // it is not a root itself, and its own Firefox root is still running (a tab process the user's or
      // another session's Firefox closed), or its root sat under another geckodriver (another session's
      // test run that ended on its own).
      const elsewhere = !m.killedByHarness && m.root.pid !== m.pid && (m.rootAlive || /^geckodriver/i.test(m.rootParent || ''));
      m.exitedElsewhere = elsewhere;
      if (!elsewhere) fail(`pre-existing firefox.exe ${m.pid} gone after the case: ${JSON.stringify(m)}`);
    }
    // Nothing the harness reports killing may predate the case.
    const killedOld = [...killedByHarness].filter((k) => Number(k.split('@')[1]) < caseStart);
    if (killedOld.length) fail(`harness killed processes created before the case: ${killedOld.join(', ')}`);

    // Files: profile dir gone, log (kept only on failure) not held open.
    const profileDir = result.profileDir || (result.launchState && result.launchState.profileDir);
    out.profileDir = profileDir || null;
    out.profileGone = !!profileDir && !fs.existsSync(profileDir);
    if (!profileDir) fail('no profile dir reported');
    else if (!out.profileGone) fail(`profile dir still exists: ${profileDir}`);
    const leftovers = tmpEntries(prefix);
    out.tmpEntriesAfter = leftovers;
    const gdLogs = leftovers.filter((n) => /-geckodriver-\d+\.log$/i.test(n));
    out.logs = gdLogs.map((n) => releaseFile(path.join(os.tmpdir(), n)));
    for (const l of out.logs) if (!l.reopened || !l.deleted) fail(`log file held or not deletable: ${JSON.stringify(l)}`);
    const otherLeft = tmpEntries(prefix);
    if (otherLeft.length) fail(`temp entries left for this launch: ${otherLeft.join(', ')}`);

    // Case-specific assertions.
    const ls = result.launchState;
    if (caseId === 'F1') {
      if (result.launched) fail('launch resolved; expected rejection');
      if (!/before-geckodriver/.test(result.error || '')) fail(`unexpected error: ${result.error}`);
      if (!ls || !ls.gdLogPath) fail('launchState without log path');
      if (ls && ls.geckodriverPid) fail(`geckodriver was started (pid ${ls.geckodriverPid})`);
      if (out.seen.geckodriver || out.seen.firefox || out.seen.guard) fail(`processes started despite the early fault: ${JSON.stringify(out.seen)}`);
      if (out.logs.length !== 1) fail(`expected exactly one kept log, found ${out.logs.length}`);
    }
    if (caseId === 'F2') {
      if (result.launched) fail('launch resolved; expected rejection');
      if (!/after-firefox-start/.test(result.error || '')) fail(`unexpected error: ${result.error}`);
      if (ls && ls.firefoxPid) fail(`firefoxPid was learned (${ls.firefoxPid}); the fault is meant to hide it`);
      // Non-vacuous: Firefox, geckodriver and the guard really ran.
      if (out.seen.firefoxWithProfile < 1) fail('no Firefox with this profile was ever seen; fault fired too early');
      if (out.seen.geckodriver < 1) fail('geckodriver never seen');
      if (out.seen.guard < 1) fail('offscreen guard never seen');
      if (ls && ls.cleanupError) fail(`cleanup error: ${ls.cleanupError}`);
      if (out.logs.length !== 1) fail(`expected exactly one kept log, found ${out.logs.length}`);
    }
    if (caseId === 'F3' || caseId === 'F4') {
      if (!result.launched) fail(`launch failed: ${result.error}`);
      if (result.closeError) fail(`close() threw: ${result.closeError}`);
      if (!result.closeSamePromise) fail('second close() call did not return the first call\'s promise');
      if (!(result.thirdCloseMs < 1000)) fail(`close() after completion took ${result.thirdCloseMs} ms`);
      if (out.seen.firefoxWithProfile < 1 || out.seen.geckodriver < 1 || out.seen.guard < 1) fail(`launch processes not all seen: ${JSON.stringify(out.seen)}`);
    }
    if (caseId === 'F3') {
      if (!(result.closeMs <= CLOSE_BOUND_MS)) fail(`close() took ${result.closeMs} ms (bound ${CLOSE_BOUND_MS})`);
      if (!result.report || result.report.quit !== 'timeout') fail(`quit outcome ${result.report && result.report.quit}, expected timeout`);
    }
    if (caseId === 'F4') {
      out.decoy = { ...brief(decoy), aliveAfter: alive(after, decoy) };
      if (!out.decoy.aliveAfter) fail(`decoy ${decoy.pid} was killed`);
      const rep = result.report || {};
      out.decoy.reportedSkipped = (rep.skippedCandidates || []).includes(decoy.pid);
      out.decoy.reportedKilled = (rep.killed || []).some((k) => k.pid === decoy.pid);
      if (!out.decoy.reportedSkipped) fail('decoy PID not listed as a skipped candidate (was it injected?)');
      if (out.decoy.reportedKilled) fail('harness reports acting on the decoy PID');
      if (rep.quit !== 'ok') fail(`quit outcome ${rep.quit}, expected ok`);
    }
  } finally {
    // Release the child. It finishes any launch()/close() still running (bounded by their own
    // timeouts), then exits; it is detached, so a crash of this script would not kill it mid-cleanup.
    child.stdin.end('exit');
    for (let i = 0; i < 1200 && child.exitCode === null; i++) await sleep(100);
    out.childExit = child.exitCode;
    if (child.exitCode === null) {
      child.kill();
      fail('child did not exit within 120 s of release');
    }
  }
  out.ok = out.failures.length === 0;
  return out;
}

async function parentRole() {
  const results = [];
  const failures = [];
  // F4 decoy: harmless, long-lived, outside the harness tree.
  const decoyProc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  try {
    fs.appendFileSync(
      PROCESSES_LOG,
      `${new Date().toISOString()} pid=${decoyProc.pid} port=- cmd=node -e "setTimeout(() => {}, 120000)" (round 7 cleanup-check F4 decoy, ended by the check)\n`,
    );
  } catch {
    // log is a convenience; the check ends the decoy itself
  }
  try {
    const cases = [
      ['F1', { VERIFY_FAULT: 'before-geckodriver' }],
      ['F2', { VERIFY_FAULT: 'after-firefox-start' }],
      ['F3', { VERIFY_FAULT: 'hang-quit' }],
      ['F4', { VERIFY_INJECT_PID: String(decoyProc.pid) }],
    ];
    let decoy = null;
    for (const [caseId, env] of cases) {
      if (caseId === 'F4') {
        const snap = await snapshot();
        decoy = snap.get(decoyProc.pid);
        if (!decoy) {
          failures.push('F4: decoy not running before the case');
          continue;
        }
      }
      let r;
      try {
        r = await runCase(caseId, { VERIFY_FAULT: '', VERIFY_INJECT_PID: '', ...env }, decoy);
      } catch (err) {
        r = { caseId, failures: [`check error: ${(err && err.stack) || err}`], ok: false };
      }
      results.push(r);
      for (const f of r.failures) failures.push(`${caseId}: ${f}`);
    }
  } finally {
    decoyProc.kill();
    for (let i = 0; i < 50 && decoyProc.exitCode === null && decoyProc.signalCode === null; i++) await sleep(100);
  }
  const decoyEnded = decoyProc.exitCode !== null || decoyProc.signalCode !== null;
  if (!decoyEnded) failures.push('decoy still running at the end of the check');
  const summary = {
    ok: failures.length === 0,
    cases: results,
    decoyEndedByCheck: decoyEnded,
    failures,
  };
  console.log(JSON.stringify(summary));
  process.exitCode = summary.ok ? 0 : 1;
}

// Dispatch last: the helpers above are const bindings that must be initialised first.
if (process.argv[2] === '--child') await childRole(process.argv[3]);
else await parentRole();
