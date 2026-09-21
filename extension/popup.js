/* global XCountryCore */
"use strict";

(() => {
  const core = globalThis.XCountryCore;
  const byId = (id) => document.getElementById(id);
  const controls = byId("controls");
  const enabled = byId("enabled");
  const search = byId("countrySearch");
  const list = byId("countryList");
  const clearSelection = byId("clearSelection");
  const clearCache = byId("clearCache");
  const saveStatus = byId("saveStatus");
  let settings;
  let writeQueue = Promise.resolve();
  let pendingWrites = 0;
  let cacheCount = 0;
  let cacheRecords = [];
  let renderedListSignature = "";

  const descriptions = {
    off: "Add account location labels. Your timeline is not filtered.",
    block: "Hide posts from the countries and regions you select below.",
    allow: "Show posts from selected countries and regions. Unknown locations stay visible unless hidden below."
  };

  function setSaveStatus(message, isError = false) {
    saveStatus.textContent = message;
    saveStatus.classList.toggle("is-error", isError);
  }

  function renderSummary() {
    enabled.checked = settings.enabled;
    byId("hideUnknown").checked = settings.hideUnknown;
    byId("hidePending").checked = settings.hidePending;
    byId("autoLookup").checked = settings.autoLookup;
    document.querySelectorAll('input[name="mode"]').forEach((radio) => {
      radio.checked = radio.value === settings.mode;
    });
    byId("selectionCount").textContent = `${settings.countries.length} selected`;
    clearSelection.disabled = settings.countries.length === 0;
    byId("activityDot").classList.toggle("is-paused", !settings.enabled);
    byId("activityText").textContent = !settings.enabled
      ? "Paused · preferences saved"
      : settings.mode === "off" ? "Active · labels only" : "Active · timeline filtering";
    let description = descriptions[settings.mode];
    if (settings.mode === "allow" && settings.countries.length === 0) {
      description = "No locations selected: all known locations will be hidden. Select at least one to keep its posts.";
    }
    byId("modeDescription").textContent = description;
  }

  function countryOptions() {
    const options = new Map(core.COUNTRY_OPTIONS.map((option) => [option.key, option]));
    const selected = new Set(settings.countries);
    for (const record of cacheRecords) {
      const location = record && record.location;
      if (!location || typeof location.key !== "string" || typeof location.label !== "string") continue;
      if (!options.has(location.key) && (core.isFresh(record) || selected.has(location.key))) {
        options.set(location.key, location);
      }
    }
    // Keep a selected region available after its lookup expires or the cache is cleared.
    for (const key of selected) {
      if (!options.has(key)) {
        const isRegion = key.startsWith("region:");
        options.set(key, { key, label: isRegion ? key.slice(7) : key, code: isRegion ? null : key });
      }
    }
    return [...options.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  function renderCountries() {
    const query = search.value.trim().toLocaleLowerCase();
    const selected = new Set(settings.countries);
    const options = countryOptions().filter((option) =>
      `${option.label} ${option.code || ""}`.toLocaleLowerCase().includes(query)
    );
    byId("resultCount").textContent = `${options.length} ${query ? "matches" : "locations"}`;
    const signature = JSON.stringify(options.map((option) => [option.key, option.label, option.code, selected.has(option.key)]));
    if (signature === renderedListSignature) return;
    renderedListSignature = signature;
    const activeInput = list.contains(document.activeElement) ? document.activeElement.value : null;
    const scrollTop = list.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const option of options) {
      const row = document.createElement("label");
      row.className = "country-row";
      row.classList.toggle("is-selected", selected.has(option.key));
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = option.key;
      checkbox.checked = selected.has(option.key);
      const label = document.createElement("span");
      label.className = "country-label";
      label.textContent = option.label;
      const code = document.createElement("span");
      const isCountry = typeof option.code === "string" && /^[A-Z]{2}$/i.test(option.code);
      code.className = `country-code${isCountry ? "" : " region"}`;
      code.textContent = isCountry ? option.code.toUpperCase() : "REGION";
      row.append(checkbox, label, code);
      fragment.append(row);
    }
    if (options.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No matching locations. Try another name or country code.";
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    list.scrollTop = scrollTop;
    if (activeInput) {
      const replacement = [...list.querySelectorAll("input")].find((input) => input.value === activeInput);
      if (replacement) replacement.focus({ preventScroll: true });
    }
  }

  function renderCache(cache) {
    cacheRecords = Object.values(core.normalizeCache(cache));
    cacheCount = cacheRecords.filter((record) => core.isFresh(record)).length;
    byId("cacheCount").textContent = cacheCount.toLocaleString();
    clearCache.disabled = cacheRecords.length === 0;
    if (settings) renderCountries();
  }

  function renderProvider(status) {
    const element = byId("providerStatus");
    const message = status && typeof status.message === "string" ? status.message.trim() : "";
    element.hidden = !message;
    element.textContent = message.slice(0, 400);
    element.classList.toggle("is-error", Boolean(status && /error|blocked|limited|unavailable|failed/i.test(status.state || "")));
  }

  function saveSettings() {
    settings = core.normalizeSettings(settings);
    renderSummary();
    const snapshot = { ...settings, countries: [...settings.countries] };
    pendingWrites += 1;
    setSaveStatus("Saving…");
    writeQueue = writeQueue.then(async () => {
      try {
        await chrome.storage.local.set({ settings: snapshot });
        if (pendingWrites === 1) setSaveStatus("Saved locally");
      } catch {
        setSaveStatus("Could not save", true);
      } finally {
        pendingWrites -= 1;
      }
    });
  }

  enabled.addEventListener("change", () => {
    settings.enabled = enabled.checked;
    saveSettings();
  });
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      settings.mode = radio.value;
      saveSettings();
    });
  });
  ["hideUnknown", "hidePending", "autoLookup"].forEach((key) => {
    byId(key).addEventListener("change", (event) => {
      settings[key] = event.target.checked;
      saveSettings();
    });
  });
  search.addEventListener("input", renderCountries);
  list.addEventListener("change", (event) => {
    const checkbox = event.target;
    if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== "checkbox") return;
    const selected = new Set(settings.countries);
    if (checkbox.checked) selected.add(checkbox.value);
    else selected.delete(checkbox.value);
    settings.countries = [...selected];
    checkbox.closest("label").classList.toggle("is-selected", checkbox.checked);
    saveSettings();
  });
  clearSelection.addEventListener("click", () => {
    settings.countries = [];
    saveSettings();
    renderCountries();
  });
  clearCache.addEventListener("click", async () => {
    clearCache.disabled = true;
    clearCache.textContent = "Clearing…";
    try {
      const result = await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
      if (result && result.ok === false) throw new Error("Cache clear failed");
      const stored = await chrome.storage.local.get("countryCache");
      renderCache(stored.countryCache);
      setSaveStatus("Cache cleared");
    } catch {
      setSaveStatus("Could not clear cache", true);
    } finally {
      clearCache.textContent = "Clear cache";
      clearCache.disabled = cacheRecords.length === 0;
    }
  });

  async function initialize() {
    if (!core) throw new Error("Extension core did not load");
    const stored = await chrome.storage.local.get(["settings", "countryCache", "providerStatus"]);
    settings = core.normalizeSettings(stored.settings);
    renderSummary();
    renderCache(stored.countryCache);
    renderProvider(stored.providerStatus);
    controls.disabled = false;
    enabled.disabled = false;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.settings && pendingWrites === 0) {
        settings = core.normalizeSettings(changes.settings.newValue);
        renderSummary();
        renderCountries();
      }
      if (changes.countryCache) renderCache(changes.countryCache.newValue);
      if (changes.providerStatus) renderProvider(changes.providerStatus.newValue);
    });
  }

  initialize().catch(() => {
    byId("activityText").textContent = "Unable to load preferences";
    byId("activityDot").classList.add("is-paused");
    setSaveStatus("Reopen the extension to retry", true);
  });
})();
