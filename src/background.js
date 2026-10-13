/* Background event page: once a minute, unload (discard) tabs that have been idle longer than the
   user's limit. settings.js loads first and defines globalThis.TabUnloaderSettings. */
"use strict";

const ALARM = "tab-unloader-check";
const PERIOD_MINUTES = 1;
// A gap this long between checks means the computer slept; idle time restarts from the wake.
const WAKE_GAP_MS = 3 * 60000;

// Session storage clears when the browser restarts, which is what lastCheckAt and wakeAt need.
const runState = browser.storage.session || browser.storage.local;

async function ensureAlarm() {
  // Recreating an existing alarm would push its next run back, and this runs on every event page start,
  // so only (re)create it when it is missing or has the wrong period.
  const alarm = await browser.alarms.get(ALARM);
  if (!alarm || alarm.periodInMinutes !== PERIOD_MINUTES) {
    await browser.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
  }
}

function logError(err) {
  console.error("Tab Unloader:", err);
}

function keepReason(tab, settings) {
  if (tab.active) return "active";
  if (tab.discarded) return "discarded";
  if (tab.pinned) return "pinned";
  if (tab.audible) return "audible";
  const sharing = tab.sharingState;
  if (sharing && (sharing.camera || sharing.microphone || sharing.screen)) return "sharing";
  if (TabUnloaderSettings.matches(tab.url, settings.neverUnload)) return "never-unload";
  return null;
}

async function check(now) {
  const settings = await TabUnloaderSettings.get();

  const { lastCheckAt, wakeAt } = await runState.get(["lastCheckAt", "wakeAt"]);
  if (typeof lastCheckAt === "number" && now - lastCheckAt > WAKE_GAP_MS) {
    await runState.set({ wakeAt: now, lastCheckAt: now });
    return { now, wake: true, discarded: [], kept: {} };
  }
  await runState.set({ lastCheckAt: now });

  if (settings.paused) return { now, paused: true, discarded: [], kept: {} };

  const keepOrIdle = (tab, current) => {
    const reason = keepReason(tab, current);
    if (reason) return reason;
    const idle = now - Math.max(tab.lastAccessed || 0, wakeAt || 0);
    return idle < current.idleMinutes * 60000 ? "recent" : null;
  };

  const report = { now, discarded: [], kept: {} };
  // Tabs of every window. Pages Firefox will not unload end up as "refused" or "error" below.
  const tabs = await browser.tabs.query({});
  for (let i = 0; i < tabs.length; i++) {
    const reason = keepOrIdle(tabs[i], settings);
    if (reason) {
      report.kept[tabs[i].id] = reason;
      continue;
    }
    // Each discard waits on the browser, so the user can pause, add a never-unload entry, pin or switch
    // to a tab while the batch runs. Decide again on fresh settings and the tab's current state.
    const latest = await TabUnloaderSettings.get();
    if (latest.paused) {
      for (const rest of tabs.slice(i)) report.kept[rest.id] = "paused";
      break;
    }
    let tab;
    try {
      tab = await browser.tabs.get(tabs[i].id);
    } catch (err) {
      report.kept[tabs[i].id] = "closed";
      continue;
    }
    const freshReason = keepOrIdle(tab, latest);
    if (freshReason) {
      report.kept[tab.id] = freshReason;
      continue;
    }
    try {
      await browser.tabs.discard(tab.id);
      // Firefox can resolve without discarding (for example a tab with a beforeunload prompt).
      if ((await browser.tabs.get(tab.id)).discarded) report.discarded.push(tab.id);
      else report.kept[tab.id] = "refused";
    } catch (err) {
      report.kept[tab.id] = "error: " + ((err && err.message) || err);
    }
  }
  return report;
}

// Alarm and message checks share lastCheckAt, so run them one at a time.
let queue = Promise.resolve();
function runCheck(now) {
  const run = queue.then(() => check(now));
  queue = run.catch(() => {});
  return run;
}

const startAlarm = () => ensureAlarm().catch(logError);
browser.runtime.onInstalled.addListener(startAlarm);
browser.runtime.onStartup.addListener(startAlarm);
startAlarm();

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runCheck(Date.now()).catch(logError);
});

browser.runtime.onMessage.addListener((message) => {
  if (!message) return undefined;
  if (message.type === "runCheck") return runCheck(typeof message.now === "number" ? message.now : Date.now());
  // Never-unload list changes from the popup and options page, applied one at a time.
  if (message.type === "neverUnload") return TabUnloaderSettings.handleMessage(message);
  return undefined;
});
