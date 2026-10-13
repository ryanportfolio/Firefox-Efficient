/* Remembers the most recently focused normal browser window, so the toolbar popup can find the
   "current" tab even when it is opened from a window of another type.
   Stored as lastNormalWindowId in storage.session (cleared when Firefox restarts),
   or storage.local where storage.session is missing. */
"use strict";

(function () {
  const store = browser.storage.session || browser.storage.local;

  async function remember(windowId) {
    if (windowId === browser.windows.WINDOW_ID_NONE) return;
    let win;
    try {
      win = await browser.windows.get(windowId);
    } catch (e) {
      return; // window closed before we could look at it
    }
    if (win.type === "normal") await store.set({ lastNormalWindowId: win.id });
  }

  browser.windows.onFocusChanged.addListener((windowId) => {
    remember(windowId).catch(() => {});
  });

  // On (re)start of the background page, take the focused normal window, if any.
  browser.windows
    .getAll({ windowTypes: ["normal"] })
    .then((wins) => {
      const focused = wins.find((w) => w.focused && w.type === "normal");
      if (focused) return store.set({ lastNormalWindowId: focused.id });
      return undefined;
    })
    .catch(() => {});
})();
