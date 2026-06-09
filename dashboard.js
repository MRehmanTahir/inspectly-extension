/**
 * Inspectly — Dashboard Controller v3.0 (dashboard.js)
 * ──────────────────────────────────────────────────────
 * Full professional workspace: live metrics, waterfall,
 * analytics charts, intercept panel, storage inspector,
 * request detail side panel with replay.
 */
"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
let allRequests      = [];
let filteredRequests = [];
let activeFilter     = "all";
let searchQuery      = "";
let isRecording      = false;
let isIntercepting   = false;
let timerInterval    = null;
let timerSeconds     = 0;
let autoRefresh      = null;
let currentStats     = {};
let liveQueue        = [];
let interceptHistory = [];
let currentIntercept = null;
let activeView       = "overview";
let activeStorTab    = "ls";
let activeIntTab     = "queue";
let idbData          = {};
let selectedRequest  = null;

const $ = id => document.getElementById(id);

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("inspectly-dash-theme", t);
}
applyTheme(localStorage.getItem("inspectly-dash-theme") || "dark");
$("themeToggleBtn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
});

// ─── Sidebar collapse ─────────────────────────────────────────────────────────
$("sidebarToggle").addEventListener("click", () => {
  $("sidebar").classList.toggle("collapsed");
});

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
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      // Filter out extension pages
      const tab = tabs.find(t => t.url && !t.url.startsWith("chrome-extension://") && !t.url.startsWith("chrome://"));
      if (!tab) return resolve(null);
      chrome.tabs.sendMessage(tab.id, data, res => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    });
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(message, type = "success") {
  const el = $("dbToast");
  el.textContent = message;
  el.className   = `toast visible ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2800);
}

// ─── Navigation ───────────────────────────────────────────────────────────────
const VIEW_TITLES = {
  overview: "Overview", requests: "Request Monitor", waterfall: "Waterfall",
  analytics: "Analytics", intercept: "Interception", storage: "Storage Inspector"
};

function switchView(viewId) {
  document.querySelectorAll(".sb-item[data-view]").forEach(i =>
    i.classList.toggle("active", i.dataset.view === viewId));
  document.querySelectorAll(".dash-view").forEach(v =>
    v.classList.toggle("active", v.id === `view-${viewId}`));
  $("viewTitle").textContent = VIEW_TITLES[viewId] || viewId;
  activeView = viewId;

  if (viewId === "overview")   updateOverview();
  if (viewId === "requests")   renderReqTable();
  if (viewId === "waterfall")  renderWaterfall();
  if (viewId === "analytics")  renderAnalytics();
  if (viewId === "intercept")  loadInterceptData();
  if (viewId === "storage")    loadStorageTab(activeStorTab);
}

document.querySelectorAll(".sb-item[data-view]").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// ─── Recording ────────────────────────────────────────────────────────────────
function setRecordingUI(on) {
  isRecording = on;
  $("dbBtnRecord").classList.toggle("hidden", on);
  $("dbBtnStop").classList.toggle("hidden", !on);
  $("dbTimer").classList.toggle("hidden", !on);
  $("dbLiveBadge").classList.toggle("hidden", !on);
}

function startTimer() {
  timerSeconds = 0; renderTimer();
  timerInterval = setInterval(() => { timerSeconds++; renderTimer(); }, 1000);
}
function stopTimer() { clearInterval(timerInterval); timerInterval = null; }
function renderTimer() {
  const h = String(Math.floor(timerSeconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((timerSeconds % 3600) / 60)).padStart(2, "0");
  const s = String(timerSeconds % 60).padStart(2, "0");
  $("dbTimerVal").textContent = `${h}:${m}:${s}`;
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefresh = setInterval(async () => {
    await loadRequests();
    if (activeView === "overview")  updateOverview();
    if (activeView === "waterfall") renderWaterfall();
    if (activeView === "analytics") renderAnalytics();
  }, 1500);
}
function stopAutoRefresh() { clearInterval(autoRefresh); autoRefresh = null; }

$("dbBtnRecord").addEventListener("click", async () => {
  const r = await msg({ type: "START_RECORDING" });
  if (r?.success) { setRecordingUI(true); startTimer(); startAutoRefresh(); toast("Recording started"); }
  else toast("Failed to start recording", "error");
});
$("dbBtnStop").addEventListener("click", async () => {
  await msg({ type: "STOP_RECORDING" });
  setRecordingUI(false); stopTimer(); stopAutoRefresh();
  await loadRequests(); updateOverview(); toast("Recording stopped");
});
$("dbBtnClear").addEventListener("click", async () => {
  if (!confirm("Clear all captured requests?")) return;
  await msg({ type: "CLEAR_REQUESTS" });
  allRequests = filteredRequests = [];
  updateOverview(); renderReqTable(); renderWaterfall(); renderAnalytics();
  toast("Cleared");
});
$("dbBtnExport").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(allRequests, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: `inspectly-${Date.now()}.json`
  });
  a.click(); URL.revokeObjectURL(a.href);
  toast(`Exported ${allRequests.length} requests`);
});

// ─── Load Requests ────────────────────────────────────────────────────────────
async function loadRequests() {
  const res = await msg({ type: "GET_REQUESTS" });
  allRequests = (res?.requests || []).reverse();
  applyFilters();
}

function applyFilters() {
  filteredRequests = allRequests.filter(req => {
    const f = (() => {
      if (activeFilter === "all")   return true;
      if (activeFilter === "error") return !req.status || req.status >= 400;
      if (activeFilter === "xhr")   return (req.type || "").toLowerCase().includes("xhr");
      if (activeFilter === "fetch") return (req.type || "").toLowerCase().includes("fetch");
      if (activeFilter === "slow")  return req.duration != null && req.duration >= 2000;
      return true;
    })();
    const s = !searchQuery ||
      (req.url    || "").toLowerCase().includes(searchQuery) ||
      (req.method || "").toLowerCase().includes(searchQuery) ||
      String(req.status || "").includes(searchQuery);
    return f && s;
  });
  if (activeView === "requests") renderReqTable();
}

// ─── Overview: Metrics ────────────────────────────────────────────────────────
async function updateOverview() {
  const res = await msg({ type: "GET_STATS" });
  if (!res?.stats) return;
  const s = res.stats;
  currentStats = s;

  $("mTotal").textContent    = s.total;
  $("mErrors").textContent   = s.errors;
  $("mAvg").textContent      = s.avgTime ? `${s.avgTime}ms` : "—";
  $("mSlow").textContent     = s.slow;
  $("mActive").textContent   = s.active;
  $("mFailed").textContent   = s.failed;
  $("mDomains").textContent  = s.domainCount;
  $("mDuration").textContent = formatDuration(s.sessionDuration);

  renderTimeline(s.timeline);
  renderStatusBreakdown(s.statusMap, s.total);
  renderDomainList(s.topDomains);
  renderMethodBreakdown(s.methodMap);
}

function formatDuration(secs) {
  if (!secs) return "00:00";
  const m = String(Math.floor(secs / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function renderTimeline(timeline) {
  const bars   = $("tlBars");
  const labels = $("tlLabels");
  if (!timeline || !bars) return;
  const max = Math.max(...timeline, 1);
  bars.innerHTML = timeline.map((v, i) => {
    const pct = Math.max(Math.round((v / max) * 100), v > 0 ? 4 : 0);
    const col  = v === 0 ? "var(--bg-3)" : "var(--accent)";
    return `<div class="tl-bar" style="height:${pct}%;background:${col}" data-val="${v}" title="${v} requests"></div>`;
  }).join("");
  labels.innerHTML = ["2m","1:50","1:40","1:30","1:20","1:10","1m","50s","40s","30s","20s","now"]
    .map(l => `<span>${l}</span>`).join("");
}

function renderStatusBreakdown(map, total) {
  const el = $("statusBreakdown");
  if (!el || !map) return;
  const items = [
    { key: "2xx", label: "2xx OK",     cls: "fill-2xx",  val: map["2xx"]   || 0 },
    { key: "3xx", label: "3xx Redir",  cls: "fill-3xx",  val: map["3xx"]   || 0 },
    { key: "4xx", label: "4xx Error",  cls: "fill-4xx",  val: map["4xx"]   || 0 },
    { key: "5xx", label: "5xx Server", cls: "fill-5xx",  val: map["5xx"]   || 0 },
    { key: "fail",label: "Failed",     cls: "fill-fail", val: map["failed"] || 0 }
  ];
  el.innerHTML = items.map(item => {
    const pct = total > 0 ? Math.round((item.val / total) * 100) : 0;
    return `<div class="sb-row">
      <span class="sb-key">${item.label}</span>
      <div class="sb-bar-track"><div class="sb-bar-fill ${item.cls}" style="width:${pct}%"></div></div>
      <span class="sb-val">${item.val}</span>
    </div>`;
  }).join("");
}

function renderDomainList(domains) {
  const el = $("domainList");
  if (!el || !domains) return;
  const max = domains[0]?.count || 1;
  el.innerHTML = domains.length === 0
    ? `<p style="font-size:11px;color:var(--text-3)">No data yet.</p>`
    : domains.map(d => {
        const pct = Math.round((d.count / max) * 100);
        return `<div class="dl-row">
          <span class="dl-name" title="${esc(d.domain)}">${esc(d.domain)}</span>
          <div class="dl-bar-wrap"><div class="dl-bar" style="width:${pct}%"></div></div>
          <span class="dl-count">${d.count}</span>
        </div>`;
      }).join("");
}

function renderMethodBreakdown(methodMap) {
  const el = $("methodBreakdown");
  if (!el || !methodMap) return;
  const methods  = Object.entries(methodMap).sort((a,b)=>b[1]-a[1]);
  const maxCount = methods[0]?.[1] || 1;
  const colors   = { GET:"var(--accent)",POST:"var(--green)",PUT:"var(--orange)",
                     PATCH:"var(--purple)",DELETE:"var(--red)",HEAD:"var(--cyan)" };
  el.innerHTML = methods.length === 0
    ? `<p style="font-size:11px;color:var(--text-3)">No data yet.</p>`
    : methods.map(([m, cnt]) => {
        const pct = Math.round((cnt / maxCount) * 100);
        const col = colors[m] || "var(--text-3)";
        return `<div class="mb-row">
          <span class="mb-badge m-${m.toLowerCase()}">${m}</span>
          <div class="mb-bar-wrap"><div class="mb-bar" style="width:${pct}%;background:${col}"></div></div>
          <span class="mb-count">${cnt}</span>
        </div>`;
      }).join("");
}

// ─── Request Table ────────────────────────────────────────────────────────────
function renderReqTable() {
  const tbody = $("dbReqBody"), empty = $("dbReqEmpty");
  if (filteredRequests.length === 0) {
    tbody.innerHTML = ""; empty.style.display = "flex"; return;
  }
  empty.style.display = "none";
  tbody.innerHTML = filteredRequests.map((req, i) => {
    const m   = req.method || "GET";
    const url = truncUrl(req.url || "", 55);
    const dur = req.duration != null ? `${req.duration}ms` : "—";
    let domain = "";
    try { domain = new URL(req.url).hostname; } catch(_) {}
    return `<tr class="trow${selectedRequest?.id === req.id ? " active-row" : ""}" data-i="${i}">
      <td><span class="method-badge m-${m.toLowerCase()}">${m}</span></td>
      <td class="url-cell" title="${esc(req.url || "")}">${esc(url)}</td>
      <td class="dom-cell">${esc(domain)}</td>
      <td><span class="status-badge ${sCls(req.status)}">${req.status || "—"}</span></td>
      <td class="dim">${esc((req.type || "Other").slice(0, 8))}</td>
      <td class="dim mono">${dur}${req.duration >= 2000 ? ' <span style="color:var(--orange)">⚠</span>' : ""}</td>
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
    b.addEventListener("click", e => { e.stopPropagation(); openSidePanel(filteredRequests[+b.dataset.i]); }));
  tbody.querySelectorAll(".rpl-btn").forEach(b =>
    b.addEventListener("click", e => { e.stopPropagation(); openSidePanel(filteredRequests[+b.dataset.i], "replay"); }));
  tbody.querySelectorAll(".trow").forEach(r =>
    r.addEventListener("click", () => openSidePanel(filteredRequests[+r.dataset.i])));
}

document.querySelectorAll(".pill").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach(b => b.classList.remove("active"));
    btn.classList.add("active"); activeFilter = btn.dataset.filter; applyFilters();
  });
});
$("dbReqSearch").addEventListener("input", e => {
  searchQuery = e.target.value.toLowerCase(); applyFilters();
});

// ─── Waterfall View ───────────────────────────────────────────────────────────
function renderWaterfall() {
  const body  = $("wfBody");
  const empty = $("wfEmpty");
  const ruler = $("wfRuler");

  // Apply search filter
  const wfSearch = ($("wfSearch").value || "").toLowerCase();
  const reqs = allRequests.filter(r =>
    !wfSearch || (r.url || "").toLowerCase().includes(wfSearch) || (r.method || "").toLowerCase().includes(wfSearch)
  ).slice(0, 200); // cap at 200 for performance

  if (reqs.length === 0) {
    body.innerHTML = ""; empty.style.display = "flex"; ruler.innerHTML = ""; return;
  }
  empty.style.display = "none";

  // Find time range
  const startTimes = reqs.filter(r => r.startWallTime).map(r => r.startWallTime);
  const minTime = startTimes.length > 0 ? Math.min(...startTimes) : Date.now();
  const maxDur  = Math.max(...reqs.map(r => {
    if (!r.startWallTime) return 0;
    const end = r.startWallTime + (r.duration || 0);
    return end - minTime;
  }), 1000);

  // Build ruler ticks
  const ticks = 6;
  ruler.innerHTML = Array.from({ length: ticks + 1 }, (_, i) => {
    const ms = Math.round((maxDur / ticks) * i);
    return `<span>${ms < 1000 ? ms + "ms" : (ms/1000).toFixed(1) + "s"}</span>`;
  }).join("");

  // Build rows
  body.innerHTML = reqs.map((req, idx) => {
    const m        = req.method || "GET";
    const urlShort = truncUrl(req.url || "", 36);
    const isErr    = !req.status || req.status >= 400;
    const dur      = req.duration || 0;
    const offset   = req.startWallTime ? ((req.startWallTime - minTime) / maxDur * 100) : 0;
    const width    = Math.max((dur / maxDur) * 100, 0.5);

    // Segment split: ~30% waiting, 70% receiving (simplified)
    const waitPct   = Math.min(30, width * 0.4);
    const recvPct   = width - waitPct;
    const barLeft   = `${Math.min(offset, 99)}%`;
    const barWidth  = `${Math.min(width, 100 - Math.min(offset, 99))}%`;
    const segClass  = isErr ? "wf-seg-error" : "";

    return `<div class="wf-row" data-i="${idx}">
      <div class="wf-row-name">
        <span class="wf-row-method method-badge m-${m.toLowerCase()}">${m}</span>
        <span class="wf-row-url" title="${esc(req.url || "")}">${esc(urlShort)}</span>
      </div>
      <div class="wf-row-timeline">
        <div class="wf-bar-wrap" style="left:${barLeft};width:${barWidth}">
          ${isErr
            ? `<div class="wf-seg-error" style="width:100%;height:100%"></div>`
            : `<div class="wf-seg-waiting"   style="width:${waitPct > 0 ? (waitPct/width*100).toFixed(1) : 0}%;height:100%"></div>
               <div class="wf-seg-receiving" style="width:${recvPct > 0 ? (recvPct/width*100).toFixed(1) : 100}%;height:100%"></div>`}
        </div>
        <span class="wf-bar-label">${dur > 0 ? dur + "ms" : ""}</span>
      </div>
    </div>`;
  }).join("");

  body.querySelectorAll(".wf-row").forEach(row =>
    row.addEventListener("click", () => {
      const req = reqs[+row.dataset.i];
      if (req) { switchView("requests"); openSidePanel(req); }
    })
  );
}

$("wfSearch").addEventListener("input", renderWaterfall);

// ─── Analytics ────────────────────────────────────────────────────────────────
function renderAnalytics() {
  renderRTDistribution();
  renderStatusPie();
  renderAnDomains();
  renderAnMethods();
  renderSlowTable();
}

function renderRTDistribution() {
  const canvas = $("rtDistChart");
  if (!canvas) return;
  const ctx  = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const buckets = [0,100,250,500,1000,2000,5000,Infinity];
  const labels  = ["<100ms","100-250","250-500","500ms-1s","1-2s","2-5s",">5s"];
  const counts  = new Array(labels.length).fill(0);
  allRequests.forEach(r => {
    if (r.duration == null) return;
    for (let i = 0; i < buckets.length - 1; i++) {
      if (r.duration >= buckets[i] && r.duration < buckets[i+1]) { counts[i]++; break; }
    }
  });
  const max = Math.max(...counts, 1);
  const barW = Math.floor((W - 40) / labels.length) - 4;
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const gridColor = isDark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.06)";
  const textColor = isDark ? "#464e68" : "#9ba3b8";

  // Grid lines
  ctx.strokeStyle = gridColor;
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 4; i++) {
    const y = H - 24 - ((H - 40) / 4) * i;
    ctx.beginPath(); ctx.moveTo(32, y); ctx.lineTo(W, y); ctx.stroke();
  }

  counts.forEach((cnt, i) => {
    const barH = Math.max(cnt > 0 ? 4 : 0, Math.round(((H - 40) * cnt) / max));
    const x    = 36 + i * (barW + 4);
    const y    = H - 24 - barH;
    const grad = ctx.createLinearGradient(x, y, x, H - 24);
    grad.addColorStop(0, "#4d7eff");
    grad.addColorStop(1, "rgba(77,126,255,.3)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
    ctx.fill();
    // Label
    ctx.fillStyle   = textColor;
    ctx.font        = "9px JetBrains Mono, monospace";
    ctx.textAlign   = "center";
    ctx.fillText(labels[i], x + barW / 2, H - 8);
  });
}

function renderStatusPie() {
  const canvas = $("statusPieChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const map = currentStats.statusMap || {};
  const data = [
    { label: "2xx", val: map["2xx"]   || 0, color: "#34d399" },
    { label: "3xx", val: map["3xx"]   || 0, color: "#fbbf24" },
    { label: "4xx", val: map["4xx"]   || 0, color: "#f87171" },
    { label: "5xx", val: map["5xx"]   || 0, color: "#9d6efa" },
    { label: "Fail",val: map["failed"]|| 0, color: "#464e68" }
  ].filter(d => d.val > 0);

  const total = data.reduce((a,b)=>a+b.val,0);
  if (total === 0) {
    ctx.fillStyle = "#464e68"; ctx.font = "12px Inter, sans-serif";
    ctx.textAlign = "center"; ctx.fillText("No data yet", W/2, H/2); return;
  }

  const cx = 70, cy = H/2, r = Math.min(cx, cy) - 10;
  let angle = -Math.PI / 2;
  data.forEach(d => {
    const sweep = (d.val / total) * 2 * Math.PI;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath(); ctx.fillStyle = d.color; ctx.fill();
    angle += sweep;
  });

  // Center hole (donut)
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, 2*Math.PI);
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  ctx.fillStyle = isDark ? "#13151c" : "#ffffff"; ctx.fill();
  ctx.fillStyle = isDark ? "#dde1f0" : "#111827";
  ctx.font = "bold 16px Inter, sans-serif"; ctx.textAlign = "center";
  ctx.fillText(total, cx, cy + 6);

  // Legend
  const leg = $("pieLegend");
  if (leg) leg.innerHTML = data.map(d =>
    `<div class="pie-leg-item"><div class="pie-swatch" style="background:${d.color}"></div><span>${d.label}: ${d.val}</span></div>`
  ).join("");
}

function renderAnDomains() {
  const el = $("anDomainBars");
  if (!el) return;
  const domains = currentStats.topDomains || [];
  const max = domains[0]?.count || 1;
  el.innerHTML = domains.length === 0
    ? `<p style="font-size:11px;color:var(--text-3)">No data yet.</p>`
    : domains.map(d => {
        const pct = Math.round((d.count / max) * 100);
        return `<div class="an-bar-row">
          <span class="an-bar-label" title="${esc(d.domain)}">${esc(d.domain)}</span>
          <div class="an-bar-track"><div class="an-bar-fill" style="width:${pct}%;background:var(--accent)"></div></div>
          <span class="an-bar-val">${d.count}</span>
        </div>`;
      }).join("");
}

function renderAnMethods() {
  const el = $("anMethodBars");
  if (!el) return;
  const map     = currentStats.methodMap || {};
  const methods = Object.entries(map).sort((a,b)=>b[1]-a[1]);
  const maxC    = methods[0]?.[1] || 1;
  const colors  = { GET:"var(--accent)",POST:"var(--green)",PUT:"var(--orange)",
                    PATCH:"var(--purple)",DELETE:"var(--red)",HEAD:"var(--cyan)" };
  el.innerHTML = methods.length === 0
    ? `<p style="font-size:11px;color:var(--text-3)">No data yet.</p>`
    : methods.map(([m, cnt]) => {
        const pct = Math.round((cnt / maxC) * 100);
        return `<div class="an-bar-row">
          <span class="an-bar-label"><span class="method-badge m-${m.toLowerCase()}">${m}</span></span>
          <div class="an-bar-track"><div class="an-bar-fill" style="width:${pct}%;background:${colors[m]||"var(--text-3)"}"></div></div>
          <span class="an-bar-val">${cnt}</span>
        </div>`;
      }).join("");
}

function renderSlowTable() {
  const tbody = $("slowBody");
  if (!tbody) return;
  const slow = [...allRequests].filter(r => r.duration != null)
    .sort((a,b) => b.duration - a.duration).slice(0, 10);
  if (slow.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--text-3);font-size:11px;padding:14px">No request data yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = slow.map(r => {
    let domain = ""; try { domain = new URL(r.url).hostname; } catch(_){}
    return `<tr>
      <td title="${esc(r.url)}">${esc(truncUrl(r.url || "", 45))}</td>
      <td><span class="method-badge m-${(r.method||"get").toLowerCase()}">${r.method||"GET"}</span></td>
      <td><span class="status-badge ${sCls(r.status)}">${r.status||"—"}</span></td>
      <td style="color:${r.duration>=2000?"var(--orange)":"inherit"}">${r.duration}ms</td>
    </tr>`;
  }).join("");
}

// ─── Side Panel ───────────────────────────────────────────────────────────────
function openSidePanel(req, tab = "overview") {
  selectedRequest = req;
  $("sidePanel").classList.add("open");

  const m = req.method || "GET";
  $("spMethod").textContent = m; $("spMethod").className = `method-badge m-${m.toLowerCase()}`;
  $("spStatus").textContent = req.status || "—"; $("spStatus").className = `status-badge ${sCls(req.status)}`;
  $("spUrl").textContent    = req.url || "";

  // Overview
  $("spOverviewGrid").innerHTML = [
    ["URL",      req.url || "—"],
    ["Method",   req.method || "—"],
    ["Status",   req.status ? `${req.status} ${req.statusText||""}` : "—"],
    ["Type",     req.type   || "—"],
    ["Duration", req.duration != null ? `${req.duration}ms` : "—"],
    ["MIME",     req.mimeType || "—"],
    ["Captured", req.capturedAt ? new Date(req.capturedAt).toLocaleString() : "—"]
  ].map(([k,v]) => `<div class="kvr"><span class="kvk">${k}</span><span class="kvv mono">${esc(String(v))}</span></div>`).join("");

  $("spReqH").textContent  = fmt(req.requestHeaders);
  $("spReqB").textContent  = pretty(req.requestBody) || "— No payload —";
  $("spResH").textContent  = fmt(req.responseHeaders);
  $("spResB").textContent  = pretty(req.responseBody) || "— No body —";

  $("sp-rp-url").value     = req.url    || "";
  $("sp-rp-method").value  = req.method || "GET";
  $("sp-rp-headers").value = fmt(req.requestHeaders);
  $("sp-rp-body").value    = req.requestBody || "";
  $("spRpResult").classList.add("hidden");
  $("spRpLoading").classList.add("hidden");

  switchSpTab(tab);
  renderReqTable(); // re-render to highlight active row
}

function switchSpTab(tab) {
  document.querySelectorAll(".sptab").forEach(t => t.classList.toggle("active", t.dataset.sptab === tab));
  document.querySelectorAll(".sp-panel").forEach(p => p.classList.toggle("active", p.id === `spp-${tab}`));
}

$("spClose").addEventListener("click", () => {
  $("sidePanel").classList.remove("open");
  selectedRequest = null; renderReqTable();
});
document.querySelectorAll(".sptab").forEach(t =>
  t.addEventListener("click", () => switchSpTab(t.dataset.sptab)));

$("spBtnReplay").addEventListener("click", async () => {
  const url    = $("sp-rp-url").value.trim();
  const method = $("sp-rp-method").value;
  const hraw   = $("sp-rp-headers").value.trim();
  const body   = $("sp-rp-body").value.trim();
  if (!url) { toast("URL is required", "error"); return; }
  let headers = {};
  try { if (hraw) headers = JSON.parse(hraw); } catch { toast("Invalid JSON in headers", "error"); return; }
  $("spRpLoading").classList.remove("hidden"); $("spRpResult").classList.add("hidden");
  const res = await msg({ type: "REPLAY_REQUEST", request: { url, method, headers, body } });
  $("spRpLoading").classList.add("hidden");
  if (res?.success) {
    const r = res.result;
    $("spRpMeta").innerHTML = `<span class="status-badge ${sCls(r.status)}">${r.status} ${r.statusText}</span><span class="replay-time" style="font-family:var(--mono);font-size:11px;color:var(--text-3);margin-left:8px">${r.duration}ms</span>`;
    $("spRpBody").textContent = pretty(r.responseBody) || "— Empty —";
    $("spRpResult").classList.remove("hidden");
  } else { toast("Replay failed: " + (res?.error || "Unknown"), "error"); }
});

// ─── Intercept ────────────────────────────────────────────────────────────────
function setInterceptUI(on) {
  isIntercepting = on;
  $("dbBtnIntEnable").classList.toggle("hidden", on);
  $("dbBtnIntDisable").classList.toggle("hidden", !on);
  $("dbIntLive").classList.toggle("hidden", !on);
  $("dbIntPill").classList.toggle("hidden", !on);
}

async function loadInterceptData() {
  const res  = await msg({ type: "GET_INTERCEPTED" });
  interceptHistory = (res?.intercepted || []).reverse();
  const qRes = await msg({ type: "GET_QUEUE" });
  liveQueue  = qRes?.queue || [];
  renderIntQueue(); renderIntHistory();
  $("dbQueueBadge").textContent = liveQueue.length;
  $("dbHistBadge").textContent  = interceptHistory.length;
}

function renderIntQueue() {
  const list = $("dbQueueList"), empty = $("dbQueueEmpty");
  if (liveQueue.length === 0) { list.innerHTML = ""; empty.style.display = "flex"; return; }
  empty.style.display = "none";
  list.innerHTML = liveQueue.map(req => `
    <div class="queue-card">
      <div class="queue-card-top">
        <span class="method-badge m-${(req.method||"get").toLowerCase()}">${req.method||"GET"}</span>
        <span class="queue-url">${esc(truncUrl(req.url||"",60))}</span>
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
    else toast("Error: " + (r?.error||""), "error");
  }));
  list.querySelectorAll(".qa-edit").forEach(b => b.addEventListener("click", () => {
    const req = liveQueue.find(r => r.id === b.dataset.id);
    if (req) openInterceptModal(req);
  }));
  list.querySelectorAll(".qa-block").forEach(b => b.addEventListener("click", async () => {
    const r = await msg({ type: "BLOCK_REQUEST", requestId: b.dataset.id });
    if (r?.success) { toast("Blocked", "error"); await loadInterceptData(); }
    else toast("Error: " + (r?.error||""), "error");
  }));
  list.querySelectorAll(".qa-dup").forEach(b => b.addEventListener("click", async () => {
    const r = await msg({ type: "DUPLICATE_REQUEST", requestId: b.dataset.id });
    if (r?.success) { toast("Duplicated"); await loadInterceptData(); }
    else toast("Error: " + (r?.error||""), "error");
  }));
}

function renderIntHistory() {
  const list = $("dbHistList"), empty = $("dbHistEmpty");
  if (interceptHistory.length === 0) { list.innerHTML = ""; empty.style.display = "flex"; return; }
  empty.style.display = "none";
  const stMap = { paused:"s-pause", forwarded:"s-ok", modified:"s-modified", blocked:"s-err" };
  list.innerHTML = interceptHistory.map(req => `
    <div class="hist-card">
      <div class="hist-row">
        <span class="method-badge m-${(req.method||"get").toLowerCase()}">${req.method||"GET"}</span>
        <span class="status-badge ${stMap[req.status]||"s-unknown"}">${req.status||"—"}</span>
        <span class="hist-url">${esc(truncUrl(req.url||"",60))}</span>
        <span class="hist-time">${new Date(req.pausedAt).toLocaleTimeString()}</span>
      </div>
      ${req.modifications?`<div class="hist-modified-note">Modified: ${Object.keys(req.modifications).join(", ")}</div>`:""}
    </div>`).join("");
}

$("dbBtnIntEnable").addEventListener("click", async () => {
  const pattern = $("dbIntPattern").value.trim();
  const r = await msg({ type: "START_INTERCEPTING", patterns: pattern ? [pattern] : [] });
  if (r?.success) { setInterceptUI(true); toast("Interception active"); }
  else toast("Failed to start interception", "error");
});
$("dbBtnIntDisable").addEventListener("click", async () => {
  await msg({ type: "STOP_INTERCEPTING" });
  setInterceptUI(false); toast("Interception stopped"); await loadInterceptData();
});
$("dbBtnIntClear").addEventListener("click", async () => {
  if (!confirm("Clear interception history?")) return;
  await msg({ type: "CLEAR_INTERCEPTED" }); interceptHistory = []; renderIntHistory(); toast("Cleared");
});
document.querySelectorAll(".int-tab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".int-tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".int-panel").forEach(x => x.classList.remove("active"));
    t.classList.add("active"); activeIntTab = t.dataset.itab;
    $(activeIntTab === "queue" ? "dbPanelQueue" : "dbPanelHistory").classList.add("active");
  });
});

// ─── Intercept Edit Modal ─────────────────────────────────────────────────────
function openInterceptModal(req) {
  currentIntercept = req;
  $("dbInterceptOverlay").classList.add("visible");
  const m = req.method || "GET";
  $("dbImMethod").textContent = m; $("dbImMethod").className = `method-badge m-${m.toLowerCase()}`;
  $("dbImUrl").textContent    = req.url || "";
  $("dbImOverview").innerHTML = [
    ["URL", req.url||"—"], ["Method", req.method||"—"],
    ["Type", req.type||"—"], ["Paused At", req.pausedAt ? new Date(req.pausedAt).toLocaleString() : "—"]
  ].map(([k,v]) => `<div class="kvr"><span class="kvk">${k}</span><span class="kvv mono">${esc(v)}</span></div>`).join("");
  $("dbImOrigH").textContent = fmt(req.requestHeaders);
  $("dbImOrigB").textContent = pretty(req.requestBody) || "— No payload —";
  $("db-edit-url").value     = req.url    || "";
  $("db-edit-method").value  = req.method || "GET";
  buildDbParamEditor(req.url);
  $("db-edit-headers").value = fmt(req.requestHeaders);
  const ct = ((req.requestHeaders||{})["content-type"]||"").split(";")[0].trim();
  $("db-edit-ct").value  = ct || "";
  $("db-edit-body").value = pretty(req.requestBody) || "";
  switchDbIntTab("overview");
}

function switchDbIntTab(tab) {
  document.querySelectorAll("#dbInterceptModal .mtab").forEach(t =>
    t.classList.toggle("active", t.dataset.ditab === tab));
  document.querySelectorAll("#dbInterceptModal .tab-panel").forEach(p =>
    p.classList.toggle("active", p.id === `ditp-${tab}`));
}

function buildDbParamEditor(url) {
  const c = $("dbParamEditor"); c.innerHTML = "";
  try {
    const params = [...new URL(url).searchParams.entries()];
    if (!params.length) { c.innerHTML = `<p class="hint-text">No query params.</p>`; return; }
    params.forEach(([k,v]) => {
      const row = document.createElement("div"); row.className = "param-row";
      row.innerHTML = `<input class="form-input param-key" value="${esc(k)}" placeholder="key"/><input class="form-input param-val" value="${esc(v)}" placeholder="value"/><button class="act-btn remove-param" style="width:24px;height:24px;border:1px solid var(--border);background:transparent;border-radius:5px;cursor:pointer;color:var(--red)">×</button>`;
      row.querySelector(".remove-param").addEventListener("click", () => row.remove());
      c.appendChild(row);
    });
  } catch (_) { c.innerHTML = `<p class="hint-text">Enter a valid URL to parse params.</p>`; }
}

function getDbModifications() {
  try {
    const url = new URL($("db-edit-url").value); url.search = "";
    $("dbParamEditor").querySelectorAll(".param-row").forEach(row => {
      const k = row.querySelector(".param-key").value.trim(), v = row.querySelector(".param-val").value;
      if (k) url.searchParams.append(k, v);
    });
    $("db-edit-url").value = url.toString();
  } catch (_) {}
  let headers = {};
  try { headers = JSON.parse($("db-edit-headers").value || "{}"); } catch (_) {}
  const ct = $("db-edit-ct").value;
  if (ct && !headers["content-type"]) headers["content-type"] = ct;
  return { url: $("db-edit-url").value.trim(), method: $("db-edit-method").value, headers, body: $("db-edit-body").value };
}

document.querySelectorAll("#dbInterceptModal .mtab").forEach(t =>
  t.addEventListener("click", () => switchDbIntTab(t.dataset.ditab)));
$("dbInterceptClose").addEventListener("click", () => { $("dbInterceptOverlay").classList.remove("visible"); currentIntercept = null; });
$("dbInterceptOverlay").addEventListener("click", e => { if (e.target === $("dbInterceptOverlay")) { $("dbInterceptOverlay").classList.remove("visible"); currentIntercept = null; } });
$("dbIaForward").addEventListener("click", async () => {
  if (!currentIntercept) return;
  const r = await msg({ type: "FORWARD_REQUEST", requestId: currentIntercept.id });
  if (r?.success) { toast("Forwarded"); $("dbInterceptOverlay").classList.remove("visible"); await loadInterceptData(); }
  else toast("Failed: " + (r?.error||""), "error");
});
$("dbIaModify").addEventListener("click", async () => {
  if (!currentIntercept) return;
  const r = await msg({ type: "MODIFY_AND_SEND", requestId: currentIntercept.id, modifications: getDbModifications() });
  if (r?.success) { toast("Modified & sent"); $("dbInterceptOverlay").classList.remove("visible"); await loadInterceptData(); }
  else toast("Failed: " + (r?.error||""), "error");
});
$("dbIaBlock").addEventListener("click", async () => {
  if (!currentIntercept || !confirm("Block this request?")) return;
  const r = await msg({ type: "BLOCK_REQUEST", requestId: currentIntercept.id });
  if (r?.success) { toast("Blocked", "error"); $("dbInterceptOverlay").classList.remove("visible"); await loadInterceptData(); }
  else toast("Failed: " + (r?.error||""), "error");
});
$("dbIaDuplicate").addEventListener("click", async () => {
  if (!currentIntercept) return;
  const r = await msg({ type: "DUPLICATE_REQUEST", requestId: currentIntercept.id });
  if (r?.success) { toast("Duplicated & forwarded"); $("dbInterceptOverlay").classList.remove("visible"); await loadInterceptData(); }
  else toast("Failed: " + (r?.error||""), "error");
});
$("dbAddParam").addEventListener("click", () => {
  const row = document.createElement("div"); row.className = "param-row";
  row.innerHTML = `<input class="form-input param-key" placeholder="key"/><input class="form-input param-val" placeholder="value"/><button class="act-btn remove-param" style="width:24px;height:24px;border:1px solid var(--border);background:transparent;border-radius:5px;cursor:pointer;color:var(--red)">×</button>`;
  row.querySelector(".remove-param").addEventListener("click", () => row.remove());
  $("dbParamEditor").appendChild(row);
});
$("dbPrettyBody").addEventListener("click", () => {
  try { $("db-edit-body").value = JSON.stringify(JSON.parse($("db-edit-body").value), null, 2); }
  catch (_) { toast("Not valid JSON", "error"); }
});

// ─── Storage ──────────────────────────────────────────────────────────────────
document.querySelectorAll(".st-tab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".st-tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active"); activeStorTab = t.dataset.stab; loadStorageTab(activeStorTab);
  });
});
$("dbStorRefresh").addEventListener("click", () => loadStorageTab(activeStorTab));

async function loadStorageTab(tab) {
  const el = $("dbStorageContent");
  el.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>`;
  if (tab === "ls") {
    const r = await msgTab({ type: "GET_LOCAL_STORAGE" });
    r?.success ? renderKVStorage(r.data, el) : showErr(el, r?.error);
  } else if (tab === "ss") {
    const r = await msgTab({ type: "GET_SESSION_STORAGE" });
    r?.success ? renderKVStorage(r.data, el) : showErr(el, r?.error);
  } else if (tab === "cache") {
    const r = await msgTab({ type: "GET_CACHE_STORAGE" });
    r?.success ? renderCacheStorage(r.data, el) : showErr(el, r?.error);
  } else if (tab === "idb") {
    const r = await msgTab({ type: "GET_INDEXEDDB" });
    r?.success ? renderIDBStorage(r.data, el) : showErr(el, r?.error);
  }
}

function showErr(el, err) {
  el.innerHTML = `<div class="empty-state"><p class="es-title">Unavailable</p><p class="es-sub">${esc(err||"Not accessible on this page.")}</p></div>`;
}

function renderKVStorage(data, el) {
  const entries = Object.entries(data);
  if (entries.length === 0) { el.innerHTML = `<div class="empty-state"><p class="es-title">Empty</p><p class="es-sub">No data in this storage.</p></div>`; return; }
  el.innerHTML = `<div style="margin-bottom:8px;font-family:var(--mono);font-size:11px;color:var(--text-3)">${entries.length} key${entries.length!==1?"s":""}</div>
    <div class="kv-table">
      <div class="kv-thead"><span>Key</span><span>Value</span></div>
      ${entries.map(([k,v])=>`<div class="kv-trow"><span class="kv-key-cell" title="${esc(k)}">${esc(k)}</span><span class="kv-val-cell" title="${esc(v)}">${esc(trunc(v,140))}</span></div>`).join("")}
    </div>`;
}

function renderCacheStorage(data, el) {
  const caches = Object.entries(data);
  if (caches.length === 0) { el.innerHTML = `<div class="empty-state"><p class="es-title">No caches</p><p class="es-sub">No Service Worker caches for this origin.</p></div>`; return; }
  el.innerHTML = caches.map(([name, entries]) => `
    <details class="store-grp" open>
      <summary class="store-sum">
        <svg viewBox="0 0 10 10" fill="none"><path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="store-nm">${esc(name)}</span><span class="store-ct">${entries.length} entries</span>
      </summary>
      <div class="store-entries">${entries.length===0?`<div class="store-empty">Empty</div>`:
        entries.map(e=>`<div class="cache-entry"><span class="method-badge m-${(e.method||"get").toLowerCase()}">${e.method||"GET"}</span><span class="cache-url">${esc(trunc(e.url,100))}</span></div>`).join("")}
      </div>
    </details>`).join("");
}

function renderIDBStorage(data, el) {
  const dbs = Object.entries(data);
  if (dbs.length === 0) { el.innerHTML = `<div class="empty-state"><p class="es-title">No databases</p><p class="es-sub">No IndexedDB databases for this origin.</p></div>`; return; }
  el.innerHTML = dbs.map(([dbName, dbInfo]) => `
    <details class="store-grp" open>
      <summary class="store-sum">
        <svg viewBox="0 0 10 10" fill="none"><path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="store-nm">${esc(dbName)}</span>
        <span class="store-ct">v${dbInfo.version} · ${Object.keys(dbInfo.stores).length} stores</span>
      </summary>
      <div class="store-entries">
        ${Object.entries(dbInfo.stores).map(([sn, records]) => `
          <details class="sub-store">
            <summary class="sub-sum"><span>${esc(sn)}</span><span class="store-ct">${records.length} records</span></summary>
            <div class="idb-records">
              ${records.length===0?`<div class="store-empty">No records</div>`:
                records.map(r=>`<pre class="idb-rec">${esc(JSON.stringify(r,null,2))}</pre>`).join("")}
            </div>
          </details>`).join("")}
      </div>
    </details>`).join("");
}

// ─── Background Push ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "STATS_UPDATE":
      currentStats = message.stats;
      if (activeView === "overview") updateOverview();
      break;
    case "REQUEST_PAUSED":
      liveQueue.push(message.request);
      if (activeView === "intercept") { renderIntQueue(); $("dbQueueBadge").textContent = liveQueue.length; }
      break;
    case "REQUEST_FORWARDED": case "REQUEST_MODIFIED": case "REQUEST_BLOCKED":
      loadInterceptData(); break;
    case "REQUEST_COMPLETE": case "REQUEST_FAILED":
      loadRequests(); break;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sCls(s) { if (!s) return "s-unknown"; if (s<300) return "s-ok"; if (s<400) return "s-redir"; if (s<500) return "s-err"; return "s-srv"; }
function truncUrl(url, max=55) { try { const u=new URL(url), p=u.pathname+u.search; return p.length>max?p.slice(0,max)+"…":p; } catch { return url.length>max?url.slice(0,max)+"…":url; } }
function trunc(s,max) { return s&&s.length>max?s.slice(0,max)+"…":(s||""); }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmt(v)  { if (!v) return "—"; if (typeof v==="string") return v; return JSON.stringify(v,null,2); }
function pretty(s) { if (!s) return null; try { return JSON.stringify(JSON.parse(s),null,2); } catch { return s; } }

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const status = await msg({ type: "GET_STATUS" });
  if (status?.isRecording)    { isRecording=true;    setRecordingUI(true);  startTimer(); startAutoRefresh(); }
  if (status?.isIntercepting) { isIntercepting=true; setInterceptUI(true); }

  await loadRequests();
  await updateOverview();
  switchView("overview");
}

init();
