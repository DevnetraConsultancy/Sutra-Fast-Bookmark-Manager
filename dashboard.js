/*! Sutra © 2025-2026 Devnetra Consultancy. All rights reserved. Proprietary software; copying, modifying or redistributing without written permission is prohibited. See LICENSE. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const grid = $("#grid-container");
  const defaultCategories = ["Work", "Development", "Learning", "Design", "Tools", "Personal", "Finance", "Read later"];
  const RESERVED_GROUP = "all bookmarks"; // Legacy filter name; never a real group.
  const ACCENTS = ["emerald", "gold", "cyan", "violet", "crimson"];
  let categories = [...defaultCategories];
  let state = { bookmarks: [], theme: "dark", accentColor: "emerald", customCategories: [], iconSize: 48, groupOrder: [], hiddenCategories: [], layoutLocked: false, iconLookup: false, wallpapers: [], wallpaperMode: "off", wallpaperOnline: false, wallpaperCurrent: "default", wallpaperCursor: -1, wallpaperChangedAt: 0 };
  let toastTimer;
  let isInitialized = false;
  let storageSyncRunning = false;
  let storageSyncPending = false;
  let storageSyncTimer = null;
  let persistQueue = Promise.resolve();
  let pendingStorageWrites = 0;
  let generatedIdCounter = 0;
  let lastSaved = {};
  // Until saved data has been read once, the page holds defaults; writing them would wipe the library.
  let storageLoaded = false;
  let storageRetries = 0;
  // Empty groups normally stay hidden, but one the user is working with must not vanish.
  const revealedGroups = new Set();
  let searchIndex = new Map();

  // Wallpaper images themselves live in Cache Storage; only their list and settings are here.
  const STORAGE_KEYS = ["bookmarks","shortcuts","theme","accentColor","customCategories","categoryNames","iconSize","groupOrder","hiddenCategories","layoutLocked","iconLookup","wallpapers","wallpaperMode","wallpaperOnline","wallpaperCurrent","wallpaperCursor","wallpaperChangedAt"];
  const storageGet = (keys) => new Promise((resolve, reject) => chrome.storage.local.get(keys, result => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message || "Chrome storage read failed."));
    else resolve(result || {});
  }));
  const storageSet = (obj) => new Promise((resolve, reject) => chrome.storage.local.set(obj, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message || "Chrome storage write failed."));
    else resolve();
  }));
  const storageRemove = (keys) => new Promise((resolve, reject) => chrome.storage.local.remove(keys, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message || "Chrome storage remove failed."));
    else resolve();
  }));

  function escapeHtml(value="") {
    return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function validUrl(raw) {
    try { const u = new URL(raw); return ["http:", "https:"].includes(u.protocol) ? u.href : null; }
    catch { return null; }
  }
  // Accepts what people actually type or paste, such as "example.com".
  function coerceUrl(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    return validUrl(/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text) ? text : "https://" + text);
  }
  function showToast(message) {
    const el = $("#toast");
    // A modal dialog sits in the top layer, so the toast must live inside it to stay visible.
    const dialogs = document.querySelectorAll("dialog[open]");
    const host = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
    if (el.parentElement !== host) host.appendChild(el);
    el.textContent = message; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }
  function persistedSnapshot() {
    return {
      bookmarks: state.bookmarks,
      theme: state.theme,
      accentColor: state.accentColor || "emerald",
      customCategories: state.customCategories,
      categoryNames: defaultCategories,
      iconSize: state.iconSize,
      groupOrder: state.groupOrder,
      hiddenCategories: state.hiddenCategories,
      layoutLocked: state.layoutLocked,
      iconLookup: state.iconLookup,
      wallpapers: state.wallpapers,
      wallpaperMode: state.wallpaperMode,
      wallpaperOnline: state.wallpaperOnline,
      wallpaperCurrent: state.wallpaperCurrent,
      wallpaperCursor: state.wallpaperCursor,
      wallpaperChangedAt: state.wallpaperChangedAt
    };
  }
  function stateSignature() {
    try { return JSON.stringify(persistedSnapshot()); }
    catch { return String(Date.now()); }
  }
  function createId() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (err) { console.warn("Secure ID generation unavailable; using local fallback.", err); }
    generatedIdCounter += 1;
    return `sutra-${Date.now().toString(36)}-${generatedIdCounter.toString(36)}`;
  }
  async function persist() {
    if (!storageLoaded) {
      showToast("Sutra is still reading your saved data. Try again in a moment.");
      scheduleStorageSync("retry-load");
      return false;
    }
    // Write only the keys that changed, and serialise writes so rapid edits cannot finish out of order.
    const changes = {};
    const written = {};
    try {
      for (const [key, value] of Object.entries(persistedSnapshot())) {
        const json = JSON.stringify(value);
        if (lastSaved[key] === json) continue;
        changes[key] = JSON.parse(json);
        written[key] = json;
      }
    } catch (err) {
      showToast("Could not prepare changes for saving.");
      console.error("Sutra snapshot failed:", err);
      return false;
    }
    if (!Object.keys(changes).length) return true;
    Object.assign(lastSaved, written);
    pendingStorageWrites += 1;
    const write = persistQueue.catch(() => {}).then(() => storageSet(changes));
    persistQueue = write;
    try {
      await write;
      scheduleBackup();
      return true;
    } catch (err) {
      for (const key of Object.keys(written)) if (lastSaved[key] === written[key]) delete lastSaved[key];
      showToast("Could not save changes. Check Chrome storage space and try again.");
      console.error("Sutra storage write failed:", err);
      return false;
    } finally {
      pendingStorageWrites = Math.max(0, pendingStorageWrites - 1);
      if (!pendingStorageWrites && storageSyncPending) {
        storageSyncPending = false;
        scheduleStorageSync("writes-complete");
      }
    }
  }

  // --- Site icons ---
  // Each site resolves once, in order: Chrome's saved favicon, then the website's own
  // icon files, then (only if switched on) DuckDuckGo. The answer is remembered per
  // origin, so later new tabs draw straight from the right place without any probing.
  const ICON_CACHE_KEY = "sutra_icon_cache";
  const ICON_TTL = 30 * 24 * 60 * 60 * 1000;
  const ICON_MISS_TTL = 0; // Re-attempt missing icons on every reload so they auto-fetch.
  const ICON_TIMEOUT_MS = 5000;
  const ICON_CONCURRENCY = 6;
  const ICON_FROM_CHROME = "chrome";
  let iconCache = {};
  let iconSaveTimer = null;
  let iconQueue = [];
  let iconWorkers = 0;
  let genericIconPixels = null;
  const iconJobs = new Set();

  function getFavicon(url, size = 128) {
    // Manifest V3 exposes saved site favicons through the extension's own
    // /_favicon/ endpoint. Direct chrome://favicon2 URLs are blocked in pages.
    const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
    faviconUrl.searchParams.set("pageUrl", url);
    faviconUrl.searchParams.set("size", String(size));
    return faviconUrl.toString();
  }
  function originOf(url) {
    try { return new URL(url).origin; } catch { return ""; }
  }
  function iconSrcFor(item, origin) {
    const entry = iconCache[origin];
    if (!entry || !entry.src) return "";
    return entry.src === ICON_FROM_CHROME ? getFavicon(item.url) : entry.src;
  }
  function loadImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      const timer = setTimeout(() => finish(null), ICON_TIMEOUT_MS);
      const finish = result => {
        clearTimeout(timer);
        img.onload = img.onerror = null;
        if (!result) img.src = "";
        resolve(result);
      };
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      img.src = src;
    });
  }
  async function readIconPixels(src) {
    const img = await loadImage(src);
    if (!img || !img.naturalWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(img, 0, 0, 32, 32);
    return context.getImageData(0, 0, 32, 32).data;
  }
  // When Chrome has no icon it answers with its grey globe rather than an error, so
  // compare against what it returns for a site that cannot possibly have one.
  async function hasChromeIcon(url) {
    if (!genericIconPixels) genericIconPixels = readIconPixels(getFavicon("https://sutra-no-icon.invalid/", 32));
    const [generic, pixels] = await Promise.all([genericIconPixels, readIconPixels(getFavicon(url, 32))]);
    if (!pixels) return false;
    if (!generic) return true;
    return pixels.some((value, index) => value !== generic[index]);
  }
  function isPublicHost(host) {
    return host.includes(".") && !/^[\d.]+$/.test(host) && !host.startsWith("[") && !/\.(local|localhost|internal|lan|home|corp|test|invalid)$/i.test(host);
  }
  function iconCandidates(origin) {
    const { protocol, host, hostname } = new URL(origin);
    const paths = ["apple-touch-icon.png", "favicon.ico", "favicon.svg", "favicon.png"];
    const urls = paths.map(path => `${origin}/${path}`);
    const isPublic = isPublicHost(hostname);
    // Many sites only serve their icons from one of the bare and www hosts.
    if (isPublic && !hostname.startsWith("www.")) urls.push(`${protocol}//www.${host}/apple-touch-icon.png`, `${protocol}//www.${host}/favicon.ico`);
    return urls;
  }
  // Tries every candidate at once and answers with the best that loads, so one slow or
  // dead host costs a single timeout rather than one for each file it is asked about.
  function firstLoadableIcon(urls) {
    return new Promise(resolve => {
      const usable = new Array(urls.length);
      const settle = () => {
        for (let i = 0; i < urls.length; i++) {
          if (usable[i] === undefined) return;
          if (usable[i]) { resolve(urls[i]); return; }
        }
        resolve("");
      };
      urls.forEach((url, i) => {
        void loadImage(url).then(img => {
          // Tracking pixels and placeholder images are not icons. SVGs may report no intrinsic size.
          usable[i] = !!img && (img.naturalWidth >= 16 || url.endsWith(".svg"));
          settle();
        });
      });
    });
  }
  // DuckDuckGo answers unknown sites with a 404 that still carries a grey placeholder
  // image, so the status has to be checked; an <img> alone would accept it.
  async function lookupIconOnline(hostname) {
    const url = `https://icons.duckduckgo.com/ip3/${hostname}.ico`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
      return res.ok ? url : "";
    } catch { return ""; }
  }
  async function resolveIcon(origin, url) {
    const previous = iconCache[origin];
    let src = ICON_FROM_CHROME;
    if (!(await hasChromeIcon(url))) {
      // Offline, nothing can be learned about the site, so ask again next time.
      if (!navigator.onLine) return;
      src = await firstLoadableIcon(iconCandidates(origin));
      const { hostname } = new URL(origin);
      if (!src && state.iconLookup && isPublicHost(hostname)) src = await lookupIconOnline(hostname);
    }
    iconCache[origin] = { src: src || (previous && previous.src) || "", at: Date.now() };
    saveIconCacheSoon();
    paintIcon(origin);
  }
  function iconEntryIsFresh(entry) {
    return entry && Date.now() - entry.at < (entry.src ? ICON_TTL : ICON_MISS_TTL);
  }
  function queueIconResolution() {
    for (const item of state.bookmarks) {
      const origin = originOf(item.url);
      if (!origin || iconJobs.has(origin) || iconEntryIsFresh(iconCache[origin])) continue;
      iconJobs.add(origin);
      iconQueue.push({ origin, url: item.url });
    }
    while (iconWorkers < ICON_CONCURRENCY && iconQueue.length) void runIconWorker();
  }
  async function runIconWorker() {
    iconWorkers += 1;
    while (iconQueue.length) {
      const { origin, url } = iconQueue.shift();
      try { await resolveIcon(origin, url); }
      catch (err) { console.warn("Sutra icon lookup failed:", origin, err); }
      iconJobs.delete(origin);
    }
    iconWorkers -= 1;
  }
  function iconImageHtml(src, origin) {
    return `<img src="${escapeHtml(src)}" alt="" width="128" height="128" loading="eager" decoding="async" draggable="false" referrerpolicy="no-referrer" data-icon-origin="${escapeHtml(origin)}">`;
  }
  function paintIcon(origin) {
    grid.querySelectorAll(`.tile-icon[data-origin="${CSS.escape(origin)}"]`).forEach(box => {
      const item = state.bookmarks.find(b => b.id === box.closest(".bookmark-tile")?.dataset.bookmarkId);
      const src = item ? iconSrcFor(item, origin) : "";
      box.querySelector("img")?.remove();
      box.classList.toggle("has-icon", !!src);
      if (src) box.insertAdjacentHTML("beforeend", iconImageHtml(src, origin));
    });
  }
  function saveIconCacheSoon() {
    clearTimeout(iconSaveTimer);
    iconSaveTimer = setTimeout(() => {
      const used = new Set(state.bookmarks.map(item => originOf(item.url)));
      for (const origin of Object.keys(iconCache)) if (!used.has(origin)) delete iconCache[origin];
      storageSet({ [ICON_CACHE_KEY]: iconCache }).catch(err => console.warn("Sutra icon cache write failed:", err));
    }, 800);
  }
  function refreshIcons() {
    iconCache = {};
    genericIconPixels = null;
    saveIconCacheSoon();
    renderGrid();
    queueIconResolution();
  }
  async function setIconLookup(enabled) {
    if (enabled) {
      // Reading the service's status needs host access, requested only by those who opt in.
      const granted = await new Promise(resolve => chrome.permissions.request({ origins: ["https://icons.duckduckgo.com/*"] }, resolve));
      if (!granted) {
        $("#icon-lookup-toggle").checked = false;
        showToast("Permission was not granted, so online lookup stays off.");
        return;
      }
    }
    state.iconLookup = enabled;
    void persist();
    if (!enabled) return;
    // Sites that came up empty get another chance now that the service can answer.
    for (const origin of Object.keys(iconCache)) if (!iconCache[origin].src) delete iconCache[origin];
    queueIconResolution();
  }
  function hueFor(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return Math.abs(hash) % 360;
  }

  // --- Dialogs ---
  let askResolve = null;
  function finishAsk(value) {
    const resolve = askResolve;
    askResolve = null;
    $("#ask-dialog").close();
    if (resolve) resolve(value);
  }
  // Replaces prompt() and confirm(). Resolves to the text, choice or true, or null if dismissed.
  function ask({ title, message = "", input = null, placeholder = "", choices = null, current = null, okLabel = "OK", danger = false }) {
    if (askResolve) finishAsk(null);
    const dialog = $("#ask-dialog");
    const field = $("#ask-input");
    const ok = $("#ask-ok");
    $("#ask-title").textContent = title;
    $("#ask-message").textContent = message;
    field.hidden = input === null;
    field.value = input || "";
    field.placeholder = placeholder;
    const list = $("#ask-choices");
    list.innerHTML = (choices || []).map((choice, index) => `<button type="button" data-choice="${index}" class="${choice === current ? "is-current" : ""}">${escapeHtml(choice)}</button>`).join("");
    ok.hidden = !!choices;
    ok.textContent = okLabel;
    ok.className = `button ${danger ? "button-danger" : "button-primary"}`;
    return new Promise(resolve => {
      askResolve = value => resolve(value);
      askChoices = choices;
      dialog.showModal();
      if (input !== null) { field.focus(); field.select(); }
      else if (!choices) ok.focus();
    });
  }
  let askChoices = null;
  function wireAskDialog() {
    $("#ask-form").addEventListener("submit", e => {
      e.preventDefault();
      if ($("#ask-input").hidden) { finishAsk(true); return; }
      const value = $("#ask-input").value.trim();
      if (value) finishAsk(value); else $("#ask-input").focus();
    });
    $("#ask-cancel").addEventListener("click", () => finishAsk(null));
    $("#ask-choices").addEventListener("click", e => {
      const button = e.target.closest("[data-choice]");
      if (button) finishAsk(askChoices[Number(button.dataset.choice)]);
    });
    // The close event is queued, so a dialog reopened in the meantime must not be dismissed.
    $("#ask-dialog").addEventListener("close", e => { if (askResolve && !e.currentTarget.open) finishAsk(null); });
  }
  function openModal(id) { $("#" + id).showModal(); }
  function closeModal(id) { $("#" + id).close(); }
  function hasOpenModal() { return !!document.querySelector("dialog[open]"); }

  // A single shared menu keeps the page free of hundreds of hidden per-tile menus.
  function closeMenu() {
    const menu = $("#menu");
    if (menu.hidden) return;
    menu.hidden = true;
    menu.innerHTML = "";
    const anchor = menuAnchor;
    menuAnchor = null;
    if (anchor && anchor.isConnected && document.activeElement === document.body) anchor.focus({ preventScroll: true });
  }
  let menuAnchor = null;
  let menuItems = [];
  function openMenu(items, x, y, anchor = null) {
    const menu = $("#menu");
    menuItems = items;
    menuAnchor = anchor;
    menu.innerHTML = items.map((item, index) => `<button type="button" role="menuitem" data-item="${index}" class="${item.danger ? "danger-action" : ""}">${escapeHtml(item.label)}</button>`).join("");
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
    menu.querySelector("button")?.focus({ preventScroll: true });
  }
  function wireMenu() {
    const menu = $("#menu");
    menu.addEventListener("click", e => {
      const button = e.target.closest("[data-item]");
      if (!button) return;
      const item = menuItems[Number(button.dataset.item)];
      menuAnchor = null;
      closeMenu();
      if (item) item.run();
    });
    menu.addEventListener("keydown", e => {
      const buttons = [...menu.querySelectorAll("button")];
      const index = buttons.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); buttons[(index + 1) % buttons.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length].focus(); }
      else if (e.key === "Tab") closeMenu();
    });
    window.addEventListener("resize", closeMenu);
    window.addEventListener("blur", closeMenu);
    document.addEventListener("scroll", closeMenu, { passive: true });
  }
  function bookmarkMenu(item) {
    return [
      { label: "Edit", run: () => openBookmarkModal(item) },
      { label: "Move to group", run: () => promptMoveBookmark(item) },
      { label: "Delete", danger: true, run: () => deleteBookmark(item) }
    ];
  }
  function groupMenu(name) {
    return [
      { label: "Add site", run: () => openBookmarkModal(null, name) },
      { label: "Rename group", run: () => renameCategory(name) },
      { label: "Delete group", danger: true, run: () => deleteCategory(name) }
    ];
  }
  async function promptMoveBookmark(item) {
    if (state.layoutLocked) { showToast("Drag & drop is locked. Unlock it in Settings to move sites."); return; }
    const target = await ask({ title: `Move “${item.name}” to`, choices: orderedGroupNames(), current: item.category });
    if (target && target !== item.category) moveBookmarkToGroup(item.id, target);
  }
  async function deleteBookmark(item) {
    if (!await ask({ title: `Delete “${item.name}”?`, okLabel: "Delete", danger: true })) return;
    state.bookmarks = state.bookmarks.filter(b => b.id !== item.id);
    revealedGroups.add(item.category);
    renderAll();
    void persist();
    showToast("Site deleted");
  }

  // --- Groups and ordering ---
  function refreshCategories() { categories = [...defaultCategories, ...(state.customCategories || [])]; }
  function groupNameTaken(name) {
    const key = name.toLowerCase();
    return key === RESERVED_GROUP || categories.some(c => c.toLowerCase() === key);
  }
  function orderedGroupNames() {
    const ordered = [...new Set((state.groupOrder || []).filter(c => categories.includes(c)))];
    categories.forEach(c => { if (!ordered.includes(c)) ordered.push(c); });
    state.groupOrder = ordered;
    return ordered;
  }
  // Where a site lands when no particular group was chosen: never somewhere hidden.
  function firstVisibleGroup() {
    const hiddenSet = new Set(state.hiddenCategories || []);
    const names = orderedGroupNames();
    return names.find(name => !hiddenSet.has(name)) || names[0];
  }
  function reorderGroup(source, target, placement = "before") {
    if (!source || !target || source === target || state.layoutLocked) return;
    const order = orderedGroupNames().filter(name => name !== source);
    const targetIndex = order.indexOf(target);
    if (targetIndex < 0) order.push(source);
    else order.splice(targetIndex + (placement === "after" ? 1 : 0), 0, source);
    state.groupOrder = order;
    renderAll();
    void persist();
  }
  function reorderBookmark(bookmarkId, targetId, position = "before") {
    if (state.layoutLocked || !bookmarkId || !targetId || bookmarkId === targetId) return;
    const sourceIndex = state.bookmarks.findIndex(b => b.id === bookmarkId);
    const target = state.bookmarks.find(b => b.id === targetId);
    if (sourceIndex < 0 || !target) return;

    const [dragged] = state.bookmarks.splice(sourceIndex, 1);
    const originalCategory = dragged.category;
    dragged.category = target.category;
    const targetIndex = state.bookmarks.findIndex(b => b.id === targetId);
    state.bookmarks.splice(targetIndex + (position === "after" ? 1 : 0), 0, dragged);

    if (originalCategory !== dragged.category) revealedGroups.add(originalCategory);
    renderAll();
    void persist();
    if (originalCategory !== dragged.category) showToast(`Moved to ${dragged.category}`);
  }
  function moveBookmarkToGroup(bookmarkId, groupName) {
    if (state.layoutLocked) return;
    const sourceIndex = state.bookmarks.findIndex(b => b.id === bookmarkId);
    if (sourceIndex < 0 || !categories.includes(groupName)) return;
    const [item] = state.bookmarks.splice(sourceIndex, 1);
    const originalCategory = item.category;
    item.category = groupName;

    // Menu moves and drops onto the empty group area append to the end of that group.
    let lastIndex = -1;
    state.bookmarks.forEach((b, index) => { if (b.category === groupName) lastIndex = index; });
    if (lastIndex >= 0) state.bookmarks.splice(lastIndex + 1, 0, item);
    else state.bookmarks.push(item);

    if (originalCategory !== groupName) revealedGroups.add(originalCategory);
    renderAll();
    void persist();
    if (originalCategory !== groupName) showToast(`Moved to ${groupName}`);
  }

  // --- Rendering ---
  function tileHtml(item, canDrag) {
    const origin = originOf(item.url);
    const src = iconSrcFor(item, origin);
    const label = (item.name || "?").trim();
    const initial = escapeHtml(label.slice(0, 1).toUpperCase());
    const title = item.note ? `${item.name}\n${item.note}` : item.name;
    return `<article class="bookmark-tile" data-bookmark-id="${escapeHtml(item.id)}" draggable="${canDrag}"><a class="tile-open" draggable="false" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(title)}"><span class="tile-icon${src ? " has-icon" : ""}" data-origin="${escapeHtml(origin)}" style="--hue:${hueFor(origin)}"><span class="tile-initial">${initial}</span>${src ? iconImageHtml(src, origin) : ""}</span><span class="tile-name">${escapeHtml(item.name)}</span></a><button class="tile-menu quiet-icon" type="button" aria-label="Actions for ${escapeHtml(item.name)}" title="Edit, move or delete">•••</button></article>`;
  }
  function renderGrid() {
    const hiddenSet = new Set(state.hiddenCategories || []);
    const byGroup = new Map(categories.map(name => [name, []]));
    for (const item of state.bookmarks) byGroup.get(item.category)?.push(item);
    const canDrag = !state.layoutLocked;
    const showAllGroups = state.bookmarks.length === 0;

    closeMenu();
    clearTileKeyboardFocus();
    document.body.classList.toggle("layout-locked", !!state.layoutLocked);
    searchIndex = new Map(state.bookmarks.map(b => [b.id, [b.name, b.url, b.category, b.note].join("\n").toLowerCase()]));
    grid.innerHTML = orderedGroupNames().filter(name => !hiddenSet.has(name)).map(name => {
      const items = byGroup.get(name) || [];
      const safeName = escapeHtml(name);
      const classes = ["launch-collection"];
      if (!items.length) classes.push("is-empty-group");
      if (showAllGroups || revealedGroups.has(name)) classes.push("is-revealed");
      return `<section class="${classes.join(" ")}" data-group-name="${safeName}"><div class="collection-heading" draggable="${canDrag}"><h3>${safeName}<span>${items.length}</span></h3><button type="button" class="collection-manage quiet-icon" aria-label="Manage ${safeName}" title="Group options">•••</button></div><div class="bookmark-grid">${items.map(item => tileHtml(item, canDrag)).join("")}<button type="button" class="add-bookmark-tile" aria-label="Add site to ${safeName}" title="Add site to ${safeName}"><span class="tile-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span><span class="tile-name">Add site</span></button></div></section>`;
    }).join("");
    applySearch();
    if ($("#settings-modal").open) renderManageCategories();
  }
  // Filtering toggles existing tiles rather than rebuilding them, so typing never reloads an icon.
  function applySearch() {
    const query = $("#search-input").value.trim().toLowerCase();
    document.body.classList.toggle("is-searching", !!query);
    clearTileKeyboardFocus();
    let matches = 0;
    grid.querySelectorAll(".launch-collection").forEach(section => {
      let visible = 0;
      section.querySelectorAll(".bookmark-tile").forEach(tile => {
        const match = !query || (searchIndex.get(tile.dataset.bookmarkId) || "").includes(query);
        tile.hidden = !match;
        if (match) visible += 1;
      });
      section.hidden = !!query && !visible;
      matches += visible;
    });
    $("#empty-state").hidden = !query || matches > 0;
  }
  function renderAll() { refreshCategories(); renderGrid(); queueIconResolution(); }
  function bookmarkById(id) { return state.bookmarks.find(b => b.id === id); }

  function wireGridEvents() {
    grid.addEventListener("click", e => {
      const tileMenu = e.target.closest(".tile-menu");
      if (tileMenu) {
        const item = bookmarkById(tileMenu.closest(".bookmark-tile").dataset.bookmarkId);
        const rect = tileMenu.getBoundingClientRect();
        if (item) openMenu(bookmarkMenu(item), rect.left, rect.bottom + 4, tileMenu);
        return;
      }
      const manage = e.target.closest(".collection-manage");
      if (manage) {
        const rect = manage.getBoundingClientRect();
        openMenu(groupMenu(manage.closest(".launch-collection").dataset.groupName), rect.right - 156, rect.bottom + 4, manage);
        return;
      }
      const addTile = e.target.closest(".add-bookmark-tile");
      if (addTile) openBookmarkModal(null, addTile.closest(".launch-collection").dataset.groupName);
    });
    grid.addEventListener("contextmenu", e => {
      const tile = e.target.closest(".bookmark-tile");
      const heading = e.target.closest(".collection-heading");
      if (!tile && !heading) return;
      e.preventDefault();
      if (tile) {
        const item = bookmarkById(tile.dataset.bookmarkId);
        if (item) openMenu(bookmarkMenu(item), e.clientX, e.clientY, tile.querySelector(".tile-menu"));
      } else {
        openMenu(groupMenu(heading.closest(".launch-collection").dataset.groupName), e.clientX, e.clientY, heading.querySelector(".collection-manage"));
      }
    });
    // Image errors do not bubble, so a single capturing listener covers every tile.
    grid.addEventListener("error", e => {
      if (e.target.tagName !== "IMG") return;
      e.target.closest(".tile-icon")?.classList.remove("has-icon");
      e.target.remove();
    }, true);
  }

  // --- Drag and drop ---
  // The drag in progress inside this page. Anything else is an external link or file.
  let activeDrag = null;

  function dropPlacement(target, clientX, clientY) {
    const rect = target.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    // Use the closer axis: left/right to position within a row, up/down between rows.
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "before" : "after";
    return dy < 0 ? "before" : "after";
  }
  function clearDropMarkers() {
    grid.querySelectorAll(".drop-before, .drop-after, .drag-over").forEach(el => el.classList.remove("drop-before", "drop-after", "drag-over"));
  }
  function setDropMarker(element, className) {
    if (element.classList.contains(className) && grid.querySelectorAll(".drop-before, .drop-after").length === 1) return;
    grid.querySelectorAll(".drop-before, .drop-after").forEach(el => el.classList.remove("drop-before", "drop-after"));
    element.classList.add(className);
  }
  function setDragOverGroup(section) {
    grid.querySelectorAll(".drag-over").forEach(el => { if (el !== section) el.classList.remove("drag-over"); });
    section?.classList.add("drag-over");
  }
  function nearestBookmarkDropTarget(section, clientX, clientY) {
    let best = null;
    let bestDistance = Infinity;
    for (const tile of section.querySelectorAll(".bookmark-tile[data-bookmark-id]")) {
      if (tile.classList.contains("is-dragging-bookmark")) continue;
      const rect = tile.getBoundingClientRect();
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height / 2);
      // Scale vertical distance so multi-row grids choose the closest visual slot.
      const distance = (dx * dx) + (dy * dy * 0.85);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = tile;
      }
    }
    return best;
  }
  function groupSectionAt(event) {
    return event.target.closest?.(".launch-collection") || null;
  }
  function isEditableTarget(target) {
    return !!target.closest?.("input, textarea, select, [contenteditable]");
  }
  function endDrag() {
    const wasDragging = !!activeDrag;
    activeDrag = null;
    if (wasDragging && storageSyncPending) scheduleStorageSync("drag-end");
    document.body.classList.remove("drag-in-progress");
    grid.querySelectorAll(".is-dragging-bookmark, .is-dragging-group").forEach(el => el.classList.remove("is-dragging-bookmark", "is-dragging-group"));
    clearDropMarkers();
    hideDevnetraCredit();
  }
  function wireDragAndDrop() {
    grid.addEventListener("dragstart", e => {
      if (state.layoutLocked || $("#search-input").value.trim()) { e.preventDefault(); return; }
      const tile = e.target.closest?.(".bookmark-tile");
      const heading = e.target.closest?.(".collection-heading");
      closeMenu();
      if (tile) {
        activeDrag = { type: "bookmark", id: tile.dataset.bookmarkId, element: tile };
        e.dataTransfer.setData("application/x-sutra-bookmark", tile.dataset.bookmarkId);
        e.dataTransfer.setData("text/plain", tile.querySelector("a")?.href || "");
      } else if (heading && !e.target.closest?.("button")) {
        const section = heading.closest(".launch-collection");
        activeDrag = { type: "group", id: section.dataset.groupName, element: section };
        e.dataTransfer.setData("application/x-sutra-group", activeDrag.id);
      } else {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = "move";
      // Changing layout inside dragstart can cancel the drag, so wait a frame.
      const drag = activeDrag;
      setTimeout(() => {
        if (activeDrag !== drag) return;
        drag.element.classList.add(drag.type === "bookmark" ? "is-dragging-bookmark" : "is-dragging-group");
        if (drag.type === "bookmark") document.body.classList.add("drag-in-progress");
      }, 0);
    });
    document.addEventListener("dragend", endDrag);

    document.addEventListener("dragenter", e => {
      if (!activeDrag && !isEditableTarget(e.target)) document.body.classList.add("drag-in-progress");
    });
    document.addEventListener("dragover", e => {
      const section = groupSectionAt(e);
      if (activeDrag?.type === "bookmark") {
        if (!section) { clearDropMarkers(); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOverGroup(section);
        const target = nearestBookmarkDropTarget(section, e.clientX, e.clientY);
        if (target) {
          setDropMarker(target, dropPlacement(target, e.clientX, e.clientY) === "before" ? "drop-before" : "drop-after");
        } else {
          grid.querySelectorAll(".drop-before, .drop-after").forEach(el => el.classList.remove("drop-before", "drop-after"));
        }
      } else if (activeDrag?.type === "group") {
        if (!section || section.dataset.groupName === activeDrag.id) { clearDropMarkers(); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = section.getBoundingClientRect();
        setDropMarker(section, e.clientX < rect.left + rect.width / 2 ? "drop-before" : "drop-after");
      } else if (!isEditableTarget(e.target)) {
        // Without this Chrome would navigate the whole tab to whatever was dropped.
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOverGroup(section);
        showDevnetraCredit();
      }
    });
    document.addEventListener("dragleave", e => {
      if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight) {
        if (activeDrag) clearDropMarkers();
        else endDrag();
      }
    });
    document.addEventListener("drop", e => {
      const section = groupSectionAt(e);
      if (activeDrag?.type === "bookmark") {
        e.preventDefault();
        const marked = section?.querySelector(".bookmark-tile.drop-before, .bookmark-tile.drop-after");
        const id = activeDrag.id;
        const groupName = section?.dataset.groupName;
        if (marked) reorderBookmark(id, marked.dataset.bookmarkId, marked.classList.contains("drop-before") ? "before" : "after");
        else if (groupName) moveBookmarkToGroup(id, groupName);
      } else if (activeDrag?.type === "group") {
        e.preventDefault();
        if (section?.classList.contains("drop-before")) reorderGroup(activeDrag.id, section.dataset.groupName, "before");
        else if (section?.classList.contains("drop-after")) reorderGroup(activeDrag.id, section.dataset.groupName, "after");
      } else if (!isEditableTarget(e.target)) {
        e.preventDefault();
        const droppedUrl = getDroppedUrl(e.dataTransfer);
        const groupName = section?.dataset.groupName || null;
        document.body.classList.remove("drag-in-progress");
        clearDropMarkers();
        if (droppedUrl) { createBookmarkFromDroppedUrl(droppedUrl, groupName, getDroppedTitle(e.dataTransfer, droppedUrl)); return; }
        hideDevnetraCredit();
        showToast("Drop a website link to add it.");
        return;
      }
      endDrag();
    });
    window.addEventListener("blur", () => { if (!activeDrag) endDrag(); });
  }

  let creditTimer = null;
  function showDevnetraCredit(durationMs = 0) {
    const el = $("#devnetra-credit");
    if (!el) return;
    el.classList.add("show");
    if (creditTimer) { clearTimeout(creditTimer); creditTimer = null; }
    if (durationMs > 0) {
      creditTimer = setTimeout(() => {
        el.classList.remove("show");
        creditTimer = null;
      }, durationMs);
    }
  }
  function hideDevnetraCredit() {
    if (creditTimer) return;
    $("#devnetra-credit")?.classList.remove("show");
  }

  // --- Manage groups ---
  function setCategoryHidden(name, hidden) {
    if (!categories.includes(name)) return;
    const hiddenSet = new Set(state.hiddenCategories || []);
    if (hidden) hiddenSet.add(name);
    else hiddenSet.delete(name);
    state.hiddenCategories = [...hiddenSet].filter(c => categories.includes(c));
    renderGrid();
    void persist();
  }
  function renderManageCategories() {
    const box = $("#manage-categories");
    const hiddenSet = new Set(state.hiddenCategories || []);
    box.innerHTML = orderedGroupNames().map(c => `<div class="manage-category-row"><span class="manage-category-name">${escapeHtml(c)}</span><label class="hidden-group-toggle" title="Hide this group and its sites from the launchpad"><input type="checkbox" data-hidden-category="${escapeHtml(c)}" ${hiddenSet.has(c) ? "checked" : ""}>Hide</label><button type="button" data-rename="${escapeHtml(c)}">Rename</button><button type="button" data-delete="${escapeHtml(c)}">Delete</button></div>`).join("");
  }
  async function createCategory() {
    const name = await ask({ title: "New group", input: "", placeholder: "Group name", okLabel: "Create" });
    if (!name) return;
    const clean = name.slice(0, 40);
    if (groupNameTaken(clean)) { showToast("Group already exists"); return; }
    state.customCategories.push(clean);
    revealedGroups.add(clean);
    renderAll();
    void persist();
    grid.querySelector(`[data-group-name="${CSS.escape(clean)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  async function renameCategory(name) {
    const next = await ask({ title: "Rename group", input: name, okLabel: "Rename" });
    if (!next) return;
    const clean = next.slice(0, 40);
    if (clean === name) return;
    if (clean.toLowerCase() !== name.toLowerCase() && groupNameTaken(clean)) { showToast("Group already exists"); return; }
    const idx = defaultCategories.indexOf(name);
    if (idx >= 0) defaultCategories[idx] = clean;
    else state.customCategories = state.customCategories.map(c => c === name ? clean : c);
    state.groupOrder = (state.groupOrder || []).map(c => c === name ? clean : c);
    state.hiddenCategories = (state.hiddenCategories || []).map(c => c === name ? clean : c);
    state.bookmarks.forEach(b => { if (b.category === name) b.category = clean; });
    if (revealedGroups.delete(name)) revealedGroups.add(clean);
    renderAll();
    void persist();
    showToast("Group renamed");
  }
  async function deleteCategory(name) {
    if (!categories.includes(name)) return;
    if (categories.length <= 1) {
      showToast("Cannot delete the only remaining group.");
      return;
    }
    const bookmarkCount = state.bookmarks.filter(bookmark => bookmark.category === name).length;
    const impact = bookmarkCount
      ? `This permanently removes ${bookmarkCount} site${bookmarkCount === 1 ? "" : "s"} from Sutra. Chrome's own bookmarks are not affected.`
      : "";
    if (!await ask({ title: `Delete “${name}”?`, message: impact, okLabel: "Delete", danger: true })) return;

    // Delete means delete: never silently reassign a group's links to another group.
    state.bookmarks = state.bookmarks.filter(bookmark => bookmark.category !== name);
    const idx = defaultCategories.indexOf(name);
    if (idx >= 0) defaultCategories.splice(idx, 1);
    state.customCategories = (state.customCategories || []).filter(category => category !== name);
    state.groupOrder = (state.groupOrder || []).filter(category => category !== name);
    state.hiddenCategories = (state.hiddenCategories || []).filter(category => category !== name);
    revealedGroups.delete(name);

    renderAll();
    if ($("#settings-modal").open) renderHealthAuditUI();
    const saved = await persist();
    showToast(saved ? "Group deleted" : "Delete could not be saved. Reloading may restore the previous data; export a backup and retry.");
  }

  // --- Bookmark form ---
  let bookmarkFormBaseline = "";
  function bookmarkFormState() {
    return ["#bookmark-url", "#bookmark-name", "#bookmark-category", "#bookmark-note"].map(s => $(s).value.trim()).join("\n");
  }
  function renderCategoryOptions() {
    $("#bookmark-category").innerHTML = orderedGroupNames().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  }
  function openBookmarkModal(item=null, category=null) {
    renderCategoryOptions();
    $("#bookmark-form").reset(); $("#form-error").textContent = "";
    $("#bookmark-name").dataset.userEdited = item ? "true" : "";
    $("#edit-id").value = item?.id || "";
    $("#modal-title").textContent = item ? "Edit site" : "Add a site";
    $("#save-bookmark-btn").textContent = item ? "Save changes" : "Save";
    if (item) {
      $("#bookmark-name").value = item.name; $("#bookmark-url").value = item.url;
      $("#bookmark-category").value = item.category; $("#bookmark-note").value = item.note || "";
    } else {
      $("#bookmark-category").value = category && categories.includes(category) ? category : firstVisibleGroup();
    }
    bookmarkFormBaseline = bookmarkFormState();
    openModal("bookmark-modal");
    (item ? $("#bookmark-name") : $("#bookmark-url")).focus();
  }
  async function requestCloseBookmarkModal() {
    if (bookmarkFormState() !== bookmarkFormBaseline && !await ask({ title: "Discard changes?", okLabel: "Discard", danger: true })) return;
    closeModal("bookmark-modal");
  }
  // Derive a readable default bookmark name from the URL host.
  function defaultBookmarkName(rawUrl) {
    try {
      return new URL(coerceUrl(rawUrl)).hostname.replace(/^www\./i, "");
    } catch { return String(rawUrl || "").trim(); }
  }
  function findDuplicate(url, exceptId = "") {
    const key = normalizeBookmarkUrl(url);
    return state.bookmarks.find(b => b.id !== exceptId && normalizeBookmarkUrl(b.url) === key);
  }
  // A dragged link usually carries its visible text, which makes a better name than the host.
  function getDroppedTitle(dataTransfer, url) {
    try {
      const html = dataTransfer.getData("text/html");
      if (!html) return "";
      const doc = new DOMParser().parseFromString(html, "text/html");
      const link = [...doc.querySelectorAll("a[href]")].find(a => validUrl(a.href) === url);
      const text = (link?.textContent || "").replace(/\s+/g, " ").trim();
      return text && !validUrl(text) ? text.slice(0, 80) : "";
    } catch { return ""; }
  }
  function createBookmarkFromDroppedUrl(rawUrl, category, title = "") {
    const url = coerceUrl(rawUrl);
    if (!url) return false;
    const existing = findDuplicate(url);
    if (existing) {
      if (category && category !== existing.category && !state.layoutLocked) moveBookmarkToGroup(existing.id, category);
      else showToast("Already saved");
      showDevnetraCredit(4500);
      return true;
    }
    const name = title || defaultBookmarkName(url).slice(0, 80);
    const targetCategory = category && categories.includes(category) ? category : firstVisibleGroup();
    state.bookmarks.push({ id: createId(), name, url, category: targetCategory, note: "", createdAt: Date.now() });
    renderAll();
    void persist();
    showToast(`Added ${name}`);
    showDevnetraCredit(4500);
    return true;
  }
  function getDroppedUrl(dataTransfer) {
    try {
      const uriList = (dataTransfer.getData("text/uri-list") || "")
        .split(/\r?\n/)
        .find(line => line && !line.startsWith("#"));
      if (uriList && validUrl(uriList.trim())) return validUrl(uriList.trim());

      const plain = (dataTransfer.getData("text/plain") || "").trim();
      if (validUrl(plain)) return validUrl(plain);
      const match = plain.match(/https?:\/\/[^\s<>"']+/i);
      if (match) {
        const cleaned = validUrl(match[0].replace(/[),.;]+$/, ""));
        if (cleaned) return cleaned;
      }
      if (plain && !/^[a-z][a-z\d+.-]*:/i.test(plain) && /^[\w-]+(\.[\w-]+)+\S*$/.test(plain)) {
        const normalized = validUrl("https://" + plain);
        if (normalized) return normalized;
      }

      const html = dataTransfer.getData("text/html") || "";
      if (html) {
        const hrefMatch = html.match(/href=["'](https?:\/\/[^"']+)["']/i);
        if (hrefMatch && validUrl(hrefMatch[1])) return validUrl(hrefMatch[1]);
      }
    } catch {}
    return null;
  }
  function wireBookmarkForm() {
    $("#bookmark-url").addEventListener("input", () => {
      const nameInput = $("#bookmark-name");
      if (!$("#edit-id").value && (!nameInput.dataset.userEdited || !nameInput.value.trim())) {
        nameInput.dataset.userEdited = "";
        nameInput.value = defaultBookmarkName($("#bookmark-url").value);
      }
    });
    $("#bookmark-name").addEventListener("input", () => { $("#bookmark-name").dataset.userEdited = "true"; });
    $("#bookmark-close").addEventListener("click", requestCloseBookmarkModal);
    $("#bookmark-cancel").addEventListener("click", requestCloseBookmarkModal);
    $("#bookmark-modal").addEventListener("cancel", e => { e.preventDefault(); void requestCloseBookmarkModal(); });
    $("#bookmark-form").addEventListener("submit", e => {
      e.preventDefault();
      const url = coerceUrl($("#bookmark-url").value);
      const name = $("#bookmark-name").value.trim();
      const error = $("#form-error");
      if (!url) { error.textContent = "Enter a valid website address."; $("#bookmark-url").focus(); return; }
      if (!name) { error.textContent = "Give this site a name."; $("#bookmark-name").focus(); return; }
      const id = $("#edit-id").value;
      const duplicate = findDuplicate(url, id);
      if (duplicate) { error.textContent = `Already saved as “${duplicate.name}” in ${duplicate.category}.`; $("#bookmark-url").focus(); return; }
      const existing = state.bookmarks.find(b => b.id === id);
      const bookmark = { id: id || createId(), name, url, category: $("#bookmark-category").value, note: $("#bookmark-note").value.trim(), createdAt: existing?.createdAt || Date.now() };
      if (existing) {
        if (existing.category !== bookmark.category) revealedGroups.add(existing.category);
        state.bookmarks = state.bookmarks.map(b => b.id === id ? bookmark : b);
      } else {
        state.bookmarks.push(bookmark);
      }
      renderAll();
      void persist();

      if (existing) {
        closeModal("bookmark-modal");
        showToast("Site updated");
        return;
      }
      showToast("Site added");
      // Stay open so several sites can be added in a row.
      const savedCategory = bookmark.category;
      $("#bookmark-form").reset();
      $("#bookmark-name").dataset.userEdited = "";
      $("#bookmark-category").value = savedCategory;
      error.textContent = "";
      bookmarkFormBaseline = bookmarkFormState();
      $("#bookmark-url").focus();
    });
  }

  // --- Import and backup ---
  function chromeGetBookmarkTree() {
    return new Promise((resolve, reject) => {
      if (!chrome.bookmarks || typeof chrome.bookmarks.getTree !== "function") {
        reject(new Error("Chrome bookmark access is unavailable. Reload Sutra and check its bookmarks permission."));
        return;
      }
      chrome.bookmarks.getTree(tree => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || "Could not read Chrome bookmarks."));
        else resolve(Array.isArray(tree) ? tree : []);
      });
    });
  }
  function chromeImportGroupName(folderPath, namesOwnedByImport) {
    const parts = folderPath.filter(Boolean);
    const fullPath = parts.join(" / ") || "Bookmarks";
    // Keep group names short by dropping whole leading folders, never cutting a word.
    const leaf = parts[parts.length - 1] || "Bookmarks";
    let tail = leaf.length > 31 ? `${leaf.slice(0, 30)}…` : leaf;
    for (let i = parts.length - 2; i >= 0; i--) {
      const longer = `${parts[i]} / ${tail}`;
      if (longer.length > 31) break;
      tail = longer;
    }
    const base = `Chrome · ${tail}`;
    let candidate = base.slice(0, 40);
    let suffix = 2;
    while (namesOwnedByImport.has(candidate) && namesOwnedByImport.get(candidate) !== fullPath) {
      const suffixText = ` ${suffix++}`;
      candidate = `${base.slice(0, 40 - suffixText.length)}${suffixText}`;
    }
    namesOwnedByImport.set(candidate, fullPath);
    return candidate;
  }
  function collectChromeBookmarks(tree) {
    const collected = [];
    const walk = (node, folderPath) => {
      if (typeof node?.url === "string") {
        const url = validUrl(node.url.trim());
        if (url) collected.push({
          url,
          name: (typeof node.title === "string" && node.title.trim() ? node.title.trim() : defaultBookmarkName(url)).slice(0, 80),
          folderPath: folderPath.length ? folderPath : ["Bookmarks"]
        });
        return;
      }
      const label = typeof node?.title === "string" && node.title.trim() ? node.title.trim().slice(0, 60) : "Bookmarks";
      for (const child of node?.children || []) walk(child, [...folderPath, label]);
    };
    for (const top of tree[0]?.children || []) walk(top, []);
    return collected;
  }
  async function importFromChrome() {
    const consent = await ask({
      title: "Import Chrome bookmarks?",
      message: "Sutra reads bookmark titles, URLs and folder names to copy them into your launchpad. Chrome's bookmarks are not changed and nothing is uploaded.",
      okLabel: "Import"
    });
    if (!consent) return;

    const button = $("#import-chrome-btn");
    button.disabled = true; button.textContent = "Importing…";
    try {
      // Must run straight after the click above: Chrome requires a user gesture, and
      // this resolves immediately when the permission was granted earlier.
      const granted = await new Promise(resolve => chrome.permissions.request({ permissions: ["bookmarks"] }, resolve));
      if (!granted) {
        showToast("Bookmarks permission was not granted.");
        return;
      }
      const collected = collectChromeBookmarks(await chromeGetBookmarkTree());
      if (!collected.length) {
        showToast("No importable Chrome bookmarks were found.");
        return;
      }

      // Existing Sutra links win: importing the same URL again does not duplicate it
      // or unexpectedly move it out of its current group.
      const existingUrls = new Set(state.bookmarks.map(item => normalizeBookmarkUrl(item.url)));
      const namesOwnedByImport = new Map();
      const groupForPath = new Map();
      const pendingBookmarks = [];
      let duplicateCount = 0;

      for (const item of collected) {
        const key = normalizeBookmarkUrl(item.url);
        if (existingUrls.has(key)) {
          duplicateCount++;
          continue;
        }
        const pathKey = JSON.stringify(item.folderPath);
        let groupName = groupForPath.get(pathKey);
        if (!groupName) {
          groupName = chromeImportGroupName(item.folderPath, namesOwnedByImport);
          if (!categories.includes(groupName)) {
            if (state.customCategories.length < 100) {
              state.customCategories.push(groupName);
              refreshCategories();
            } else {
              groupName = firstVisibleGroup();
            }
          }
          groupForPath.set(pathKey, groupName);
        }
        pendingBookmarks.push({
          id: createId(),
          name: item.name,
          url: item.url,
          category: groupName,
          note: "",
          createdAt: Date.now() + pendingBookmarks.length
        });
        existingUrls.add(key);
      }

      if (!pendingBookmarks.length) {
        showToast(`No new bookmarks to import · ${duplicateCount} duplicate(s) skipped`);
        return;
      }

      state.bookmarks.push(...pendingBookmarks);
      renderAll();
      renderHealthAuditUI();
      const saved = await persist();
      showToast(
        saved
          ? `Imported ${pendingBookmarks.length} bookmark(s) · ${duplicateCount} duplicate(s) skipped`
          : `Imported ${pendingBookmarks.length}; saving failed. Export a backup and try again.`
      );
    } catch (err) {
      console.error("Sutra Chrome bookmark import failed:", err);
      showToast(err.message || "Could not import Chrome bookmarks.");
    } finally {
      button.disabled = false; button.textContent = "Import";
    }
  }
  function backupData(backgroundImage) {
    return { app: "Sutra", schemaVersion: 1, exportedAt: new Date().toISOString(), bookmarks: state.bookmarks, preferences: { ...(backgroundImage !== undefined && { backgroundImage }), wallpaperMode: state.wallpaperMode, wallpaperOnline: state.wallpaperOnline, theme: state.theme, accentColor: state.accentColor || "emerald", customCategories: state.customCategories, categoryNames: defaultCategories, iconSize: state.iconSize, groupOrder: state.groupOrder, hiddenCategories: state.hiddenCategories, layoutLocked: state.layoutLocked, iconLookup: state.iconLookup } };
  }
  async function exportBackup() {
    const backup = backupData(await currentWallpaperDataUrl());
    const text = JSON.stringify(backup, null, 2);
    const fileName = `sutra-bookmarks-${backup.exportedAt.slice(0, 10)}.json`;
    // With a backup folder connected, exports are kept there too instead of in Downloads.
    if (backupFolder && await backupFolder.queryPermission({ mode: "readwrite" }).catch(() => "denied") === "granted") {
      try {
        const writable = await (await backupFolder.getFileHandle(fileName, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
        showToast(`Exported to “${backupFolder.name}” as ${fileName}`);
        return;
      } catch (err) { console.warn("Export to the backup folder failed; downloading instead.", err); }
    }
    const blob = new Blob([text], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Sutra backup exported");
  }
  // Resolves true when the file's sites were added.
  async function importBackup(file) {
    if (!file) return false;
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error("This JSON file is unusually large.");
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data && data.bookmarks;
      if (!Array.isArray(incoming)) throw new Error("This file does not contain a bookmarks array.");

      // JSON import is additive: preserve the current library and append any new groups.
      refreshCategories();
      const existingOrder = [...orderedGroupNames()];
      const cleanGroupName = value => typeof value === "string" ? value.trim().slice(0, 40) : "";
      const findGroup = name => categories.find(group => group.toLowerCase() === name.toLowerCase());
      const candidateNames = [];
      if (data && data.preferences && Array.isArray(data.preferences.groupOrder)) candidateNames.push(...data.preferences.groupOrder);
      if (data && data.preferences && Array.isArray(data.preferences.customCategories)) candidateNames.push(...data.preferences.customCategories);
      for (const item of incoming) {
        if (item && typeof item.category === "string") candidateNames.push(item.category);
      }

      const addedGroups = [];
      const groupNameMap = new Map();
      const availableNewGroupSlots = Math.max(0, 100 - (state.customCategories || []).length);
      for (const rawName of candidateNames) {
        const name = cleanGroupName(rawName);
        if (!name || name.toLowerCase() === RESERVED_GROUP) continue;
        const key = name.toLowerCase();
        if (groupNameMap.has(key)) continue;
        const existing = findGroup(name);
        if (existing) {
          groupNameMap.set(key, existing);
          continue;
        }
        if (addedGroups.length >= availableNewGroupSlots) continue;
        addedGroups.push(name);
        groupNameMap.set(key, name);
      }

      const existingUrls = new Set(state.bookmarks.map(item => normalizeBookmarkUrl(item.url)));
      const cleaned = [];
      let duplicateCount = 0;
      for (const item of incoming) {
        if (!item || typeof item.url !== "string") continue;
        const url = coerceUrl(item.url);
        if (!url) continue;
        const key = normalizeBookmarkUrl(url);
        if (existingUrls.has(key)) {
          duplicateCount++;
          continue;
        }
        existingUrls.add(key);
        const rawCategory = cleanGroupName(item.category);
        cleaned.push({
          id: createId(),
          name: (typeof item.name === "string" && item.name.trim().slice(0, 80)) || defaultBookmarkName(url).slice(0, 80),
          url,
          category: (rawCategory && groupNameMap.get(rawCategory.toLowerCase())) || firstVisibleGroup(),
          note: typeof item.note === "string" ? item.note.slice(0, 120) : "",
          createdAt: Number(item.createdAt) || Date.now()
        });
      }

      if (!cleaned.length && !addedGroups.length) throw new Error("No new sites or groups were found in this file.");
      const groupSummary = addedGroups.length ? ` and ${addedGroups.length} new group${addedGroups.length === 1 ? "" : "s"}` : "";
      // Into an empty library (a reinstall or a new computer) the backup's settings come back too.
      const restoring = !state.bookmarks.length && !!data && !!data.preferences && typeof data.preferences === "object";
      const message = restoring
        ? `Restores ${cleaned.length} site${cleaned.length === 1 ? "" : "s"}${groupSummary}, with the theme and layout saved in it.`
        : `Adds ${cleaned.length} new site${cleaned.length === 1 ? "" : "s"}${groupSummary}. Your current library and settings are kept, and duplicates are skipped.`;
      if (!await ask({ title: restoring ? "Restore this backup?" : "Import this backup?", message, okLabel: restoring ? "Restore" : "Import" })) return false;
      if (restoring) restorePreferences(data.preferences);

      state.customCategories = [...new Set([...(state.customCategories || []), ...addedGroups])].slice(0, 100);
      state.groupOrder = [...new Set([...existingOrder, ...addedGroups])];
      state.bookmarks.push(...cleaned);
      if (restoring) {
        restoreGroupLayout(data.preferences, addedGroups);
        try { await addWallpaperFromDataUrl(data.preferences.backgroundImage); }
        catch (err) { console.warn("Could not restore the backup's wallpaper:", err); }
        applyPreferences();
        void applyWallpaper();
        scheduleWallpaperTimer();
      }
      renderAll();
      closeModal("settings-modal");
      const saved = await persist();
      showToast(saved
        ? `Imported ${cleaned.length} site(s) · added ${addedGroups.length} group(s) · skipped ${duplicateCount} duplicate(s)`
        : "Import applied, but saving failed. Export a backup and try again.");
      return true;
    } catch (err) {
      showToast(err instanceof SyntaxError ? "That file is not valid JSON." : (err.message || "Could not import this file."));
      return false;
    } finally {
      $("#import-file").value = "";
    }
  }

  // Into an empty library, renamed or removed default groups and the group order come back as saved.
  function restoreGroupLayout(prefs, addedGroups) {
    const clean = list => Array.isArray(list)
      ? [...new Set(list.filter(name => typeof name === "string" && name.trim() && name.trim().toLowerCase() !== RESERVED_GROUP).map(name => name.trim().slice(0, 40)))].slice(0, 100)
      : null;
    const names = clean(prefs.categoryNames);
    if (names) defaultCategories.splice(0, defaultCategories.length, ...names);
    state.customCategories = [...new Set([...(clean(prefs.customCategories) || []), ...addedGroups])].filter(name => !defaultCategories.includes(name));
    refreshCategories();
    for (const bookmark of state.bookmarks) if (!categories.includes(bookmark.category)) state.customCategories.push(bookmark.category);
    state.customCategories = [...new Set(state.customCategories)].slice(0, 100);
    refreshCategories();
    state.groupOrder = clean(prefs.groupOrder) || state.groupOrder;
    orderedGroupNames();
  }
  function restorePreferences(prefs) {
    if (prefs.theme === "light" || prefs.theme === "dark") state.theme = prefs.theme;
    if (ACCENTS.includes(prefs.accentColor)) state.accentColor = prefs.accentColor;
    const size = Number(prefs.iconSize);
    if (size >= 20 && size <= 88) state.iconSize = size;
    if (typeof prefs.layoutLocked === "boolean") state.layoutLocked = prefs.layoutLocked;
    if (WALLPAPER_MODES.includes(prefs.wallpaperMode)) state.wallpaperMode = prefs.wallpaperMode;
    if (typeof prefs.wallpaperOnline === "boolean") state.wallpaperOnline = prefs.wallpaperOnline;
    if (Array.isArray(prefs.hiddenCategories)) state.hiddenCategories = prefs.hiddenCategories.filter(c => typeof c === "string").slice(0, 100);
  }

  // --- Backup folder ---
  // The user picks a folder once; Sutra then keeps "Sutra Backups/sutra-backup.json" in it up
  // to date, plus one copy per day for the last week. After a reinstall or on another
  // computer, choosing the same folder again offers to restore it.
  const BACKUP_FOLDER_NAME = "Sutra Backups";
  const BACKUP_FOLDER_NAMES = [BACKUP_FOLDER_NAME, "Sutra Backup"]; // the second is the 2.17 name
  const BACKUP_FILE = "sutra-backup.json";
  const BACKUP_DAILY = /^sutra-backup-\d{4}-\d{2}-\d{2}\.json$/;
  const BACKUP_KEEP_DAYS = 7;
  const BACKUP_DELAY_MS = 1500;
  const BACKUP_STATUS_KEY = "sutra_backup";
  const BACKUP_GENERATION_KEY = "sutra_backup_folder"; // bumped whenever a tab connects or stops a folder
  const backupSupported = typeof window.showDirectoryPicker === "function";
  let backupFolder = null;
  let backupParent = "";
  let backupStatus = "off"; // off | saved | permission | error
  let backupError = "";
  let backupTimer = null;
  let backupRunning = null;
  let backupGeneration = null;
  let backupHeld = false; // while a newly chosen folder's own backup is being offered

  // Folder handles cannot go in chrome.storage, so they live in this page's IndexedDB.
  function handleStore(mode, action) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("sutra", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("handles");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("handles", mode);
        const request = action(tx.objectStore("handles"));
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  function readBackupStatus() {
    try { return JSON.parse(localStorage.getItem(BACKUP_STATUS_KEY)) || {}; }
    catch { return {}; }
  }
  function hashText(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36) + ":" + text.length;
  }
  // Another tab may have chosen, changed or stopped the folder; follow it before writing.
  async function refreshBackupFolder() {
    if (!backupSupported) return null;
    let generation = "";
    try { generation = localStorage.getItem(BACKUP_GENERATION_KEY) || ""; } catch {}
    if (generation === backupGeneration) return backupFolder;
    backupGeneration = generation;
    const saved = await handleStore("readonly", store => store.get("backupFolder")).catch(() => null);
    backupFolder = saved && saved.folder || null;
    backupParent = saved && saved.parent || "";
    backupStatus = "off";
    return backupFolder;
  }
  function bumpBackupGeneration() {
    backupGeneration = `${Date.now()}`;
    try { localStorage.setItem(BACKUP_GENERATION_KEY, backupGeneration); } catch {}
  }
  function scheduleBackup() {
    if (!backupSupported) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(() => { void writeBackup(); }, BACKUP_DELAY_MS);
  }
  async function writeBackup({ force = false } = {}) {
    if (!storageLoaded || backupHeld || !await refreshBackupFolder()) return false;
    while (backupRunning) await backupRunning;
    backupRunning = (async () => {
      // An empty library never replaces a saved one, so a reinstall cannot wipe the backup.
      if (!state.bookmarks.length) return false;
      const data = backupData();
      const signature = hashText(JSON.stringify([data.bookmarks, data.preferences]));
      // Nothing changed since the last save, so there is nothing to write.
      if (!force && readBackupStatus().signature === signature) {
        if (backupStatus === "off") backupStatus = "saved";
        return true;
      }
      if (await backupFolder.queryPermission({ mode: "readwrite" }) !== "granted") {
        setBackupStatus("permission");
        return false;
      }
      try {
        const text = JSON.stringify(data, null, 2);
        const day = data.exportedAt.slice(0, 10);
        for (const name of [BACKUP_FILE, `sutra-backup-${day}.json`]) {
          const writable = await (await backupFolder.getFileHandle(name, { create: true })).createWritable();
          await writable.write(text);
          await writable.close();
        }
        const daily = [];
        for await (const [name, entry] of backupFolder.entries()) if (entry.kind === "file" && BACKUP_DAILY.test(name)) daily.push(name);
        for (const name of daily.sort().slice(0, -BACKUP_KEEP_DAYS)) await backupFolder.removeEntry(name).catch(() => {});
        try { localStorage.setItem(BACKUP_STATUS_KEY, JSON.stringify({ signature, at: Date.now() })); } catch {}
        setBackupStatus("saved");
        return true;
      } catch (err) {
        console.error("Sutra folder backup failed:", err);
        setBackupStatus("error", err.name === "NotFoundError" ? "the folder was moved or deleted." : (err.message || "could not write the file."));
        return false;
      }
    })();
    try { return await backupRunning; } finally { backupRunning = null; }
  }
  function setBackupStatus(status, error = "") {
    const changed = status !== backupStatus;
    backupStatus = status; backupError = error;
    renderBackupSettings();
    // Once per browser session, say why backups stopped instead of failing silently.
    if (changed && status === "permission" && !hasOpenModal()) {
      try {
        if (sessionStorage.getItem("sutra_backup_nag")) return;
        sessionStorage.setItem("sutra_backup_nag", "1");
      } catch {}
      showToast("Backups are paused. Open Settings › Library to allow the Sutra Backups folder.");
    }
  }
  function backupAgo(at) {
    if (!at) return "";
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString();
  }
  function renderBackupSettings() {
    const row = $("#backup-row");
    if (!row) return;
    row.hidden = !backupSupported;
    const info = $("#backup-info");
    const name = backupFolder ? backupFolder.name : BACKUP_FOLDER_NAME;
    const where = backupParent ? `“${name}” in ${backupParent}` : `“${name}”`;
    const last = backupAgo(readBackupStatus().at);
    info.textContent = !backupFolder ? `Keeps a copy in a “${BACKUP_FOLDER_NAME}” folder on your computer, updated automatically.`
      : backupStatus === "permission" ? `Chrome needs your OK to keep saving to ${where}.`
      : backupStatus === "error" ? `Could not save to ${where}: ${backupError}`
      : !state.bookmarks.length ? `Connected to ${where}. Nothing is saved while the library is empty.`
      : `Saving to ${where}${last ? ` · last saved ${last}` : ""}.`;
    info.classList.toggle("is-warning", backupStatus === "permission" || backupStatus === "error");
    $("#backup-choose-btn").textContent = backupFolder ? "Change" : "Choose folder";
    $("#backup-allow-btn").hidden = backupStatus !== "permission";
    $("#backup-restore-btn").hidden = !backupFolder || backupStatus === "permission";
    $("#backup-stop-btn").hidden = !backupFolder;
  }
  async function readFolderBackup(folder) {
    try { return await (await folder.getFileHandle(BACKUP_FILE)).getFile(); }
    catch { return null; }
  }
  // Saves a copy of a backup this library is about to replace, under a name pruning never touches.
  async function keepPreviousBackup(folder, text) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const writable = await (await folder.getFileHandle(`sutra-backup-previous-${stamp}.json`, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  }
  async function connectBackupFolder(folder, parent) {
    backupFolder = folder; backupParent = parent; backupStatus = "off";
    try { await handleStore("readwrite", store => store.put({ folder, parent }, "backupFolder")); }
    catch (err) { console.warn("Could not remember the backup folder:", err); }
    bumpBackupGeneration();
    try { localStorage.removeItem(BACKUP_STATUS_KEY); } catch {}
  }
  async function chooseBackupFolder() {
    let picked;
    try { picked = await window.showDirectoryPicker({ id: "sutra-backup", mode: "readwrite", startIn: "documents" }); }
    catch (err) {
      if (err.name !== "AbortError") showToast("Could not open that folder.");
      return;
    }
    try {
      const isBackupFolder = BACKUP_FOLDER_NAMES.includes(picked.name);
      const folder = isBackupFolder ? picked : await picked.getDirectoryHandle(BACKUP_FOLDER_NAME, { create: true });
      // A backup already in the folder (another computer, or before a reinstall) is read before
      // anything can write there, then offered; if it is declined, a copy of it is kept.
      const existing = await readFolderBackup(folder);
      const existingText = existing ? await existing.text() : "";
      backupHeld = true;
      try {
        await connectBackupFolder(folder, isBackupFolder ? "" : picked.name);
        if (existing && !await importBackup(new File([existingText], BACKUP_FILE, { type: "application/json" }))) await keepPreviousBackup(folder, existingText);
      } finally {
        backupHeld = false;
      }
      const saved = await writeBackup({ force: true });
      renderBackupSettings();
      if (saved) showToast(`Backups will be saved to “${folder.name}” automatically`);
    } catch (err) {
      console.error("Sutra backup folder setup failed:", err);
      showToast("Could not use that folder. Try another one, such as Documents.");
    }
  }
  async function allowBackupFolder() {
    if (!backupFolder) return;
    try {
      if (await backupFolder.requestPermission({ mode: "readwrite" }) !== "granted") return;
    } catch { return; }
    backupStatus = "off";
    if (await writeBackup({ force: true })) showToast("Backups resumed");
    renderBackupSettings();
  }
  async function restoreFromFolder() {
    if (!backupFolder) return;
    if (await backupFolder.queryPermission({ mode: "read" }) !== "granted"
      && await backupFolder.requestPermission({ mode: "read" }).catch(() => "denied") !== "granted") return;
    const file = await readFolderBackup(backupFolder);
    if (!file) { showToast(`No backup found in “${BACKUP_FOLDER_NAME}” yet.`); return; }
    await importBackup(file);
  }
  async function stopBackupFolder() {
    if (!await ask({ title: "Stop saving backups?", message: `Files already in “${BACKUP_FOLDER_NAME}” are kept.`, okLabel: "Stop" })) return;
    clearTimeout(backupTimer);
    backupFolder = null; backupParent = ""; backupStatus = "off";
    try { await handleStore("readwrite", store => store.delete("backupFolder")); } catch {}
    bumpBackupGeneration();
    try { localStorage.removeItem(BACKUP_STATUS_KEY); } catch {}
    renderBackupSettings();
  }
  function wireBackupSettings() {
    $("#backup-choose-btn").addEventListener("click", chooseBackupFolder);
    $("#backup-allow-btn").addEventListener("click", allowBackupFolder);
    $("#backup-restore-btn").addEventListener("click", restoreFromFolder);
    $("#backup-stop-btn").addEventListener("click", stopBackupFolder);
  }
  async function startBackupFolder() {
    try { await writeBackup(); }
    catch (err) { console.warn("Sutra backup folder unavailable:", err); }
  }

  // --- Wallpapers ---
  // Images live as Blobs in Cache Storage rather than base64 in chrome.storage: a third
  // smaller, nothing large to parse on every load, and boot.js can paint one through an
  // object URL before the rest of the page has even started.
  const WALLPAPER_CACHE = "sutra-wallpapers";
  const WALLPAPER_ORIGIN = "https://sutra.invalid"; // Cache keys must be http(s) URLs.
  const ONLINE_NEXT_PATH = `${WALLPAPER_ORIGIN}/online/next`;
  const WALLPAPER_LIMIT = 24;
  const WALLPAPER_MODES = ["off", "newtab", "minute", "5min", "hour"];
  const WALLPAPER_INTERVALS = { minute: 60 * 1000, "5min": 5 * 60 * 1000, hour: 60 * 60 * 1000 };
  const DEFAULT_WALLPAPER = "default";
  const ONLINE_WALLPAPER = "online";
  const DEFAULT_WALLPAPER_URL = "default-wallpaper.webp";
  let shownWallpaper = { token: "", url: "" };
  let wallpaperTimer = null;
  let wallpaperDue = false;
  let wallpaperBusy = false;
  let onlinePrefetch = null;
  let stripUrls = [];

  const wallpaperPath = key => key === ONLINE_WALLPAPER ? `${WALLPAPER_ORIGIN}/online/current` : `${WALLPAPER_ORIGIN}/wallpapers/${key}`;
  // Online photos all share one key, so the change time tells one photo from the next.
  const wallpaperToken = (key, changedAt) => key === ONLINE_WALLPAPER ? `${key}@${changedAt}` : key;
  async function readWallpaperBlob(path) {
    try {
      const response = await (await caches.open(WALLPAPER_CACHE)).match(path);
      return response ? await response.blob() : null;
    } catch { return null; }
  }
  async function writeWallpaperBlob(path, blob) {
    await (await caches.open(WALLPAPER_CACHE)).put(path, new Response(blob, { headers: { "content-type": blob.type || "image/webp" } }));
  }
  async function deleteWallpaperBlob(path) {
    try { await (await caches.open(WALLPAPER_CACHE)).delete(path); } catch {}
  }
  function wallpaperPool() {
    const pool = [...state.wallpapers];
    if (state.wallpaperOnline) pool.push(ONLINE_WALLPAPER);
    return pool.length ? pool : [DEFAULT_WALLPAPER];
  }
  function upcomingWallpaper() {
    const pool = wallpaperPool();
    const cursor = (state.wallpaperCursor + 1) % pool.length;
    return { key: pool[cursor], cursor };
  }
  function wallpaperRotates() {
    const pool = wallpaperPool();
    return state.wallpaperMode !== "off" && (pool.length > 1 || pool[0] === ONLINE_WALLPAPER);
  }
  function wallpaperDueAt() {
    if (!wallpaperRotates()) return Infinity;
    if (state.wallpaperMode === "newtab") return 0;
    return state.wallpaperChangedAt + WALLPAPER_INTERVALS[state.wallpaperMode];
  }
  // Wallpaper pixels with the largest useful size for this screen, never more than 2560px.
  function wallpaperSize() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const longest = Math.min(2560, Math.round(Math.max(screen.width, screen.height) * ratio));
    const scale = longest / Math.max(screen.width, screen.height);
    return { width: Math.round(screen.width * scale), height: Math.round(screen.height * scale), longest };
  }

  // Shows a wallpaper by crossfading a second layer in over the current one.
  function paintWallpaper(url) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = img.onerror = async () => {
        try { await img.decode(); } catch {}
        const layers = [...document.querySelectorAll(".wallpaper")];
        const current = layers.find(layer => layer.classList.contains("ready")) || null;
        const next = layers.find(layer => layer !== current);
        next.style.backgroundImage = `url("${url}")`;
        next.style.zIndex = "-1";
        if (current) current.style.zIndex = "-2";
        next.classList.add("ready");
        const previousUrl = shownWallpaper.url;
        shownWallpaper.url = url;
        setTimeout(() => {
          if (current && current !== next) current.classList.remove("ready");
          if (previousUrl.startsWith("blob:") && previousUrl !== url) URL.revokeObjectURL(previousUrl);
        }, 450);
        resolve();
      };
      img.src = url;
    });
  }
  async function applyWallpaper() {
    const key = state.wallpaperCurrent;
    const token = wallpaperToken(key, state.wallpaperChangedAt);
    if (shownWallpaper.token === token) return;
    shownWallpaper.token = token;
    let url = DEFAULT_WALLPAPER_URL;
    if (key !== DEFAULT_WALLPAPER) {
      const blob = await readWallpaperBlob(wallpaperPath(key));
      if (blob) url = URL.createObjectURL(blob);
    }
    if (shownWallpaper.token !== token) { if (url.startsWith("blob:")) URL.revokeObjectURL(url); return; }
    await paintWallpaper(url);
  }
  async function fetchOnlinePhoto() {
    const { width, height } = wallpaperSize();
    const seed = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
    const res = await fetch(`https://picsum.photos/seed/${seed}/${width}/${height}.webp`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Online photo failed: ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith("image/") || blob.size < 1000) throw new Error("Online photo was not an image");
    return blob;
  }
  // The next online photo is downloaded ahead of time, so a change is never left waiting on the network.
  function prefetchOnlineWallpaper() {
    if (!state.wallpaperOnline || onlinePrefetch || !navigator.onLine) return onlinePrefetch;
    onlinePrefetch = (async () => {
      try {
        if (await readWallpaperBlob(ONLINE_NEXT_PATH)) return;
        await writeWallpaperBlob(ONLINE_NEXT_PATH, await fetchOnlinePhoto());
        writeBootHints();
      } catch (err) {
        console.warn("Sutra online wallpaper prefetch failed:", err);
      } finally {
        onlinePrefetch = null;
      }
    })();
    return onlinePrefetch;
  }
  async function promoteOnlineWallpaper() {
    await onlinePrefetch;
    let blob = await readWallpaperBlob(ONLINE_NEXT_PATH);
    if (!blob) {
      try { blob = await fetchOnlinePhoto(); } catch (err) { console.warn("Sutra online wallpaper failed:", err); return false; }
    }
    await writeWallpaperBlob(wallpaperPath(ONLINE_WALLPAPER), blob);
    await deleteWallpaperBlob(ONLINE_NEXT_PATH);
    return true;
  }
  function setCurrentWallpaper(key, cursor) {
    state.wallpaperCurrent = key;
    state.wallpaperCursor = cursor;
    state.wallpaperChangedAt = Date.now();
    void persist();
    writeBootHints();
    void applyWallpaper();
    if ($("#settings-modal").open) void renderWallpaperSettings();
    scheduleWallpaperTimer();
    (window.requestIdleCallback || setTimeout)(() => { void prefetchOnlineWallpaper(); });
  }
  async function advanceWallpaper({ manual = false, fromTimer = false } = {}) {
    if (wallpaperBusy) return;
    wallpaperBusy = true;
    try {
      if (fromTimer) {
        // Another open tab may have changed it already; follow that instead of skipping ahead twice.
        const stored = await storageGet(["wallpaperChangedAt"]);
        const interval = WALLPAPER_INTERVALS[state.wallpaperMode];
        if (interval && Date.now() - (stored.wallpaperChangedAt || 0) < interval - 2000) { scheduleWallpaperTimer(); return; }
      }
      const pool = wallpaperPool();
      // If an online photo cannot be fetched, move on to the next image rather than stalling.
      for (let attempt = 0; attempt < pool.length; attempt++) {
        const { key, cursor } = upcomingWallpaper();
        if (key === ONLINE_WALLPAPER && !await promoteOnlineWallpaper()) {
          state.wallpaperCursor = cursor;
          continue;
        }
        setCurrentWallpaper(key, cursor);
        return;
      }
      if (manual) showToast("Could not load an online photo. Check your connection.");
      scheduleWallpaperTimer(60000);
    } finally {
      wallpaperBusy = false;
    }
  }
  function scheduleWallpaperTimer(minDelay = 1000) {
    clearTimeout(wallpaperTimer);
    wallpaperDue = false;
    const interval = WALLPAPER_INTERVALS[state.wallpaperMode];
    if (!interval || !wallpaperRotates()) return;
    const delay = Math.max(minDelay, state.wallpaperChangedAt + interval - Date.now());
    wallpaperTimer = setTimeout(() => {
      // A background tab waits until it is looked at instead of downloading or decoding unseen images.
      if (document.hidden) { wallpaperDue = true; return; }
      void advanceWallpaper({ fromTimer: true });
    }, delay);
  }
  // boot.js reads these before first paint to show the right wallpaper straight away,
  // including the one this load is about to switch to.
  function writeBootHints() {
    const hint = (key, changedAt, path) => ({
      token: wallpaperToken(key, changedAt),
      path: key === DEFAULT_WALLPAPER ? "" : path || wallpaperPath(key)
    });
    const boot = {
      theme: state.theme,
      accent: state.accentColor,
      iconSize: state.iconSize,
      wallpaper: hint(state.wallpaperCurrent, state.wallpaperChangedAt)
    };
    if (wallpaperRotates() && state.wallpaperMode === "newtab") {
      const { key } = upcomingWallpaper();
      boot.upcoming = { ...hint(key, 0, key === ONLINE_WALLPAPER ? ONLINE_NEXT_PATH : ""), dueAt: 0 };
    }
    try { localStorage.setItem("sutra_boot", JSON.stringify(boot)); } catch {}
  }

  function resizeWallpaper(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Unreadable image")); };
      img.onload = () => {
        const { longest } = wallpaperSize();
        const scale = Math.min(1, longest / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
        URL.revokeObjectURL(objectUrl);
        if (!canvas.width || !canvas.height) { reject(new Error("Empty image")); return; }
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => blob && blob.size > 100 ? resolve(blob) : reject(new Error("Empty image")), "image/webp", .82);
      };
      img.src = objectUrl;
    });
  }
  async function addWallpapers(fileList) {
    const input = $("#bg-upload");
    try {
      const files = [...(fileList || [])].filter(file => file.type.startsWith("image/"));
      if (!files.length) { if (fileList?.length) showToast("Choose image files."); return; }
      const room = WALLPAPER_LIMIT - state.wallpapers.length;
      if (room <= 0) { showToast(`You can keep up to ${WALLPAPER_LIMIT} wallpapers. Remove one first.`); return; }
      const added = [];
      for (const file of files.slice(0, room)) {
        try {
          const id = createId();
          await writeWallpaperBlob(wallpaperPath(id), await resizeWallpaper(file));
          added.push(id);
        } catch (err) { console.warn("Sutra wallpaper skipped:", file.name, err); }
      }
      if (!added.length) { showToast("Could not use that image. Try a different one."); return; }
      state.wallpapers.push(...added);
      setCurrentWallpaper(added[0], wallpaperPool().indexOf(added[0]));
      const skipped = files.length - added.length;
      showToast(`Added ${added.length} wallpaper${added.length === 1 ? "" : "s"}${skipped ? ` · ${skipped} skipped` : ""}`);
    } finally {
      input.value = "";
    }
  }
  async function removeWallpaper(id) {
    if (!state.wallpapers.includes(id)) return;
    state.wallpapers = state.wallpapers.filter(key => key !== id);
    await deleteWallpaperBlob(wallpaperPath(id));
    if (state.wallpaperCurrent === id) {
      const pool = wallpaperPool();
      const key = pool[0] === ONLINE_WALLPAPER && state.wallpapers.length === 0 ? DEFAULT_WALLPAPER : pool[0];
      setCurrentWallpaper(key, key === DEFAULT_WALLPAPER ? -1 : 0);
    } else {
      const position = wallpaperPool().indexOf(state.wallpaperCurrent);
      state.wallpaperCursor = position >= 0 ? position : Math.min(state.wallpaperCursor, wallpaperPool().length - 1);
      void persist();
      writeBootHints();
      void renderWallpaperSettings();
    }
  }
  function chooseWallpaper(key) {
    if (key === ONLINE_WALLPAPER && state.wallpaperCurrent !== ONLINE_WALLPAPER) {
      state.wallpaperCursor = wallpaperPool().indexOf(ONLINE_WALLPAPER) - 1;
      void advanceWallpaper({ manual: true });
      return;
    }
    if (key === state.wallpaperCurrent) return;
    setCurrentWallpaper(key, key === DEFAULT_WALLPAPER ? -1 : wallpaperPool().indexOf(key));
  }
  async function setWallpaperOnline(enabled) {
    state.wallpaperOnline = enabled;
    if (!enabled) {
      await deleteWallpaperBlob(ONLINE_NEXT_PATH);
      if (state.wallpaperCurrent === ONLINE_WALLPAPER) {
        setCurrentWallpaper(state.wallpapers[0] || DEFAULT_WALLPAPER, state.wallpapers.length ? 0 : -1);
        return;
      }
    }
    void persist();
    writeBootHints();
    scheduleWallpaperTimer();
    void renderWallpaperSettings();
    if (enabled) void prefetchOnlineWallpaper();
  }
  function setWallpaperMode(mode) {
    if (!WALLPAPER_MODES.includes(mode)) return;
    state.wallpaperMode = mode;
    // Interval modes count from now, not from whenever the wallpaper last happened to change.
    state.wallpaperChangedAt = Date.now();
    shownWallpaper.token = wallpaperToken(state.wallpaperCurrent, state.wallpaperChangedAt);
    void persist();
    writeBootHints();
    scheduleWallpaperTimer();
    void renderWallpaperSettings();
    if (mode !== "off") void prefetchOnlineWallpaper();
  }
  async function renderWallpaperSettings() {
    const strip = $("#wallpaper-strip");
    const keys = [DEFAULT_WALLPAPER, ...state.wallpapers, ...(state.wallpaperOnline ? [ONLINE_WALLPAPER] : [])];
    const urls = await Promise.all(keys.map(async key => {
      if (key === DEFAULT_WALLPAPER) return DEFAULT_WALLPAPER_URL;
      const blob = await readWallpaperBlob(wallpaperPath(key));
      return blob ? URL.createObjectURL(blob) : "";
    }));
    stripUrls.forEach(url => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); });
    stripUrls = urls;
    strip.innerHTML = keys.map((key, i) => {
      const label = key === DEFAULT_WALLPAPER ? "Built-in wallpaper" : key === ONLINE_WALLPAPER ? "Online photos" : `Wallpaper ${i}`;
      const current = key === state.wallpaperCurrent;
      return `<div class="wallpaper-thumb${current ? " is-current" : ""}${key === ONLINE_WALLPAPER ? " is-online" : ""}"><button type="button" data-wallpaper="${escapeHtml(key)}" aria-label="${label}${current ? " (current)" : ""}" title="${label}" style="${urls[i] ? `background-image:url(&quot;${urls[i]}&quot;)` : ""}">${key === ONLINE_WALLPAPER ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>` : ""}</button>${key !== DEFAULT_WALLPAPER && key !== ONLINE_WALLPAPER ? `<button type="button" class="wallpaper-remove" data-remove-wallpaper="${escapeHtml(key)}" aria-label="Remove ${label}" title="Remove">×</button>` : ""}</div>`;
    }).join("") + (state.wallpapers.length < WALLPAPER_LIMIT ? `<label class="wallpaper-add" title="Add images"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><input type="file" id="bg-upload" accept="image/jpeg,image/png,image/webp,image/avif" multiple aria-label="Add wallpaper images"></label>` : "");
    $("#wallpaper-mode").value = state.wallpaperMode;
    $("#wallpaper-online").checked = state.wallpaperOnline;
    const rotates = wallpaperRotates();
    $("#wallpaper-next").disabled = wallpaperPool().length < 2 && !state.wallpaperOnline;
    $("#wallpaper-hint").textContent = state.wallpaperMode !== "off" && !rotates
      ? "Add another image or turn on online photos to start rotating." : "";
  }
  function wireWallpaperSettings() {
    const strip = $("#wallpaper-strip");
    strip.addEventListener("click", e => {
      const remove = e.target.closest("[data-remove-wallpaper]");
      if (remove) { void removeWallpaper(remove.dataset.removeWallpaper); return; }
      const pick = e.target.closest("[data-wallpaper]");
      if (pick) chooseWallpaper(pick.dataset.wallpaper);
    });
    strip.addEventListener("change", e => { if (e.target.id === "bg-upload") void addWallpapers(e.target.files); });
    $("#wallpaper-mode").addEventListener("change", e => setWallpaperMode(e.target.value));
    $("#wallpaper-online").addEventListener("change", e => { void setWallpaperOnline(e.target.checked); });
    $("#wallpaper-next").addEventListener("click", () => { void advanceWallpaper({ manual: true }); });
    $("#settings-modal").addEventListener("close", () => {
      stripUrls.forEach(url => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); });
      stripUrls = [];
      strip.innerHTML = "";
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (wallpaperDue || (WALLPAPER_INTERVALS[state.wallpaperMode] && Date.now() >= wallpaperDueAt())) void advanceWallpaper({ fromTimer: true });
    });
  }
  // Versions before 2.16 kept one wallpaper as a data URL in chrome.storage. The key's own
  // presence is the signal, since another open tab may already have saved the new settings.
  // Adds an embedded image (an old setting or a JSON backup) as the current wallpaper.
  async function addWallpaperFromDataUrl(dataUrl) {
    if (typeof dataUrl !== "string" || !/^data:image\/(?:png|jpeg|webp|jpg);base64,/.test(dataUrl)) return false;
    if (state.wallpapers.length >= WALLPAPER_LIMIT) return false;
    const id = createId();
    await writeWallpaperBlob(wallpaperPath(id), await (await fetch(dataUrl)).blob());
    state.wallpapers = [id, ...state.wallpapers];
    state.wallpaperCurrent = id;
    state.wallpaperCursor = 0;
    return true;
  }
  async function migrateLegacyWallpaper() {
    const { backgroundImage } = await storageGet(["backgroundImage"]);
    if (typeof backgroundImage !== "string" || !backgroundImage) return false;
    await addWallpaperFromDataUrl(backgroundImage);
    await storageRemove(["backgroundImage"]);
    return true;
  }
  async function startWallpapers() {
    try {
      if (await migrateLegacyWallpaper()) void persist();
    } catch (err) { console.warn("Sutra wallpaper migration failed:", err); }
    const boot = await (window.__sutraWallpaper || Promise.resolve(null));
    if (boot) shownWallpaper = boot;
    if (Date.now() >= wallpaperDueAt()) await advanceWallpaper();
    else void applyWallpaper();
    writeBootHints();
    scheduleWallpaperTimer();
    (window.requestIdleCallback || setTimeout)(() => { void prefetchOnlineWallpaper(); });
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  async function currentWallpaperDataUrl() {
    if (!state.wallpapers.includes(state.wallpaperCurrent)) return "";
    const blob = await readWallpaperBlob(wallpaperPath(state.wallpaperCurrent));
    return blob ? blobToDataUrl(blob) : "";
  }

  function applyPreferences() {
    document.body.classList.toggle("light-theme", state.theme === "light");
    document.body.dataset.accent = state.accentColor || "emerald";
    document.documentElement.style.setProperty("--icon-size", `${state.iconSize || 48}px`);
    $("#theme-btn").setAttribute("aria-label", state.theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    updateAccentPickerUI();
    writeBootHints();
  }
  function wireAccentPicker() {
    document.querySelectorAll(".accent-swatch[data-color]").forEach(btn => {
      btn.addEventListener("click", () => {
        const color = btn.dataset.color;
        if (!ACCENTS.includes(color)) return;
        state.accentColor = color;
        applyPreferences();
        void persist();
      });
    });
  }
  function updateAccentPickerUI() {
    const active = state.accentColor || "emerald";
    document.querySelectorAll(".accent-swatch[data-color]").forEach(btn => {
      const isCurrent = btn.dataset.color === active;
      btn.classList.toggle("active", isCurrent);
      btn.setAttribute("aria-checked", isCurrent ? "true" : "false");
    });
  }

  // --- Library Health & Duplicate Cleaner ---
  // Paths, queries and fragments stay case-sensitive and intact: on many sites they are
  // what identifies the page (YouTube IDs, Google Docs IDs, Gmail "#inbox" routes), so
  // treating them as equal would make the cleaner delete bookmarks that are not duplicates.
  function normalizeBookmarkUrl(raw) {
    try {
      const u = new URL(coerceUrl(raw));
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      const path = u.pathname.replace(/\/+$/, "") || "/";
      const params = new URLSearchParams(u.search);
      params.sort();
      const query = params.toString() ? "?" + params.toString() : "";
      return `${u.protocol}//${host}${u.port ? ":" + u.port : ""}${path}${query}${u.hash}`;
    } catch {
      return null;
    }
  }
  function countDuplicates() {
    const seen = new Set();
    let duplicates = 0;
    for (const b of state.bookmarks) {
      const key = normalizeBookmarkUrl(b.url);
      if (seen.has(key)) duplicates++;
      seen.add(key);
    }
    return duplicates;
  }
  function renderHealthAuditUI() {
    const total = state.bookmarks.length;
    const duplicates = countDuplicates();
    const sites = `${total} site${total === 1 ? "" : "s"}`;
    $("#health-summary").textContent = !total ? "No sites yet."
      : duplicates ? `${sites}, ${duplicates} duplicate${duplicates === 1 ? "" : "s"}` : `${sites}, no duplicates`;
    $("#health-clean-btn").hidden = !duplicates;
  }
  async function cleanDuplicates() {
    const duplicates = countDuplicates();
    if (!duplicates) return;
    if (!await ask({ title: `Remove ${duplicates} duplicate${duplicates === 1 ? "" : "s"}?`, message: "The first copy of each link is kept.", okLabel: "Remove", danger: true })) return;

    const seenUrls = new Set();
    state.bookmarks = state.bookmarks.filter(b => {
      const key = normalizeBookmarkUrl(b.url);
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    });
    renderAll();
    const saved = await persist();
    renderHealthAuditUI();
    showToast(saved ? `Removed ${duplicates} duplicate${duplicates === 1 ? "" : "s"}` : "Failed to save cleaned bookmarks");
  }

  // --- Keyboard Navigation (Arrow Key Selection) ---
  let keyboardFocusedIndex = -1;

  function getVisibleTiles() {
    return Array.from(grid.querySelectorAll(".launch-collection:not([hidden]) .bookmark-tile[data-bookmark-id]:not([hidden])"));
  }
  function setTileKeyboardFocus(index) {
    const tiles = getVisibleTiles();
    tiles.forEach(t => t.classList.remove("is-keyboard-focused"));
    if (index >= 0 && index < tiles.length) {
      keyboardFocusedIndex = index;
      const target = tiles[index];
      target.classList.add("is-keyboard-focused");
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      keyboardFocusedIndex = -1;
    }
  }
  function clearTileKeyboardFocus() {
    grid.querySelector(".is-keyboard-focused")?.classList.remove("is-keyboard-focused");
    keyboardFocusedIndex = -1;
  }
  function openTile(index) {
    getVisibleTiles()[index]?.querySelector("a.tile-open")?.click();
  }
  function findTileInDirection(direction) {
    const tiles = getVisibleTiles();
    if (!tiles.length) return -1;
    if (keyboardFocusedIndex < 0 || keyboardFocusedIndex >= tiles.length) {
      return direction === "down" || direction === "right" ? 0 : -1;
    }

    const curRect = tiles[keyboardFocusedIndex].getBoundingClientRect();
    const curCx = curRect.left + curRect.width / 2;
    const curCy = curRect.top + curRect.height / 2;

    let bestIndex = -1;
    let minDistance = Infinity;

    tiles.forEach((tile, i) => {
      if (i === keyboardFocusedIndex) return;
      const r = tile.getBoundingClientRect();
      const dx = r.left + r.width / 2 - curCx;
      const dy = r.top + r.height / 2 - curCy;
      let dist = Infinity;
      if (direction === "right" && dx > 5 && Math.abs(dy) < r.height) dist = dx + Math.abs(dy) * 2;
      else if (direction === "left" && dx < -5 && Math.abs(dy) < r.height) dist = -dx + Math.abs(dy) * 2;
      else if (direction === "down" && dy > 10) dist = dy * 2 + Math.abs(dx);
      else if (direction === "up" && dy < -10) dist = -dy * 2 + Math.abs(dx);
      if (dist < minDistance) { minDistance = dist; bestIndex = i; }
    });

    if (bestIndex === -1) {
      if (direction === "right" && keyboardFocusedIndex < tiles.length - 1) return keyboardFocusedIndex + 1;
      if (direction === "left" && keyboardFocusedIndex > 0) return keyboardFocusedIndex - 1;
    }
    return bestIndex;
  }
  function wireKeyboard() {
    const searchInput = $("#search-input");
    document.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (hasOpenModal()) return;
        closeMenu();
        clearTileKeyboardFocus();
        searchInput.focus();
        searchInput.select();
        return;
      }

      // Native dialogs manage their own focus trap and Escape handling.
      if (hasOpenModal()) return;

      if (e.key === "Escape" && stopVoiceSearch()) { e.preventDefault(); return; }

      const menu = $("#menu");
      if (!menu.hidden) {
        if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
        return;
      }

      const active = document.activeElement;
      const inSearch = active === searchInput;
      const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes(active?.tagName);
      if (isInput && !inSearch) return;

      if (inSearch) {
        if (e.key === "ArrowDown" && getVisibleTiles().length) {
          e.preventDefault();
          setTileKeyboardFocus(0);
          searchInput.blur();
        } else if (e.key === "Enter") {
          const query = searchInput.value.trim();
          if (!query) return;
          e.preventDefault();
          if (getVisibleTiles().length) openTile(0);
          else window.open("https://www.google.com/search?q=" + encodeURIComponent(query), "_blank", "noopener,noreferrer");
        } else if (e.key === "Escape") {
          if (searchInput.value) {
            searchInput.value = "";
            applySearch();
          } else {
            searchInput.blur();
          }
        }
        return;
      }

      // Tile navigation when keyboardFocusedIndex >= 0
      if (keyboardFocusedIndex >= 0) {
        const direction = { ArrowRight: "right", ArrowLeft: "left", ArrowDown: "down", ArrowUp: "up" }[e.key];
        if (direction) {
          e.preventDefault();
          const next = findTileInDirection(direction);
          if (next >= 0) setTileKeyboardFocus(next);
          else if (direction === "left" || direction === "up") {
            clearTileKeyboardFocus();
            searchInput.focus();
          }
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          openTile(keyboardFocusedIndex);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          clearTileKeyboardFocus();
          searchInput.focus();
          return;
        }
        // Tabbing moves real focus elsewhere, so the tile highlight must not linger.
        if (e.key === "Tab") { clearTileKeyboardFocus(); return; }
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        if (getVisibleTiles().length) {
          e.preventDefault();
          setTileKeyboardFocus(0);
        }
        return;
      }

      if (e.key === "Escape") {
        const weatherPop = $("#weather-popover");
        if (!weatherPop.hidden) { toggleWeatherPopover(false); $("#weather-widget").focus(); }
        return;
      }

      // Typing anywhere starts a search.
      if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
        clearTileKeyboardFocus();
        searchInput.focus();
      }
    });
  }

  // --- Voice search ---
  // Chrome's built-in speech recognition, the same Google service as Chrome's own voice
  // search. A spoken query is handled exactly like typing it and pressing Enter.
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let voiceStarting = false;
  let voiceHeard = false;

  function setVoiceListening(listening) {
    const button = $("#voice-btn");
    button.classList.toggle("is-listening", listening);
    button.setAttribute("aria-pressed", String(listening));
    button.title = listening ? "Stop listening" : "Search by voice";
    $(".search-wrap").classList.toggle("is-listening", listening);
    $("#search-input").placeholder = listening ? "Listening…" : "Search sites…";
  }
  // Results arrive seconds after the click, when Chrome would block a new tab as a popup,
  // so this tab goes to the result, as Chrome's own voice search does.
  function runSearch(query) {
    const searchInput = $("#search-input");
    searchInput.value = query;
    applySearch();
    const link = getVisibleTiles()[0]?.querySelector("a.tile-open");
    location.assign(link ? link.href : "https://www.google.com/search?q=" + encodeURIComponent(query));
  }
  // Extension pages are refused speech recognition until the microphone itself has been
  // allowed, so ask for it directly first; that is what shows Chrome's permission prompt.
  async function ensureMicrophone() {
    try {
      const status = await navigator.permissions.query({ name: "microphone" });
      if (status.state === "granted") return true;
      if (status.state === "denied") return false;
    } catch {}
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      return true;
    } catch { return false; }
  }
  function voiceErrorMessage(error) {
    return {
      "no-speech": "Didn't catch that. Try again.",
      "audio-capture": "No microphone was found.",
      "network": "Voice search needs an internet connection.",
      "not-allowed": "Microphone access is blocked. Allow it from the icon in the address bar.",
      "service-not-allowed": "Voice search is not available in this browser.",
      "language-not-supported": "Voice search does not support your browser language."
    }[error] || "Voice search stopped unexpectedly.";
  }
  async function toggleVoiceSearch() {
    if (recognition) { recognition.stop(); return; }
    if (voiceStarting) return;
    closeMenu();
    clearTileKeyboardFocus();
    setVoiceListening(true);
    voiceStarting = true;
    const allowed = await ensureMicrophone().finally(() => { voiceStarting = false; });
    if (!allowed) {
      setVoiceListening(false);
      showToast(voiceErrorMessage("not-allowed"));
      return;
    }
    const searchInput = $("#search-input");
    const previousQuery = searchInput.value;
    const session = new SpeechRecognition();
    recognition = session;
    voiceHeard = false;
    session.lang = navigator.language || "en-US";
    session.interimResults = true;
    session.maxAlternatives = 1;
    session.onresult = e => {
      const transcript = [...e.results].map(result => result[0].transcript).join("").trim();
      if (!transcript) return;
      voiceHeard = true;
      searchInput.value = transcript;
      applySearch();
      const last = e.results[e.results.length - 1];
      if (last.isFinal) {
        session.onresult = null;
        session.stop();
        runSearch(transcript);
      }
    };
    session.onerror = e => {
      if (e.error !== "aborted") showToast(voiceErrorMessage(e.error));
    };
    session.onend = () => {
      if (recognition !== session) return;
      recognition = null;
      setVoiceListening(false);
      // Nothing usable was heard, so put back whatever the box held before.
      if (!voiceHeard && searchInput.value !== previousQuery) {
        searchInput.value = previousQuery;
        applySearch();
      }
    };
    try {
      session.start();
    } catch (err) {
      console.warn("Sutra voice search failed to start:", err);
      recognition = null;
      setVoiceListening(false);
      showToast(voiceErrorMessage(""));
    }
  }
  function stopVoiceSearch() {
    if (!recognition) return false;
    recognition.abort();
    return true;
  }
  function wireVoiceSearch() {
    const button = $("#voice-btn");
    if (!SpeechRecognition || !navigator.mediaDevices) return;
    button.hidden = false;
    button.addEventListener("click", () => { void toggleVoiceSearch(); });
    // Leaving the tab ends a session rather than recording in the background.
    document.addEventListener("visibilitychange", () => { if (document.hidden) stopVoiceSearch(); });
  }

  function toggleWeatherPopover(open) {
    const pop = $("#weather-popover");
    const next = open === undefined ? pop.hidden : open;
    pop.hidden = !next;
    $("#weather-widget").setAttribute("aria-expanded", String(next));
  }
  function openSettings() {
    renderManageCategories();
    renderHealthAuditUI();
    updateAccentPickerUI();
    $("#icon-size").value = state.iconSize || 48;
    $("#icon-size-label").textContent = `${state.iconSize || 48} px`;
    $("#layout-lock-toggle").checked = !!state.layoutLocked;
    $("#icon-lookup-toggle").checked = !!state.iconLookup;
    void renderWallpaperSettings();
    renderBackupSettings();
    void refreshBackupFolder().then(renderBackupSettings);
    openModal("settings-modal");
  }
  function wireEvents() {
    $(".brand").addEventListener("click", e => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    $("#settings-btn").addEventListener("click", openSettings);
    $("#add-site-btn").addEventListener("click", () => openBookmarkModal());
    $("#add-category-btn").addEventListener("click", createCategory);
    $("#theme-btn").addEventListener("click", () => { state.theme = state.theme === "dark" ? "light" : "dark"; applyPreferences(); void persist(); });
    $("#search-input").addEventListener("input", applySearch);

    $("#icon-size").addEventListener("input", e => {
      state.iconSize = Number(e.target.value);
      $("#icon-size-label").textContent = `${state.iconSize} px`;
      document.documentElement.style.setProperty("--icon-size", `${state.iconSize}px`);
      void persist();
    });
    $("#layout-lock-toggle").addEventListener("change", e => { state.layoutLocked = !!e.target.checked; renderGrid(); void persist(); });
    $("#icon-lookup-toggle").addEventListener("change", e => setIconLookup(!!e.target.checked));
    $("#refresh-icons-btn").addEventListener("click", () => { refreshIcons(); showToast("Fetching site icons again"); });
    $("#import-chrome-btn").addEventListener("click", importFromChrome);
    $("#settings-export-btn").addEventListener("click", exportBackup);
    $("#import-file").addEventListener("change", e => importBackup(e.target.files[0]));
    wireWallpaperSettings();
    wireBackupSettings();
    wireAccentPicker();
    $("#health-clean-btn").addEventListener("click", cleanDuplicates);
    $("#manage-categories").addEventListener("change", e => {
      if (e.target.dataset.hiddenCategory) setCategoryHidden(e.target.dataset.hiddenCategory, e.target.checked);
    });
    $("#manage-categories").addEventListener("click", e => {
      const button = e.target.closest("button");
      if (button?.dataset.rename) renameCategory(button.dataset.rename);
      else if (button?.dataset.delete) deleteCategory(button.dataset.delete);
    });

    document.querySelectorAll("[data-close]").forEach(btn => btn.addEventListener("click", () => closeModal(btn.dataset.close)));
    document.querySelectorAll("dialog").forEach(dialog => {
      dialog.addEventListener("close", () => {
        const toast = $("#toast");
        if (toast.parentElement === dialog) document.body.insertBefore(toast, $("#devnetra-credit"));
        if (!hasOpenModal() && storageSyncPending) scheduleStorageSync("modal-closed");
      });
    });
    // Clicking outside the bookmark editor must not discard the user's work.
    $("#settings-modal").addEventListener("click", e => { if (e.target === e.currentTarget) closeModal("settings-modal"); });

    document.addEventListener("click", e => {
      if (!e.target.closest("#menu, .tile-menu, .collection-manage")) closeMenu();
      if (!e.target.closest(".weather")) toggleWeatherPopover(false);
    });

    $("#weather-widget").addEventListener("click", () => toggleWeatherPopover());
    const refreshBtn = $("#weather-refresh-btn");
    refreshBtn.addEventListener("click", () => {
      refreshBtn.textContent = "…";
      void fetchWeather(true).finally(() => { refreshBtn.textContent = "↻"; });
    });
    $("#weather-unit-toggle").addEventListener("click", () => { toggleWeatherUnit().catch(err => console.warn("Sutra weather unit:", err)); });

    wireAskDialog();
    wireVoiceSearch();
    wireMenu();
    wireBookmarkForm();
    wireGridEvents();
    wireDragAndDrop();
    wireKeyboard();
  }

  // Apply a single authoritative Chrome storage snapshot to the UI model.
  // Every page resume and cross-tab storage update uses the same normalisation path.
  function applyStoredData(data) {
    const before = stateSignature();
    const rawBookmarks = Array.isArray(data.bookmarks) ? data.bookmarks
      : Array.isArray(data.shortcuts) ? data.shortcuts : [];
    const cleanGroup = value => typeof value === "string" ? value.trim().slice(0, 40) : "";

    if (Array.isArray(data.categoryNames)) {
      defaultCategories.splice(0, defaultCategories.length,
        ...data.categoryNames.filter(c => typeof c === "string" && c.trim()).slice(0, 100));
    }

    state.customCategories = Array.isArray(data.customCategories)
      ? data.customCategories.filter(c => typeof c === "string" && c.trim() && !defaultCategories.includes(c)).slice(0, 100)
      : [];

    // Recover groups embedded in bookmark records when older or partial backups
    // did not contain a separate customCategories array.
    for (const item of rawBookmarks) {
      const savedGroup = cleanGroup(item?.category);
      if (savedGroup && savedGroup.toLowerCase() !== RESERVED_GROUP &&
          !defaultCategories.includes(savedGroup) && !state.customCategories.includes(savedGroup)) {
        state.customCategories.push(savedGroup);
      }
    }
    state.customCategories = [...new Set(state.customCategories)];
    refreshCategories();
    if (!categories.length) {
      defaultCategories.push("General");
      refreshCategories();
    }

    state.theme = data.theme === "light" ? "light" : "dark";
    state.accentColor = ACCENTS.includes(data.accentColor) ? data.accentColor : "emerald";
    state.iconSize = Number.isFinite(data.iconSize) ? Math.max(20, Math.min(88, data.iconSize)) : 48;
    state.groupOrder = Array.isArray(data.groupOrder)
      ? data.groupOrder.filter(c => typeof c === "string").slice(0, 200) : [];
    state.hiddenCategories = Array.isArray(data.hiddenCategories)
      ? [...new Set(data.hiddenCategories.filter(c => typeof c === "string" && c.trim()).map(c => c.trim()))].slice(0, 200) : [];
    state.layoutLocked = data.layoutLocked === true;
    state.iconLookup = data.iconLookup === true;
    state.wallpapers = Array.isArray(data.wallpapers)
      ? [...new Set(data.wallpapers.filter(id => typeof id === "string" && /^[\w-]{1,64}$/.test(id)))].slice(0, WALLPAPER_LIMIT) : [];
    state.wallpaperMode = WALLPAPER_MODES.includes(data.wallpaperMode) ? data.wallpaperMode : "off";
    state.wallpaperOnline = data.wallpaperOnline === true;
    state.wallpaperCurrent = [DEFAULT_WALLPAPER, ...state.wallpapers, ...(state.wallpaperOnline ? [ONLINE_WALLPAPER] : [])].includes(data.wallpaperCurrent)
      ? data.wallpaperCurrent : DEFAULT_WALLPAPER;
    state.wallpaperCursor = Number.isInteger(data.wallpaperCursor) ? data.wallpaperCursor : -1;
    state.wallpaperChangedAt = Number.isFinite(data.wallpaperChangedAt) ? data.wallpaperChangedAt : 0;

    const seenIds = new Set();
    state.bookmarks = rawBookmarks.map(item => {
      if (!item || typeof item !== "object") return null;
      const url = coerceUrl(item.url);
      if (!url) return null;
      const name = typeof item.name === "string" && item.name.trim()
        ? item.name.trim().slice(0, 80) : defaultBookmarkName(url).slice(0, 80);
      const savedGroup = cleanGroup(item.category);
      const category = categories.includes(savedGroup) ? savedGroup
        : (categories.includes("Tools") ? "Tools" : categories[0]);
      let id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id || seenIds.has(id)) id = createId();
      seenIds.add(id);
      return {
        id,
        name, url, category,
        note: typeof item.note === "string" ? item.note.slice(0, 120) : "",
        createdAt: Number(item.createdAt) || 0
      };
    }).filter(Boolean);

    refreshCategories();
    orderedGroupNames();

    // Remember what storage actually holds; persist() then repairs only real differences.
    lastSaved = {};
    for (const key of STORAGE_KEYS) if (data[key] !== undefined) lastSaved[key] = JSON.stringify(data[key]);
    return { changed: before !== stateSignature() };
  }

  // What the launchpad grid is drawn from; other changes (wallpaper, theme) need no rebuild.
  function gridSignature() {
    try { return JSON.stringify([state.bookmarks, state.customCategories, defaultCategories, state.groupOrder, state.hiddenCategories, state.layoutLocked, state.iconLookup]); }
    catch { return String(Date.now()); }
  }
  function refreshOpenSettings() {
    if (!$("#settings-modal").open) return;
    renderManageCategories();
    renderHealthAuditUI();
    updateAccentPickerUI();
    $("#icon-size").value = state.iconSize || 48;
    $("#icon-size-label").textContent = `${state.iconSize || 48} px`;
    $("#layout-lock-toggle").checked = !!state.layoutLocked;
    $("#icon-lookup-toggle").checked = !!state.iconLookup;
    void renderWallpaperSettings();
    renderBackupSettings();
  }
  async function syncFromStorage(reason = "manual") {
    if (!isInitialized) { storageSyncPending = true; return; }
    // Rebuilding the grid mid-drag would remove the dragged tile, so wait for the drop.
    if (storageSyncRunning || activeDrag) { storageSyncPending = true; return; }

    storageSyncRunning = true;
    try {
      const data = await storageGet(STORAGE_KEYS);
      if (pendingStorageWrites > 0 || activeDrag) {
        storageSyncPending = true;
        return;
      }
      // Open dialogs are synced too: their next save must start from what other tabs saved.
      const gridBefore = gridSignature();
      const result = applyStoredData(data);
      storageLoaded = true;
      storageRetries = 0;
      if (result.changed) {
        applyPreferences();
        if (gridSignature() !== gridBefore) renderAll();
        void applyWallpaper();
        scheduleWallpaperTimer();
        refreshOpenSettings();
      }
      await persist();
    } catch (err) {
      // Do not blank the working page when transient storage reads fail.
      console.error(`Sutra storage sync failed (${reason}):`, err);
      if (!storageLoaded) {
        const delay = Math.min(30000, 1000 * 2 ** storageRetries++);
        setTimeout(() => scheduleStorageSync("retry-load"), delay);
      }
    } finally {
      storageSyncRunning = false;
      if (storageSyncPending && pendingStorageWrites === 0 && !activeDrag) {
        storageSyncPending = false;
        scheduleStorageSync("queued");
      }
    }
  }
  function scheduleStorageSync(reason = "lifecycle") {
    if (!isInitialized) { storageSyncPending = true; return; }
    clearTimeout(storageSyncTimer);
    storageSyncTimer = setTimeout(() => { void syncFromStorage(reason); }, 120);
  }
  function wireLifecycleSync() {
    // Chrome can restore suspended tabs from BFCache; pageshow reconciles state
    // only if coming from cache or if a previous sync was deferred.
    // Switching tabs does NOT re-render the DOM unless storage was modified externally.
    window.addEventListener("pageshow", e => {
      if (e.persisted) void applyWallpaper();
      if (e.persisted || storageSyncPending) scheduleStorageSync("pageshow");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && storageSyncPending) {
        scheduleStorageSync("visible-pending");
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      // This tab's own writes already match the model, so they need no re-read at all.
      const external = Object.keys(changes).some(key => STORAGE_KEYS.includes(key) && JSON.stringify(changes[key].newValue) !== lastSaved[key]);
      if (external) scheduleStorageSync("storage-change");
    });
  }

  // --- Weather Forecast Widget (IP-based) ---
  const WEATHER_CACHE_KEY = "sutra_weather_cache";
  const WEATHER_UNIT_KEY = "sutra_weather_unit";
  const WEATHER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes cache
  const WEATHER_TIMEOUT_MS = 7000;
  const WMO_CODES = [
    [[2], "Partly cloudy", "⛅"], [[3], "Overcast", "☁️"], [[45, 48], "Fog", "🌫️"],
    [[51, 53, 55], "Drizzle", "🌦️"], [[56, 57], "Freezing drizzle", "🌨️"],
    [[61], "Slight rain", "🌧️"], [[63], "Moderate rain", "🌧️"], [[65], "Heavy rain", "🌧️"],
    [[66, 67], "Freezing rain", "🌨️"], [[71, 73, 75, 77], "Snowfall", "❄️"],
    [[80, 81, 82], "Rain showers", "🌦️"], [[85, 86], "Snow showers", "🌨️"], [[95, 96, 99], "Thunderstorm", "⛈️"]
  ];

  function mapWmoCode(code, isDay = 1) {
    if (code === 0) return isDay ? { text: "Clear sky", icon: "☀️" } : { text: "Clear night", icon: "🌙" };
    if (code === 1) return { text: "Mainly clear", icon: isDay ? "🌤️" : "🌙" };
    const match = WMO_CODES.find(([codes]) => codes.includes(code));
    return match ? { text: match[1], icon: match[2] } : { text: "Fair", icon: isDay ? "☀️" : "🌙" };
  }
  function cToF(c) {
    return Math.round((c * 9) / 5 + 32);
  }
  function formatTemp(tempC, unit) {
    if (tempC === null || tempC === undefined || isNaN(tempC)) return "--°";
    return `${unit === "F" ? cToF(tempC) : Math.round(tempC)}°${unit}`;
  }
  function renderWeatherUI(data, unit = "C") {
    if (!data) return;
    $("#weather-icon").textContent = data.icon || "⛅";
    $("#weather-temp").textContent = formatTemp(data.tempC, unit);
    $("#weather-city").textContent = data.city || "Local";
    $("#weather-widget").title = `${data.city}: ${formatTemp(data.tempC, unit)}, ${data.condition}`;
    $("#weather-popover-condition").textContent = `${data.icon} ${data.condition}`;
    $("#weather-popover-feels").textContent = `Feels like ${formatTemp(data.feelsLikeC, unit)}`;
    $("#weather-popover-range").textContent = `High ${formatTemp(data.maxC, unit)} · Low ${formatTemp(data.minC, unit)}`;
    $("#weather-popover-humidity").textContent = `Humidity ${data.humidity ?? "--"}%`;
    $("#weather-popover-loc").textContent = `${data.city} (IP location)`;
    $("#weather-unit-toggle").textContent = unit === "C" ? "Switch to °F" : "Switch to °C";
  }
  async function toggleWeatherUnit() {
    const stored = await storageGet([WEATHER_UNIT_KEY, WEATHER_CACHE_KEY]);
    const next = (stored[WEATHER_UNIT_KEY] || "C") === "C" ? "F" : "C";
    await storageSet({ [WEATHER_UNIT_KEY]: next });
    renderWeatherUI(stored[WEATHER_CACHE_KEY], next);
  }
  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
  }
  async function fetchIpLocation() {
    const sources = [
      ["https://get.geojs.io/v1/ip/geo.json", d => d.city || d.region || d.country],
      ["https://ipapi.co/json/", d => d.city || d.region || d.country_name]
    ];
    for (const [url, cityOf] of sources) {
      try {
        const d = await fetchJson(url);
        const lat = parseFloat(d.latitude), lon = parseFloat(d.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lon)) return { city: cityOf(d) || "Local", lat, lon };
      } catch {}
    }
    return null;
  }
  async function fetchWttrWeather() {
    const w = await fetchJson("https://wttr.in/?format=j1");
    const cur = w.current_condition?.[0];
    const area = w.nearest_area?.[0];
    if (!cur) throw new Error("Weather response was empty");
    return {
      city: area?.areaName?.[0]?.value || "Local",
      tempC: parseFloat(cur.temp_C),
      feelsLikeC: parseFloat(cur.FeelsLikeC),
      humidity: parseInt(cur.humidity, 10),
      condition: cur.weatherDesc?.[0]?.value || "Fair",
      icon: "⛅",
      maxC: parseFloat(w.weather?.[0]?.maxtempC),
      minC: parseFloat(w.weather?.[0]?.mintempC)
    };
  }
  async function fetchOpenMeteoWeather(loc) {
    const wData = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto`);
    const cur = wData.current || {};
    const daily = wData.daily || {};
    const wmo = mapWmoCode(cur.weather_code ?? 0, cur.is_day ?? 1);
    return {
      city: loc.city,
      tempC: cur.temperature_2m,
      feelsLikeC: cur.apparent_temperature,
      humidity: cur.relative_humidity_2m,
      condition: wmo.text,
      icon: wmo.icon,
      maxC: daily.temperature_2m_max?.[0] ?? cur.temperature_2m,
      minC: daily.temperature_2m_min?.[0] ?? cur.temperature_2m
    };
  }
  async function fetchWeather(forceRefresh = false) {
    let unit = "C";
    let cached = null;
    try {
      const stored = await storageGet([WEATHER_UNIT_KEY, WEATHER_CACHE_KEY]);
      unit = stored[WEATHER_UNIT_KEY] || "C";
      cached = stored[WEATHER_CACHE_KEY] || null;
    } catch {}

    if (cached) renderWeatherUI(cached, unit);
    if (!forceRefresh && cached?.timestamp && Date.now() - cached.timestamp < WEATHER_CACHE_TTL) return;
    if (!cached) $("#weather-city").textContent = "Locating…";

    try {
      const loc = await fetchIpLocation();
      const weather = loc ? await fetchOpenMeteoWeather(loc) : await fetchWttrWeather();
      const weatherData = { ...weather, timestamp: Date.now() };
      await storageSet({ [WEATHER_CACHE_KEY]: weatherData });
      renderWeatherUI(weatherData, unit);
    } catch (err) {
      console.warn("Sutra weather fetch:", err);
      if (!cached) $("#weather-city").textContent = "Unavailable";
      if (forceRefresh) showToast("Could not refresh the weather.");
    }
  }

  async function init() {
    let firstRun = false;
    try {
      const data = await storageGet([...STORAGE_KEYS, ICON_CACHE_KEY]);
      firstRun = data.bookmarks === undefined && data.shortcuts === undefined;
      if (data[ICON_CACHE_KEY] && typeof data[ICON_CACHE_KEY] === "object") iconCache = data[ICON_CACHE_KEY];
      applyStoredData(data);
      storageLoaded = true;
      void persist();
    } catch (err) {
      console.error("Could not initialise Sutra storage:", err);
      storageSyncPending = true;
      showToast("Sutra could not read saved data. Retrying automatically.");
    }

    applyPreferences();
    wireEvents();
    renderAll();
    isInitialized = true;
    void startWallpapers();
    // Network-bound extras wait until the launchpad has painted.
    (window.requestIdleCallback || setTimeout)(() => { void fetchWeather(); void startBackupFolder(); });
    if (firstRun && backupSupported) setTimeout(() => showToast(`Moving from another computer? Settings › Library › Backup folder restores your “${BACKUP_FOLDER_NAME}”.`), 1200);
    if (storageSyncPending) {
      storageSyncPending = false;
      scheduleStorageSync("startup-queued");
    }
  }
  // Unpacked developer copies get live reload; the store package does not ship the file.
  function startDevReload() {
    if ("update_url" in chrome.runtime.getManifest()) return;
    const script = document.createElement("script");
    script.src = "hot-reload.js";
    script.onerror = () => script.remove();
    document.body.appendChild(script);
  }
  // Register listeners synchronously so the first pageshow/focus is not missed
  // while the initial asynchronous Chrome storage read is still pending.
  wireLifecycleSync();
  init();
})();
