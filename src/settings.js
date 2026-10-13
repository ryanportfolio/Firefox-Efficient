/* Shared settings schema for the background script, popup and options page.
   Classic script: loaded with <script src> and background.scripts, so no ES module syntax. */
"use strict";

(function () {
  const DEFAULTS = Object.freeze({
    idleMinutes: 30,
    paused: false,
    neverUnload: Object.freeze([]),
  });

  const URL_ENTRY = /^https?:\/\//i;
  const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const DIGITS = /^\d+$/;

  function copyDefaults() {
    return { idleMinutes: DEFAULTS.idleMinutes, paused: DEFAULTS.paused, neverUnload: [] };
  }

  async function get() {
    const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
    const merged = copyDefaults();
    for (const key of Object.keys(DEFAULTS)) {
      if (stored[key] !== undefined) merged[key] = stored[key];
    }
    merged.neverUnload = Array.isArray(merged.neverUnload) ? merged.neverUnload.slice() : [];
    return merged;
  }

  async function set(patch) {
    await browser.storage.local.set(patch);
  }

  function validHost(host) {
    if (host.length > 253) return false;
    const labels = host.split(".");
    if (!labels.every((label) => LABEL.test(label))) return false;
    // All-numeric names must be a real IPv4 address.
    if (labels.every((label) => DIGITS.test(label))) {
      return labels.length === 4 && labels.every((label) => Number(label) <= 255);
    }
    return true;
  }

  // The hostname the browser's URL parser gives this site name (lowercase, IPv4 in dotted-decimal form,
  // international names in punycode), or null if the parser refuses it.
  function normalizeHost(host) {
    try {
      return new URL("http://" + host).hostname;
    } catch (e) {
      return null;
    }
  }

  function validateEntry(str) {
    const text = typeof str === "string" ? str.trim() : "";
    if (!text) return { ok: false, value: null, error: "Enter a site name or a page address." };

    if (URL_ENTRY.test(text)) {
      let url;
      try {
        url = new URL(text);
      } catch (e) {
        return { ok: false, value: null, error: "That page address is not valid." };
      }
      if (!url.hostname) return { ok: false, value: null, error: "That page address has no site name." };
      return { ok: true, value: url.href, error: null };
    }

    if (HAS_SCHEME.test(text) && !/^[^:\/]+:\d+$/.test(text)) {
      return { ok: false, value: null, error: "Only http and https page addresses can be added." };
    }

    const typed = text.toLowerCase();
    if (/[\/\\?#]/.test(typed)) {
      return { ok: false, value: null, error: "A site name has no path. Use a full https:// address for one page." };
    }
    if (typed.includes(":")) {
      return { ok: false, value: null, error: "Leave out the port number." };
    }
    const host = typed.includes("@") ? null : normalizeHost(typed);
    if (!host || !validHost(host)) {
      return { ok: false, value: null, error: "Enter a site name like example.com or a page address like https://example.com/page." };
    }
    if (!host.includes(".") && host !== "localhost") {
      return { ok: false, value: null, error: "Enter the full site name, like example.com. Only localhost works without a dot." };
    }
    return { ok: true, value: host, error: null };
  }

  function sameHref(a, b) {
    try {
      return new URL(a).href === new URL(b).href;
    } catch (e) {
      return false;
    }
  }

  function matches(url, list) {
    if (!Array.isArray(list) || list.length === 0) return false;
    let tab;
    try {
      tab = new URL(url);
    } catch (e) {
      return false;
    }
    const web = tab.protocol === "http:" || tab.protocol === "https:";
    const hostname = tab.hostname.toLowerCase();
    for (const entry of list) {
      if (typeof entry !== "string" || !entry) continue;
      if (URL_ENTRY.test(entry)) {
        if (sameHref(url, entry)) return true;
      } else if (web) {
        // Entries saved before host normalization may be in typed form (127.000.0.001, bücher.de).
        const host = /[\/\\?#:@]/.test(entry) ? null : normalizeHost(entry.toLowerCase());
        if (host && (hostname === host || hostname.endsWith("." + host))) return true;
      }
    }
    return false;
  }

  // The never-unload list is read, changed and written back as a whole, so two changes running at the
  // same time (popup and options page, or two quick clicks) could each overwrite the other's. Every
  // change therefore runs in the background page, one at a time; other extension pages send it there.
  async function applyAdd(str) {
    const result = validateEntry(str);
    if (!result.ok) return result;
    const { neverUnload } = await get();
    if (!neverUnload.includes(result.value)) {
      neverUnload.push(result.value);
      await set({ neverUnload });
    }
    return result;
  }

  async function applyRemove(str) {
    const result = validateEntry(str);
    const text = typeof str === "string" ? str.trim() : "";
    const { neverUnload } = await get();
    const kept = neverUnload.filter((entry) => entry !== text && !(result.ok && entry === result.value));
    if (kept.length !== neverUnload.length) await set({ neverUnload: kept });
    return result;
  }

  const OPS = { add: applyAdd, remove: applyRemove };
  let changes = Promise.resolve();

  function inBackgroundPage() {
    try {
      return browser.extension.getBackgroundPage() === globalThis;
    } catch (e) {
      return false;
    }
  }

  function queueChange(op, str) {
    const run = changes.then(() => OPS[op](str));
    changes = run.catch(() => {});
    return run;
  }

  function changeNeverUnload(op, str) {
    if (inBackgroundPage()) return queueChange(op, str);
    return browser.runtime.sendMessage({ type: "neverUnload", op, value: str });
  }

  function addEntry(str) {
    const result = validateEntry(str);
    if (!result.ok) return Promise.resolve(result);
    return changeNeverUnload("add", str);
  }

  function removeEntry(str) {
    return changeNeverUnload("remove", str);
  }

  // Background page: answers the neverUnload messages other extension pages send. Returns undefined
  // for anything else, so other listeners can answer it.
  function handleMessage(message) {
    if (!message || message.type !== "neverUnload" || !Object.hasOwn(OPS, message.op)) return undefined;
    return queueChange(message.op, message.value);
  }

  globalThis.TabUnloaderSettings = Object.freeze({
    DEFAULTS,
    get,
    set,
    validateEntry,
    matches,
    addEntry,
    removeEntry,
    handleMessage,
  });
})();
