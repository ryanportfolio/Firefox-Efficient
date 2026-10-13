/* Options page: idle time before a tab is unloaded, and the list of sites and pages never unloaded. */
"use strict";

(function () {
  const S = globalThis.TabUnloaderSettings;

  const idleForm = document.getElementById("idle-form");
  const idleInput = document.getElementById("idle-minutes");
  const idleError = document.getElementById("idle-error");
  const idleSaved = document.getElementById("idle-saved");
  const entryForm = document.getElementById("entry-form");
  const entryInput = document.getElementById("entry-input");
  const entryError = document.getElementById("entry-error");
  const entriesList = document.getElementById("entries");
  const entriesEmpty = document.getElementById("entries-empty");

  let savedTimer = 0;

  function showError(el, message) {
    el.textContent = message;
    el.hidden = false;
  }

  function clearError(el) {
    el.textContent = "";
    el.hidden = true;
  }

  function showIdle(minutes) {
    idleInput.value = String(minutes);
  }

  function renderEntries(list) {
    const items = list.map((entry) => {
      const li = document.createElement("li");
      li.dataset.entry = entry;
      const text = document.createElement("span");
      text.className = "entry-text";
      text.textContent = entry;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", "Remove " + entry);
      remove.addEventListener("click", () => removeEntry(entry, remove));
      li.append(text, remove);
      return li;
    });
    entriesList.replaceChildren(...items);
    entriesEmpty.hidden = list.length > 0;
  }

  async function saveIdle() {
    clearError(idleError);
    idleSaved.hidden = true;
    const text = idleInput.value.trim();
    const minutes = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(minutes) || minutes < 1) {
      showError(idleError, "Enter a whole number of minutes, 1 or more.");
      return;
    }
    try {
      await S.set({ idleMinutes: minutes });
    } catch (err) {
      showError(idleError, "Could not save: " + err.message);
      return;
    }
    showIdle(minutes);
    idleSaved.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      idleSaved.hidden = true;
    }, 2000);
  }

  async function addEntry() {
    clearError(entryError);
    const check = S.validateEntry(entryInput.value);
    if (!check.ok) {
      showError(entryError, check.error);
      return;
    }
    try {
      const { neverUnload } = await S.get();
      if (neverUnload.includes(check.value)) {
        showError(entryError, "That is already on the list.");
        return;
      }
      const result = await S.addEntry(check.value);
      if (!result.ok) {
        showError(entryError, result.error);
        return;
      }
    } catch (err) {
      showError(entryError, "Could not save: " + err.message);
      return;
    }
    entryInput.value = "";
    renderEntries((await S.get()).neverUnload);
  }

  async function removeEntry(entry, button) {
    button.disabled = true;
    try {
      await S.removeEntry(entry);
    } catch (err) {
      button.disabled = false;
      showError(entryError, "Could not remove: " + err.message);
      return;
    }
    renderEntries((await S.get()).neverUnload);
  }

  idleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveIdle();
  });
  idleInput.addEventListener("input", () => {
    clearError(idleError);
    idleSaved.hidden = true;
  });

  entryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addEntry();
  });
  entryInput.addEventListener("input", () => clearError(entryError));

  // Keep the page in step with changes made elsewhere, such as the popup's "Never unload this site".
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.idleMinutes && document.activeElement !== idleInput) {
      const value = changes.idleMinutes.newValue;
      showIdle(value === undefined ? S.DEFAULTS.idleMinutes : value);
    }
    if (changes.neverUnload) {
      const value = changes.neverUnload.newValue;
      renderEntries(Array.isArray(value) ? value : []);
    }
  });

  S.get().then(
    (settings) => {
      showIdle(settings.idleMinutes);
      renderEntries(settings.neverUnload);
      document.body.dataset.ready = "true";
    },
    (err) => {
      showError(idleError, "Could not load settings: " + err.message);
      document.body.dataset.ready = "error";
    },
  );
})();
