/* Toolbar popup: pause switch, "never unload" shortcuts for the current tab, and a list of every
   tab in every normal window with a button to unload each one. */
"use strict";

(function () {
  const Settings = globalThis.TabUnloaderSettings;
  const focusStore = browser.storage.session || browser.storage.local;

  const pauseBox = document.getElementById("pause");
  const neverSiteBtn = document.getElementById("never-site");
  const neverPageBtn = document.getElementById("never-page");
  const unloadOthersBtn = document.getElementById("unload-others");
  const optionsLink = document.getElementById("open-options");
  const statusEl = document.getElementById("status");
  const listEl = document.getElementById("list");

  let currentTab = null;
  let renderSeq = 0;
  let renderTimer = 0;
  let statusTimer = 0;

  function isWebUrl(url) {
    return /^https?:\/\//i.test(url || "");
  }

  function isSharing(tab) {
    const s = tab.sharingState;
    return !!(s && (s.camera || s.microphone || s.screen));
  }

  function showStatus(text, isError) {
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    statusEl.classList.toggle("error", !!isError);
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
      statusEl.classList.remove("error");
    }, 3000);
  }

  async function normalTabs() {
    const tabs = await browser.tabs.query({ windowType: "normal" });
    // Group by window (in the order windows first appear), tab order inside each window.
    const order = [];
    const byWindow = new Map();
    for (const tab of tabs) {
      if (!byWindow.has(tab.windowId)) {
        byWindow.set(tab.windowId, []);
        order.push(tab.windowId);
      }
      byWindow.get(tab.windowId).push(tab);
    }
    for (const list of byWindow.values()) list.sort((a, b) => a.index - b.index);
    return order.map((windowId) => ({ windowId, tabs: byWindow.get(windowId) }));
  }

  /** Active tab of the window this popup belongs to, else of the last focused normal window,
      else of the first normal window. */
  async function findCurrentTab(groups) {
    const activeIn = (windowId) => {
      const group = groups.find((g) => g.windowId === windowId);
      return group ? group.tabs.find((t) => t.active) || null : null;
    };
    try {
      const win = await browser.windows.getCurrent();
      if (win && win.type === "normal") {
        const tab = activeIn(win.id);
        if (tab) return tab;
      }
    } catch (e) {
      // no current window: fall through
    }
    try {
      const { lastNormalWindowId } = await focusStore.get("lastNormalWindowId");
      if (typeof lastNormalWindowId === "number") {
        const tab = activeIn(lastNormalWindowId);
        if (tab) return tab;
      }
    } catch (e) {
      // storage unavailable: fall through
    }
    return groups.length ? activeIn(groups[0].windowId) : null;
  }

  function makeIcon(tab) {
    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.className = "icon";
      img.alt = "";
      img.src = tab.favIconUrl;
      img.addEventListener("error", () => {
        const blank = document.createElement("span");
        blank.className = "icon blank";
        img.replaceWith(blank);
      });
      return img;
    }
    const blank = document.createElement("span");
    blank.className = "icon blank";
    return blank;
  }

  function makeRow(tab) {
    const row = document.createElement("div");
    row.className = "tab";
    row.dataset.tabId = String(tab.id);
    row.dataset.discarded = tab.discarded ? "true" : "false";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    if (currentTab && currentTab.id === tab.id) row.classList.add("current");

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.title = tab.discarded ? "Unloaded" : "Loaded";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title || tab.url || "Untitled";
    title.title = tab.url || "";

    row.append(dot, makeIcon(tab), title);

    const labels = [];
    if (tab.discarded) labels.push("Unloaded");
    else if (tab.audible) labels.push("Playing");
    if (currentTab && currentTab.id === tab.id) labels.push("Current");
    if (labels.length) {
      const state = document.createElement("span");
      state.className = "state";
      state.textContent = labels.join(" · ");
      row.append(state);
    }

    if (tab.discarded) {
      const spacer = document.createElement("span");
      spacer.className = "unload-spacer";
      row.append(spacer);
    } else {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "unload";
      x.title = "Unload tab";
      x.setAttribute("aria-label", "Unload tab: " + (tab.title || tab.url || ""));
      x.textContent = "×";
      x.addEventListener("click", (event) => {
        event.stopPropagation();
        unloadTab(tab.id);
      });
      row.append(x);
    }

    row.addEventListener("click", () => switchTo(tab.id, tab.windowId));
    row.addEventListener("keydown", (event) => {
      if (event.target === row && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        switchTo(tab.id, tab.windowId);
      }
    });
    return row;
  }

  async function render() {
    const seq = ++renderSeq;
    const groups = await normalTabs();
    const current = await findCurrentTab(groups);
    if (seq !== renderSeq) return; // a newer render started meanwhile
    currentTab = current;

    const web = !!(current && isWebUrl(current.url));
    neverSiteBtn.disabled = !web;
    neverPageBtn.disabled = !web;

    const scroll = listEl.scrollTop;
    const frag = document.createDocumentFragment();
    groups.forEach((group, i) => {
      const head = document.createElement("h2");
      head.className = "window-head";
      const count = group.tabs.length === 1 ? "1 tab" : group.tabs.length + " tabs";
      const mark = current && current.windowId === group.windowId ? " (current)" : "";
      head.textContent = "Window " + (i + 1) + mark + " · " + count;
      frag.append(head);
      for (const tab of group.tabs) frag.append(makeRow(tab));
    });
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No open tabs.";
      frag.append(empty);
    }
    listEl.replaceChildren(frag);
    listEl.scrollTop = scroll;
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      render().catch((e) => showStatus("Could not list tabs: " + e.message, true));
    }, 60);
  }

  async function switchTo(tabId, windowId) {
    try {
      await browser.tabs.update(tabId, { active: true });
      await browser.windows.update(windowId, { focused: true });
    } catch (e) {
      showStatus("Could not switch to that tab: " + e.message, true);
    }
  }

  /** Unload one tab. An active tab is first replaced by the most recently used other tab of its
      window (loaded tabs first), because Firefox cannot unload the tab on screen. */
  async function unloadTab(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.active) {
        const others = (await browser.tabs.query({ windowId: tab.windowId })).filter((t) => t.id !== tab.id);
        if (!others.length) {
          showStatus("This is the only tab in its window, so it stays loaded.", true);
          return;
        }
        others.sort((a, b) => (a.discarded - b.discarded) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
        await browser.tabs.update(others[0].id, { active: true });
      }
      await browser.tabs.discard(tabId);
    } catch (e) {
      showStatus("Could not unload that tab: " + e.message, true);
    } finally {
      await render();
    }
  }

  async function unloadOthers() {
    unloadOthersBtn.disabled = true;
    try {
      const groups = await normalTabs();
      const current = await findCurrentTab(groups);
      const { neverUnload } = await Settings.get();
      const targets = [];
      for (const group of groups) {
        for (const tab of group.tabs) {
          if (current && tab.id === current.id) continue;
          if (tab.discarded || tab.audible || isSharing(tab)) continue;
          if (Settings.matches(tab.url, neverUnload)) continue;
          targets.push(tab.id);
        }
      }
      // Firefox refuses some tabs (the active tab of another window, some internal pages).
      await Promise.allSettled(targets.map((id) => browser.tabs.discard(id)));
      const after = await Promise.allSettled(targets.map((id) => browser.tabs.get(id)));
      const done = after.filter((r) => r.status === "fulfilled" && r.value.discarded).length;
      showStatus(done === 1 ? "Unloaded 1 tab." : "Unloaded " + done + " tabs.");
    } catch (e) {
      showStatus("Could not unload tabs: " + e.message, true);
    } finally {
      unloadOthersBtn.disabled = false;
      await render();
    }
  }

  async function addNever(kind) {
    const tab = currentTab;
    if (!tab || !isWebUrl(tab.url)) return;
    const entry = kind === "site" ? new URL(tab.url).hostname : tab.url;
    try {
      const check = Settings.validateEntry(entry);
      const before = check.ok ? (await Settings.get()).neverUnload.includes(check.value) : false;
      const result = await Settings.addEntry(entry);
      if (!result.ok) {
        showStatus(result.error, true);
      } else if (before) {
        showStatus("Already on the never-unload list.");
      } else {
        showStatus(kind === "site" ? result.value + " will never be unloaded." : "This page will never be unloaded.");
      }
    } catch (e) {
      showStatus("Could not save: " + e.message, true);
    }
  }

  async function initPause() {
    const { paused } = await Settings.get();
    pauseBox.checked = !!paused;
  }

  pauseBox.addEventListener("change", () => {
    const paused = pauseBox.checked;
    Settings.set({ paused })
      .then(() => showStatus(paused ? "Auto-unload paused." : "Auto-unload on."))
      .catch((e) => showStatus("Could not save: " + e.message, true));
  });
  neverSiteBtn.addEventListener("click", () => addNever("site"));
  neverPageBtn.addEventListener("click", () => addNever("page"));
  unloadOthersBtn.addEventListener("click", () => unloadOthers());
  optionsLink.addEventListener("click", (event) => {
    event.preventDefault();
    browser.runtime.openOptionsPage();
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.paused) pauseBox.checked = !!changes.paused.newValue;
  });
  for (const ev of [browser.tabs.onUpdated, browser.tabs.onRemoved, browser.tabs.onCreated, browser.tabs.onActivated]) {
    ev.addListener(scheduleRender);
  }

  initPause().catch(() => {});
  render().catch((e) => showStatus("Could not list tabs: " + e.message, true));
})();
