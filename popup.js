/**
 * Inspectly — Popup UI Controller v2.1 (popup.js)
 * ─────────────────────────────────────────────────
 * Changes in v2.1:
 *   • State persistence: saves active screen to chrome.storage, restores on open
 *   • IndexedDB table view: column picker, selectable rows, copy selected
 *   • Fixed interception: correct tab messaging and queue polling
 *   • Dashboard: 2-column grid layout (handled via CSS)
 */
"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
let allRequests      = [], filteredRequests = [];
let activeFilter     = "all", searchQuery    = "";
let isRecording      = false, isIntercepting = false;
let timerInterval    = null,  timerSeconds   = 0, autoRefreshTimer = null;
let currentRequest   = null,  currentIntercept = null;
let interceptHistory = [],    liveQueue        = [];
let activeIntTab     = "queue";

// IndexedDB view state
let idbData          = {};       // full parsed IDB data
let idbViewMode      = "json";   // "json" | "table"
let idbSelectedStore = "";       // currently selected store in table view
let idbVisibleCols   = [];       // columns user wants to show
let idbSelectedRows  = new Set();// selected row indices for copy

const $  = id => document.getElementById(id);

// ─── Navigation + State Persistence ─────────────────────────────────────────
const SCREEN_LABELS = {
  requests:"Request Capturing", intercept:"Request Interception",
  cache:"Cache Monitoring", localstorage:"Local Storage",
  sessionstorage:"Session Storage", indexeddb:"IndexedDB"
};

/**
 * Save active screen to chrome.storage.local so it survives popup close/open.
 */
function saveScreenState(viewId) {
  chrome.storage.local.set({ activeScreen: viewId });
}

function showScreen(viewId, skipSave) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  if (viewId === "dashboard") {
    $("screenDashboard").classList.add("active");
    $("backBtn").classList.add("hidden");
    $("headerTagline").textContent = "Developer Toolkit";
  } else {
    const key = viewId.charAt(0).toUpperCase() + viewId.slice(1);
    const el  = $(`screen${key}`);
    if (el) el.classList.add("active");
    $("backBtn").classList.remove("hidden");
    $("headerTagline").textContent = SCREEN_LABELS[viewId] || viewId;
  }
  if (!skipSave) saveScreenState(viewId);
}

// ─── Messaging helpers ────────────────────────────────────────────────────────
function msg(data) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(data, res => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    } catch (_) { resolve(null); }
  });
}

function msgTab(data) {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) return resolve(null);
      chrome.tabs.sendMessage(tabs[0].id, data, res => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    });
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(message, type = "success") {
  const el = $("toast");
  el.textContent = message;
  el.className   = `toast visible ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2800);
}

// ─── Status dots ──────────────────────────────────────────────────────────────
function updateStatusDots() {
  $("recIndicator").classList.toggle("active", isRecording);
  $("intIndicator").classList.toggle("active", isIntercepting);
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function startTimer() {
  timerSeconds = 0; renderTimer();
  timerInterval = setInterval(() => { timerSeconds++; renderTimer(); }, 1000);
}
function stopTimer()   { clearInterval(timerInterval); timerInterval = null; }
function renderTimer() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, "0");
  const s = String(timerSeconds % 60).padStart(2, "0");
  $("timerValue").textContent = `${m}:${s}`;
}
function setRecordingUI(on) {
  isRecording = on;
  $("btnRecord").classList.toggle("hidden", on);
  $("btnStop").classList.toggle("hidden", !on);
  $("timerDisplay").classList.toggle("hidden", !on);
  updateStatusDots();
}
function startAutoRefresh() { stopAutoRefresh(); autoRefreshTimer = setInterval(loadRequests, 1500); }
function stopAutoRefresh()  { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }

// ─── Requests: Load & Render ──────────────────────────────────────────────────
async function loadRequests() {
  const res   = await msg({ type: "GET_REQUESTS" });
  allRequests = (res?.requests || []).reverse();
  applyFilters(); updateStats();
}

function applyFilters() {
  filteredRequests = allRequests.filter(req => {
    const f = (() => {
      if (activeFilter === "all")   return true;
      if (activeFilter === "error") return !req.status || req.status >= 400;
      if (activeFilter === "xhr")   return (req.type || "").toLowerCase().includes("xhr");
      if (activeFilter === "fetch") return (req.type || "").toLowerCase().includes("fetch");
      return true;
    })();
    const s = !searchQuery ||
      (req.url    || "").toLowerCase().includes(searchQuery) ||
      (req.method || "").toLowerCase().includes(searchQuery) ||
      String(req.status || "").includes(searchQuery);
    return f && s;
  });
  renderReqTable();
}

function renderReqTable() {
  const tbody = $("reqBody"), empty = $("reqEmpty");
  if (filteredRequests.length === 0) {
    tbody.innerHTML = ""; empty.style.display = "flex"; return;
  }
  empty.style.display = "none";
  tbody.innerHTML = filteredRequests.map((req, i) => {
    const m   = req.method || "GET";
    const url = truncUrl(req.url || "");
    const dur = req.duration != null ? `${req.duration}ms` : "—";
    return `<tr class="trow" data-i="${i}" title="${esc(req.url || "")}">
      <td><span class="method-badge m-${m.toLowerCase()}">${m}</span></td>
      <td class="url-cell">${esc(url)}</td>
      <td><span class="status-badge ${sCls(req.status)}">${req.status || "—"}</span></td>
      <td class="dim">${esc((req.type || "Other").slice(0, 8))}</td>
      <td class="dim mono">${dur}</td>
      <td class="act-cell">
        <button class="act-btn view-btn" data-i="${i}" title="View details">
          <svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2.5" stroke="currentColor" stroke-width="1.2"/><path d="M1 7s2-5 6-5 6 5 6 5-2 5-6 5-6-5-6-5z" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
        <button class="act-btn rpl-btn" data-i="${i}" title="Replay">
          <svg viewBox="0 0 14 14" fill="none"><path d="M3 2l8 5-8 5V2z" fill="currentColor"/></svg>
        </button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".view-btn").forEach(b =>
    b.addEventListener("click", e => { e.stopPropagation(); openReqModal(filteredRequests[+b.dataset.i]); }));
  tbody.querySelectorAll(".rpl-btn").forEach(b =>
    b.addEventListener("click", e => { e.stopPropagation(); openReqModal(filteredRequests[+b.dataset.i], "replay"); }));
  tbody.querySelectorAll(".trow").forEach(r =>
    r.addEventListener("click", () => openReqModal(filteredRequests[+r.dataset.i])));
}

function updateStats() {
  const total  = allRequests.length;
  const errors = allRequests.filter(r => !r.status || r.status >= 400).length;
  const times  = allRequests.filter(r => r.duration != null).map(r => r.duration);
  const avg    = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  $("sTotal").textContent   = total;
  $("sErrors").textContent  = errors;
  $("sAvg").textContent     = avg != null ? `${avg}ms` : "—";
  $("sSize").textContent    = `${total}/5k`;
  $("reqCount").textContent = filteredRequests.length;
}

// ─── Request Detail Modal ─────────────────────────────────────────────────────
function openReqModal(req, tab = "overview") {
  currentRequest = req;
  $("modalOverlay").classList.add("visible");
  const m = req.method || "GET";
  $("mMethod").textContent = m; $("mMethod").className = `method-badge m-${m.toLowerCase()}`;
  $("mStatus").textContent = req.status || "—"; $("mStatus").className = `status-badge ${sCls(req.status)}`;
  $("mUrl").textContent = req.url || "";
  $("d-url").textContent    = req.url    || "—";
  $("d-method").textContent = req.method || "—";
  $("d-status").textContent = req.status ? `${req.status} ${req.statusText || ""}` : "—";
  $("d-type").textContent   = req.type   || "—";
  $("d-dur").textContent    = req.duration != null ? `${req.duration}ms` : "—";
  $("d-mime").textContent   = req.mimeType || "—";
  $("d-time").textContent   = req.capturedAt ? new Date(req.capturedAt).toLocaleString() : "—";
  $("d-rh").textContent     = fmt(req.requestHeaders);
  $("d-rb").textContent     = pretty(req.requestBody) || "— No payload —";
  $("d-resh").textContent   = fmt(req.responseHeaders);
  $("d-resb").textContent   = pretty(req.responseBody) || "— No body —";
  $("rp-url").value     = req.url    || "";
  $("rp-method").value  = req.method || "GET";
  $("rp-headers").value = fmt(req.requestHeaders);
  $("rp-body").value    = req.requestBody || "";
  $("rpResult").classList.add("hidden");
  $("rpLoading").classList.add("hidden");
  switchReqTab(tab);
}
function closeReqModal() { $("modalOverlay").classList.remove("visible"); currentRequest = null; }
function switchReqTab(tabId) {
  document.querySelectorAll("#detailModal .mtab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabId));
  document.querySelectorAll("#detailModal .tab-panel").forEach(p => p.classList.toggle("active", p.id === `tp-${tabId}`));
}

// ─── Replay ───────────────────────────────────────────────────────────────────
async function handleReplay() {
  const url    = $("rp-url").value.trim();
  const method = $("rp-method").value;
  const hraw   = $("rp-headers").value.trim();
  const body   = $("rp-body").value.trim();
  if (!url) { toast("URL is required", "error"); return; }
  let headers = {};
  try { if (hraw) headers = JSON.parse(hraw); } catch { toast("Invalid JSON in headers", "error"); return; }
  $("rpLoading").classList.remove("hidden"); $("rpResult").classList.add("hidden");
  const res = await msg({ type: "REPLAY_REQUEST", request: { url, method, headers, body } });
  $("rpLoading").classList.add("hidden");
  if (res?.success) {
    const r = res.result;
    $("rpMeta").innerHTML = `<span class="status-badge ${sCls(r.status)}">${r.status} ${r.statusText}</span><span class="replay-time">${r.duration}ms</span>`;
    $("rpBody").textContent = pretty(r.responseBody) || "— Empty —";
    $("rpResult").classList.remove("hidden");
  } else { toast("Replay failed: " + (res?.error || "Unknown"), "error"); }
}

// ─── Interception ─────────────────────────────────────────────────────────────
function setInterceptUI(on) {
  isIntercepting = on;
  $("btnIntEnable").classList.toggle("hidden", on);
  $("btnIntDisable").classList.toggle("hidden", !on);
  $("intLiveBadge").classList.toggle("hidden", !on);
  updateStatusDots();
}

async function loadInterceptData() {
  const res  = await msg({ type: "GET_INTERCEPTED" });
  interceptHistory = (res?.intercepted || []).reverse();
  const qRes = await msg({ type: "GET_QUEUE" });
  liveQueue  = qRes?.queue || [];
  renderInterceptQueue(); renderInterceptHistory();
  $("intQueued").textContent  = liveQueue.length;
  $("intTotal").textContent   = interceptHistory.length;
  $("queueBadge").textContent = liveQueue.length;
  $("histBadge").textContent  = interceptHistory.length;
}

function renderInterceptQueue() {
  const list = $("queueList"), empty = $("queueEmpty");
  if (liveQueue.length === 0) { list.innerHTML = ""; empty.style.display = "flex"; return; }
  empty.style.display = "none";
  list.innerHTML = liveQueue.map(req => `
    <div class="queue-card">
      <div class="queue-card-top">
        <span class="method-badge m-${(req.method || "get").toLowerCase()}">${req.method || "GET"}</span>
        <span class="queue-url mono">${esc(truncUrl(req.url || ""))}</span>
        <span class="queue-time">${new Date(req.pausedAt).toLocaleTimeString()}</span>
      </div>
      <div class="queue-actions">
        <button class="qa-btn qa-forward" data-id="${req.id}">Forward</button>
        <button class="qa-btn qa-edit"    data-id="${req.id}">Modify</button>
        <button class="qa-btn qa-block"   data-id="${req.id}">Block</button>
        <button class="qa-btn qa-dup"     data-id="${req.id}">Duplicate</button>
      </div>
    </div>`).join("");

  list.querySelectorAll(".qa-forward").forEach(b => b.addEventListener("click", async () => {
    const r = await msg({ type: "FORWARD_REQUEST", requestId: b.dataset.id });
    if (r?.success) { toast("Forwarded"); await loadInterceptData(); }
    else toast("Failed: " + (r?.error || ""), "error");
  }));
  list.querySelectorAll(".qa-edit").forEach(b => b.addEventListener("click", () => {
    const req = liveQueue.find(r => r.id === b.dataset.id);
    if (req) openInterceptModal(req);
  }));
  list.querySelectorAll(".qa-block").forEach(b => b.addEventListener("click", async () => {
    const r = await msg({ type: "BLOCK_REQUEST", requestId: b.dataset.id });
    if (r?.success) { toast("Request blocked", "error"); await loadInterceptData(); }
    else toast("Failed: " + (r?.error || ""), "error");
  }));
  list.querySelectorAll(".qa-dup").forEach(b => b.addEventListener("click", async () => {
    const r = await msg({ type: "DUPLICATE_REQUEST", requestId: b.dataset.id });
    if (r?.success) { toast("Duplicated & forwarded"); await loadInterceptData(); }
    else toast("Failed: " + (r?.error || ""), "error");
  }));
}

function renderInterceptHistory() {
  const list = $("histList"), empty = $("histEmpty");
  if (interceptHistory.length === 0) { list.innerHTML = ""; empty.style.display = "flex"; return; }
  empty.style.display = "none";
  const stMap = { paused:"s-pause", forwarded:"s-ok", modified:"s-modified", blocked:"s-err", duplicated:"s-dup" };
  list.innerHTML = interceptHistory.map(req => `
    <div class="hist-card">
      <div class="hist-row">
        <span class="method-badge m-${(req.method || "get").toLowerCase()}">${req.method || "GET"}</span>
        <span class="status-badge ${stMap[req.status] || "s-unknown"}">${req.status || "—"}</span>
        <span class="hist-url mono">${esc(truncUrl(req.url || ""))}</span>
        <span class="hist-time">${new Date(req.pausedAt).toLocaleTimeString()}</span>
      </div>
      ${req.modifications ? `<div class="hist-modified-note">Modified: ${Object.keys(req.modifications).join(", ")}</div>` : ""}
    </div>`).join("");
}

// ─── Intercept Edit Modal ─────────────────────────────────────────────────────
function openInterceptModal(req) {
  currentIntercept = req;
  $("interceptOverlay").classList.add("visible");
  const m = req.method || "GET";
  $("imMethod").textContent = m; $("imMethod").className = `method-badge m-${m.toLowerCase()}`;
  $("imUrl").textContent    = req.url || "";
  $("im-url").textContent   = req.url    || "—";
  $("im-method").textContent= req.method || "—";
  $("im-type").textContent  = req.type   || "—";
  $("im-time").textContent  = req.pausedAt ? new Date(req.pausedAt).toLocaleString() : "—";
  $("im-orig-headers").textContent = fmt(req.requestHeaders);
  $("im-orig-body").textContent    = pretty(req.requestBody) || "— No payload —";
  $("edit-url").value    = req.url    || "";
  $("edit-method").value = req.method || "GET";
  buildParamEditor(req.url);
  $("edit-headers").value = fmt(req.requestHeaders);
  const ct = ((req.requestHeaders || {})["content-type"] || "").split(";")[0].trim();
  $("edit-content-type").value = ct || "";
  $("edit-body").value = pretty(req.requestBody) || "";
  $("interceptResponse").classList.add("hidden");
  switchIntTab("edit-overview");
}
function closeInterceptModal() { $("interceptOverlay").classList.remove("visible"); currentIntercept = null; }
function switchIntTab(tabId) {
  document.querySelectorAll("#interceptModal .mtab").forEach(t => t.classList.toggle("active", t.dataset.itab === tabId));
  document.querySelectorAll("#interceptModal .tab-panel").forEach(p => p.classList.toggle("active", p.id === `itp-${tabId}`));
}
function buildParamEditor(url) {
  const c = $("queryParamEditor"); c.innerHTML = "";
  try {
    const u = new URL(url), params = [...u.searchParams.entries()];
    if (params.length === 0) { c.innerHTML = `<p class="hint-text">No query params in URL.</p>`; return; }
    params.forEach(([k, v]) => {
      const row = document.createElement("div"); row.className = "param-row";
      row.innerHTML = `<input class="form-input param-key" value="${esc(k)}" placeholder="key"/><input class="form-input param-val" value="${esc(v)}" placeholder="value"/><button class="act-btn remove-param">×</button>`;
      row.querySelector(".remove-param").addEventListener("click", () => row.remove());
      c.appendChild(row);
    });
  } catch (_) { c.innerHTML = `<p class="hint-text">Enter a valid URL to parse params.</p>`; }
}
function syncParamsToUrl() {
  try {
    const url = new URL($("edit-url").value); url.search = "";
    $("queryParamEditor").querySelectorAll(".param-row").forEach(row => {
      const k = row.querySelector(".param-key").value.trim(), v = row.querySelector(".param-val").value;
      if (k) url.searchParams.append(k, v);
    });
    $("edit-url").value = url.toString();
  } catch (_) {}
}
function getModifications() {
  syncParamsToUrl();
  let headers = {};
  try { headers = JSON.parse($("edit-headers").value || "{}"); } catch (_) {}
  const ct = $("edit-content-type").value;
  if (ct && !headers["content-type"]) headers["content-type"] = ct;
  return { url: $("edit-url").value.trim(), method: $("edit-method").value, headers, body: $("edit-body").value };
}

// ─── Storage Views ─────────────────────────────────────────────────────────────
function renderKV(data, elId) {
  const el = $(elId), entries = Object.entries(data);
  if (entries.length === 0) {
    el.innerHTML = `<div class="empty-state"><p class="es-title">No data</p><p class="es-sub">Storage is empty for this page.</p></div>`; return;
  }
  el.innerHTML = `
    <div class="storage-count">${entries.length} key${entries.length !== 1 ? "s" : ""}</div>
    <div class="kv-table">
      <div class="kv-thead"><span>Key</span><span>Value</span></div>
      ${entries.map(([k, v]) => `
        <div class="kv-trow">
          <span class="kv-key-cell mono" title="${esc(k)}">${esc(k)}</span>
          <span class="kv-val-cell mono" title="${esc(v)}">${esc(trunc(v, 120))}</span>
        </div>`).join("")}
    </div>`;
}

function renderCache(data, elId) {
  const el = $(elId), caches = Object.entries(data);
  if (caches.length === 0) {
    el.innerHTML = `<div class="empty-state"><p class="es-title">No caches</p><p class="es-sub">No Service Worker caches for this origin.</p></div>`; return;
  }
  el.innerHTML = `<div class="storage-count">${caches.length} cache${caches.length !== 1 ? "s" : ""}</div>` +
    caches.map(([name, entries]) => `
      <details class="store-grp" open>
        <summary class="store-sum">
          <svg viewBox="0 0 10 10" fill="none"><path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="store-nm">${esc(name)}</span><span class="store-ct">${entries.length} entries</span>
        </summary>
        <div class="store-entries">
          ${entries.length === 0 ? `<div class="store-empty">Empty</div>` :
            entries.map(e => `<div class="cache-entry"><span class="method-badge m-${(e.method || "get").toLowerCase()}">${e.method || "GET"}</span><span class="cache-url mono">${esc(trunc(e.url, 80))}</span></div>`).join("")}
        </div>
      </details>`).join("");
}

// ─── IndexedDB: JSON + Table view ─────────────────────────────────────────────
function renderIDB(data) {
  idbData = data;
  if (idbViewMode === "json") renderIDBJson(data);
  else renderIDBTableMode(data);
}

function renderIDBJson(data) {
  const el = $("idbContent"), dbs = Object.entries(data);
  $("idbTableControls").classList.add("hidden");
  if (dbs.length === 0) {
    el.innerHTML = `<div class="empty-state"><p class="es-title">No IndexedDB databases</p><p class="es-sub">None found for this origin.</p></div>`; return;
  }
  el.innerHTML = dbs.map(([dbName, dbInfo]) => `
    <details class="store-grp" open>
      <summary class="store-sum">
        <svg viewBox="0 0 10 10" fill="none"><path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="store-nm">${esc(dbName)}</span><span class="store-ct">v${dbInfo.version} · ${Object.keys(dbInfo.stores).length} stores</span>
      </summary>
      <div class="store-entries">
        ${Object.entries(dbInfo.stores).map(([sn, records]) => `
          <details class="sub-store">
            <summary class="sub-sum"><span>${esc(sn)}</span><span class="store-ct">${records.length} records</span></summary>
            <div class="idb-records">
              ${records.length === 0 ? `<div class="store-empty">No records</div>` :
                records.map(r => `<pre class="idb-rec">${esc(JSON.stringify(r, null, 2))}</pre>`).join("")}
            </div>
          </details>`).join("")}
      </div>
    </details>`).join("");
}

/**
 * TABLE VIEW — renders a proper database-style table for a selected store.
 * Features: column picker checkboxes, selectable rows, copy selected rows.
 */
function renderIDBTableMode(data) {
  const el = $("idbContent");
  $("idbTableControls").classList.remove("hidden");

  // Populate store selector dropdown
  const sel = $("idbStoreSelect");
  const prevVal = sel.value;
  sel.innerHTML = `<option value="">— Select a store —</option>`;
  Object.entries(data).forEach(([dbName, dbInfo]) => {
    Object.keys(dbInfo.stores).forEach(storeName => {
      const opt = document.createElement("option");
      opt.value = `${dbName}::${storeName}`;
      opt.textContent = `${dbName} → ${storeName}`;
      sel.appendChild(opt);
    });
  });
  // Restore previous selection if still valid
  if (prevVal && [...sel.options].some(o => o.value === prevVal)) {
    sel.value = prevVal;
    idbSelectedStore = prevVal;
  }

  if (!idbSelectedStore) {
    el.innerHTML = `<div class="empty-state"><p class="es-title">Select a store above</p><p class="es-sub">Choose a database → object store to view records in table format.</p></div>`;
    $("idbColPicker").innerHTML = "";
    return;
  }

  // Parse db/store from combined key
  const [dbName, storeName] = idbSelectedStore.split("::");
  const records = data[dbName]?.stores[storeName] || [];

  if (records.length === 0) {
    el.innerHTML = `<div class="empty-state"><p class="es-title">No records</p><p class="es-sub">This store is empty.</p></div>`;
    $("idbColPicker").innerHTML = "";
    return;
  }

  // Collect all unique keys across all records as columns
  const allCols = [...new Set(records.flatMap(r => typeof r === "object" && r !== null ? Object.keys(r) : []))];
  if (allCols.length === 0) {
    // Primitive values
    renderIDBPrimitiveTable(records, el);
    return;
  }

  // Default: show all cols if not set
  if (idbVisibleCols.length === 0) idbVisibleCols = [...allCols];

  // Build column picker
  const picker = $("idbColPicker");
  picker.innerHTML = allCols.map(col => `
    <label class="col-check" title="Toggle column: ${esc(col)}">
      <input type="checkbox" class="col-chk" value="${esc(col)}" ${idbVisibleCols.includes(col) ? "checked" : ""}/>
      <span>${esc(col)}</span>
    </label>`).join("");
  picker.querySelectorAll(".col-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      const col = chk.value;
      if (chk.checked) { if (!idbVisibleCols.includes(col)) idbVisibleCols.push(col); }
      else { idbVisibleCols = idbVisibleCols.filter(c => c !== col); }
      renderIDBTable(records, allCols, el);
    });
  });

  renderIDBTable(records, allCols, el);
}

function renderIDBPrimitiveTable(records, el) {
  el.innerHTML = `
    <div class="idb-table-wrap">
      <div class="idb-copy-bar">
        <button class="btn btn-ghost btn-sm" id="idbSelectAll">Select All</button>
        <button class="btn btn-ghost btn-sm" id="idbCopySelected">Copy Selected</button>
        <span class="idb-selected-count" id="idbSelCount">0 selected</span>
      </div>
      <table class="idb-db-table">
        <thead><tr><th class="idb-check-th"><input type="checkbox" id="idbCheckAll"/></th><th>#</th><th>Value</th></tr></thead>
        <tbody>
          ${records.map((r, i) => `
            <tr class="idb-db-row" data-i="${i}">
              <td class="idb-check-td"><input type="checkbox" class="idb-row-chk" data-i="${i}"/></td>
              <td class="idb-idx">${i + 1}</td>
              <td class="idb-cell mono">${esc(JSON.stringify(r))}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  bindIDBTableEvents(records.map(r => ({ value: r })));
}

function renderIDBTable(records, allCols, el) {
  const cols = allCols.filter(c => idbVisibleCols.includes(c));
  if (cols.length === 0) {
    el.innerHTML = `<div class="empty-state"><p class="es-title">No columns selected</p><p class="es-sub">Check at least one column above.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="idb-table-wrap">
      <div class="idb-copy-bar">
        <button class="btn btn-ghost btn-sm" id="idbSelectAll">Select All</button>
        <button class="btn btn-ghost btn-sm" id="idbCopySelected">Copy Selected</button>
        <span class="idb-selected-count" id="idbSelCount">0 selected</span>
      </div>
      <table class="idb-db-table">
        <thead><tr>
          <th class="idb-check-th"><input type="checkbox" id="idbCheckAll"/></th>
          <th class="idb-idx-th">#</th>
          ${cols.map(c => `<th class="idb-col-th" title="${esc(c)}">${esc(c)}</th>`).join("")}
        </tr></thead>
        <tbody>
          ${records.map((r, i) => {
            const row = typeof r === "object" && r !== null ? r : {};
            return `<tr class="idb-db-row ${idbSelectedRows.has(i) ? "idb-row-selected" : ""}" data-i="${i}">
              <td class="idb-check-td"><input type="checkbox" class="idb-row-chk" data-i="${i}" ${idbSelectedRows.has(i) ? "checked" : ""}/></td>
              <td class="idb-idx">${i + 1}</td>
              ${cols.map(c => `<td class="idb-cell" title="${esc(JSON.stringify(row[c] ?? ""))}">${esc(trunc(JSON.stringify(row[c] ?? ""), 60))}</td>`).join("")}
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
  bindIDBTableEvents(records);
}

function bindIDBTableEvents(records) {
  // Per-row checkbox
  document.querySelectorAll(".idb-row-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      const i = +chk.dataset.i;
      if (chk.checked) idbSelectedRows.add(i); else idbSelectedRows.delete(i);
      updateIDBSelCount();
      chk.closest("tr").classList.toggle("idb-row-selected", chk.checked);
      syncCheckAll();
    });
  });
  // Row click to select
  document.querySelectorAll(".idb-db-row").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.type === "checkbox") return; // let checkbox handle
      const i = +row.dataset.i;
      const chk = row.querySelector(".idb-row-chk");
      chk.checked = !chk.checked;
      if (chk.checked) idbSelectedRows.add(i); else idbSelectedRows.delete(i);
      row.classList.toggle("idb-row-selected", chk.checked);
      updateIDBSelCount(); syncCheckAll();
    });
  });
  // Select all checkbox
  const checkAll = $("idbCheckAll");
  if (checkAll) {
    checkAll.addEventListener("change", () => {
      document.querySelectorAll(".idb-row-chk").forEach((chk, i) => {
        chk.checked = checkAll.checked;
        if (checkAll.checked) idbSelectedRows.add(+chk.dataset.i); else idbSelectedRows.delete(+chk.dataset.i);
        chk.closest("tr").classList.toggle("idb-row-selected", checkAll.checked);
      });
      updateIDBSelCount();
    });
  }
  // Select All button
  const selAllBtn = $("idbSelectAll");
  if (selAllBtn) selAllBtn.addEventListener("click", () => {
    document.querySelectorAll(".idb-row-chk").forEach(chk => {
      chk.checked = true;
      idbSelectedRows.add(+chk.dataset.i);
      chk.closest("tr").classList.add("idb-row-selected");
    });
    if ($("idbCheckAll")) $("idbCheckAll").checked = true;
    updateIDBSelCount();
  });
  // Copy Selected button
  const copyBtn = $("idbCopySelected");
  if (copyBtn) copyBtn.addEventListener("click", () => {
    if (idbSelectedRows.size === 0) { toast("No rows selected", "error"); return; }
    const selectedData = [...idbSelectedRows].sort((a,b)=>a-b).map(i => records[i]);
    const text = JSON.stringify(selectedData, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      toast(`Copied ${idbSelectedRows.size} row${idbSelectedRows.size !== 1 ? "s" : ""} to clipboard`);
    }).catch(() => toast("Copy failed", "error"));
  });
  updateIDBSelCount();
}

function updateIDBSelCount() {
  const el = $("idbSelCount");
  if (el) el.textContent = `${idbSelectedRows.size} selected`;
}
function syncCheckAll() {
  const checkAll = $("idbCheckAll");
  if (!checkAll) return;
  const all  = document.querySelectorAll(".idb-row-chk");
  const checked = document.querySelectorAll(".idb-row-chk:checked");
  checkAll.checked       = checked.length === all.length && all.length > 0;
  checkAll.indeterminate = checked.length > 0 && checked.length < all.length;
}

// ─── Storage loaders ─────────────────────────────────────────────────────────
const loadHtml  = () => `<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>`;
function errHtml(id, err) {
  $(id).innerHTML = `<div class="empty-state"><p class="es-title">Unavailable</p><p class="es-sub">${esc(err || "Not accessible on this page.")}</p></div>`;
}
async function loadCache() {
  $("cacheContent").innerHTML = loadHtml();
  const r = await msgTab({ type: "GET_CACHE_STORAGE" });
  r?.success ? renderCache(r.data, "cacheContent") : errHtml("cacheContent", r?.error);
}
async function loadLS() {
  $("lsContent").innerHTML = loadHtml();
  const r = await msgTab({ type: "GET_LOCAL_STORAGE" });
  r?.success ? renderKV(r.data, "lsContent") : errHtml("lsContent", r?.error);
}
async function loadSS() {
  $("ssContent").innerHTML = loadHtml();
  const r = await msgTab({ type: "GET_SESSION_STORAGE" });
  r?.success ? renderKV(r.data, "ssContent") : errHtml("ssContent", r?.error);
}
async function loadIDB() {
  $("idbContent").innerHTML = loadHtml();
  const r = await msgTab({ type: "GET_INDEXEDDB" });
  if (r?.success) renderIDB(r.data);
  else errHtml("idbContent", r?.error);
}

// ─── Background push messages ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "REQUEST_PAUSED":
      liveQueue.push(message.request);
      renderInterceptQueue();
      $("intQueued").textContent = $("queueBadge").textContent = liveQueue.length;
      $("intIndicator").classList.add("flash");
      setTimeout(() => $("intIndicator").classList.remove("flash"), 600);
      break;
    case "REQUEST_FORWARDED":
    case "REQUEST_MODIFIED":
    case "REQUEST_BLOCKED":
      loadInterceptData();
      break;
  }
});

// ─── Event Binding ────────────────────────────────────────────────────────────
function bindEvents() {
  // Dashboard cards
  document.querySelectorAll(".feature-card[data-view]").forEach(card => {
    card.addEventListener("click", () => {
      const v = card.dataset.view; showScreen(v);
      if (v === "requests")       loadRequests();
      if (v === "intercept")      loadInterceptData();
      if (v === "cache")          loadCache();
      if (v === "localstorage")   loadLS();
      if (v === "sessionstorage") loadSS();
      if (v === "indexeddb")      { idbSelectedRows.clear(); loadIDB(); }
    });
  });

  $("backBtn").addEventListener("click", () => {
    stopAutoRefresh(); showScreen("dashboard");
  });

  // Record / Stop
  $("btnRecord").addEventListener("click", async () => {
    const r = await msg({ type: "START_RECORDING" });
    if (r?.success) { setRecordingUI(true); startTimer(); startAutoRefresh(); toast("Recording started"); }
    else toast("Failed to start recording", "error");
  });
  $("btnStop").addEventListener("click", async () => {
    await msg({ type: "STOP_RECORDING" });
    setRecordingUI(false); stopTimer(); stopAutoRefresh(); await loadRequests(); toast("Recording stopped");
  });

  // Request filters
  $("reqSearch").addEventListener("input", e => { searchQuery = e.target.value.toLowerCase(); applyFilters(); });
  document.querySelectorAll(".pill").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active"); activeFilter = btn.dataset.filter; applyFilters();
    });
  });

  // Toolbar
  $("btnReqRefresh").addEventListener("click", loadRequests);
  $("btnReqClear").addEventListener("click", async () => {
    if (!confirm("Clear all captured requests?")) return;
    await msg({ type: "CLEAR_REQUESTS" }); allRequests = filteredRequests = [];
    renderReqTable(); updateStats(); toast("Cleared");
  });
  $("btnReqExport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(filteredRequests, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob), download: `inspectly-${Date.now()}.json`
    });
    a.click(); URL.revokeObjectURL(a.href);
    toast(`Exported ${filteredRequests.length} requests`);
  });

  // Interception
  $("btnIntEnable").addEventListener("click", async () => {
    const pattern = $("intPattern").value.trim();
    const r = await msg({ type: "START_INTERCEPTING", patterns: pattern ? [pattern] : [] });
    if (r?.success) { setInterceptUI(true); toast("Interception active"); }
    else toast("Failed to start interception", "error");
  });
  $("btnIntDisable").addEventListener("click", async () => {
    await msg({ type: "STOP_INTERCEPTING" });
    setInterceptUI(false); toast("Interception stopped"); await loadInterceptData();
  });
  $("btnIntRefresh").addEventListener("click", loadInterceptData);
  $("btnIntClear").addEventListener("click", async () => {
    if (!confirm("Clear interception history?")) return;
    await msg({ type: "CLEAR_INTERCEPTED" }); interceptHistory = []; renderInterceptHistory(); toast("Cleared");
  });
  document.querySelectorAll(".int-tab").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".int-tab").forEach(x => x.classList.remove("active"));
      document.querySelectorAll(".int-panel").forEach(x => x.classList.remove("active"));
      t.classList.add("active"); activeIntTab = t.dataset.itab;
      $(activeIntTab === "queue" ? "intPanelQueue" : "intPanelHistory").classList.add("active");
    });
  });

  // Request modal
  $("modalClose").addEventListener("click", closeReqModal);
  $("modalOverlay").addEventListener("click", e => { if (e.target === $("modalOverlay")) closeReqModal(); });
  document.querySelectorAll("#detailModal .mtab").forEach(t =>
    t.addEventListener("click", () => switchReqTab(t.dataset.tab)));
  $("btnReplay").addEventListener("click", handleReplay);

  // Intercept modal
  $("interceptClose").addEventListener("click", closeInterceptModal);
  $("interceptOverlay").addEventListener("click", e => { if (e.target === $("interceptOverlay")) closeInterceptModal(); });
  document.querySelectorAll("#interceptModal .mtab").forEach(t =>
    t.addEventListener("click", () => switchIntTab(t.dataset.itab)));
  $("iaForward").addEventListener("click", async () => {
    if (!currentIntercept) return;
    const r = await msg({ type: "FORWARD_REQUEST", requestId: currentIntercept.id });
    if (r?.success) { toast("Forwarded"); closeInterceptModal(); loadInterceptData(); }
    else toast("Failed: " + (r?.error || ""), "error");
  });
  $("iaModify").addEventListener("click", async () => {
    if (!currentIntercept) return;
    const mods = getModifications();
    const r = await msg({ type: "MODIFY_AND_SEND", requestId: currentIntercept.id, modifications: mods });
    if (r?.success) { toast("Modified & sent"); closeInterceptModal(); loadInterceptData(); }
    else toast("Failed: " + (r?.error || ""), "error");
  });
  $("iaBlock").addEventListener("click", async () => {
    if (!currentIntercept || !confirm("Block (drop) this request?")) return;
    const r = await msg({ type: "BLOCK_REQUEST", requestId: currentIntercept.id });
    if (r?.success) { toast("Blocked", "error"); closeInterceptModal(); loadInterceptData(); }
    else toast("Failed: " + (r?.error || ""), "error");
  });
  $("iaDuplicate").addEventListener("click", async () => {
    if (!currentIntercept) return;
    const r = await msg({ type: "DUPLICATE_REQUEST", requestId: currentIntercept.id });
    if (r?.success) { toast("Duplicated & forwarded"); closeInterceptModal(); loadInterceptData(); }
    else toast("Failed: " + (r?.error || ""), "error");
  });
  $("btnAddParam").addEventListener("click", () => {
    const row = document.createElement("div"); row.className = "param-row";
    row.innerHTML = `<input class="form-input param-key" placeholder="key"/><input class="form-input param-val" placeholder="value"/><button class="act-btn remove-param">×</button>`;
    row.querySelector(".remove-param").addEventListener("click", () => row.remove());
    $("queryParamEditor").appendChild(row);
  });
  $("btnPrettyBody").addEventListener("click", () => {
    try { $("edit-body").value = JSON.stringify(JSON.parse($("edit-body").value), null, 2); }
    catch (_) { toast("Not valid JSON", "error"); }
  });

  // Storage refreshes
  $("btnCacheRefresh").addEventListener("click", loadCache);
  $("btnLsRefresh").addEventListener("click",    loadLS);
  $("btnSsRefresh").addEventListener("click",    loadSS);
  $("btnIdbRefresh").addEventListener("click",   loadIDB);

  // IndexedDB view toggle (JSON ↔ Table)
  $("btnIdbViewToggle").addEventListener("click", () => {
    idbViewMode = idbViewMode === "json" ? "table" : "json";
    idbSelectedRows.clear();
    idbVisibleCols = [];
    // Update button label and icon
    const icon = $("idbViewIcon");
    if (idbViewMode === "table") {
      $("btnIdbViewToggle").innerHTML = `<svg viewBox="0 0 16 16" fill="none" id="idbViewIcon"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> JSON View`;
    } else {
      $("btnIdbViewToggle").innerHTML = `<svg viewBox="0 0 16 16" fill="none" id="idbViewIcon"><rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M1 5h14M1 9h14M1 13h14M5 1v14M11 1v14" stroke="currentColor" stroke-width="1.1"/></svg> Table View`;
    }
    // Re-render with current data
    if (Object.keys(idbData).length > 0) renderIDB(idbData);
    else loadIDB();
  });

  // Store selector change
  $("idbStoreSelect").addEventListener("change", () => {
    idbSelectedStore = $("idbStoreSelect").value;
    idbSelectedRows.clear();
    idbVisibleCols = [];
    renderIDBTableMode(idbData);
  });

  // ESC closes modals
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeReqModal(); closeInterceptModal(); }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sCls(s) { if (!s) return "s-unknown"; if (s < 300) return "s-ok"; if (s < 400) return "s-redir"; if (s < 500) return "s-err"; return "s-srv"; }
function truncUrl(url) { try { const u = new URL(url), p = u.pathname + u.search; return p.length > 50 ? p.slice(0, 50) + "…" : p; } catch { return url.length > 54 ? url.slice(0, 54) + "…" : url; } }
function trunc(s, max)  { return s && s.length > max ? s.slice(0, max) + "…" : (s || ""); }
function esc(s)         { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmt(v)         { if (!v) return "—"; if (typeof v === "string") return v; return JSON.stringify(v, null, 2); }
function pretty(s)      { if (!s) return null; try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } }

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Restore recording/interception state
  const status = await msg({ type: "GET_STATUS" });
  if (status?.isRecording)    { isRecording = true;    setRecordingUI(true);  startTimer(); startAutoRefresh(); }
  if (status?.isIntercepting) { isIntercepting = true; setInterceptUI(true); }

  bindEvents();

  // Restore last active screen from storage
  chrome.storage.local.get(["activeScreen"], ({ activeScreen }) => {
    const view = activeScreen || "dashboard";
    showScreen(view, true); // true = don't re-save immediately

    // Load data for the restored screen
    if (view === "requests")       loadRequests();
    if (view === "intercept")      loadInterceptData();
    if (view === "cache")          loadCache();
    if (view === "localstorage")   loadLS();
    if (view === "sessionstorage") loadSS();
    if (view === "indexeddb")      loadIDB();
  });
}

init();
