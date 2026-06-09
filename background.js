/**
 * Inspectly — Background Service Worker v3.0 (background.js)
 * ─────────────────────────────────────────────────────────────
 * New in v3.0:
 *   • Session tracking: startTime, duration, domain counting
 *   • Active request counter (in-flight requests)
 *   • Slow request detection (>2000ms threshold)
 *   • Stats broadcast to dashboard every second
 *   • Window/tab management for workspace modes
 *   • Analytics data: timeline, domain breakdown, method counts
 */
"use strict";

const MAX_REQUESTS     = 5000;
const DEBUGGER_VERSION = "1.3";
const SLOW_THRESHOLD   = 2000; // ms

const attachedTabs     = new Set();
const pendingRequests  = new Map();
const interceptedQueue = new Map();

let isRecording        = false;
let isIntercepting     = false;
let interceptPatterns  = [];

// Session tracking
let sessionStartTime   = null;
let statsInterval      = null;

// Restore persisted state on service worker restart
chrome.storage.local.get(["isRecording","isIntercepting","interceptPatterns","sessionStartTime"], (s) => {
  isRecording       = !!s.isRecording;
  isIntercepting    = !!s.isIntercepting;
  interceptPatterns = s.interceptPatterns || [];
  sessionStartTime  = s.sessionStartTime  || null;
  if (isRecording && !statsInterval) startStatsInterval();
});

// ─── Stats Broadcasting ───────────────────────────────────────────────────────
function startStatsInterval() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(broadcastStats, 1000);
}
function stopStatsInterval() {
  clearInterval(statsInterval);
  statsInterval = null;
}

async function broadcastStats() {
  const stats = await computeStats();
  broadcastToPopup({ type: "STATS_UPDATE", stats });
}

async function computeStats() {
  return new Promise(resolve => {
    chrome.storage.local.get(["requests"], ({ requests = [] }) => {
      const now  = Date.now();
      const dur  = sessionStartTime ? Math.floor((now - sessionStartTime) / 1000) : 0;
      const total  = requests.length;
      const errors = requests.filter(r => !r.status || r.status >= 400).length;
      const failed = requests.filter(r => r.status === 0).length;
      const slow   = requests.filter(r => r.duration != null && r.duration >= SLOW_THRESHOLD).length;
      const active = pendingRequests.size;
      const times  = requests.filter(r => r.duration != null).map(r => r.duration);
      const avgTime= times.length ? Math.round(times.reduce((a,b)=>a+b,0)/times.length) : 0;
      const domains= new Set(requests.map(r => { try { return new URL(r.url).hostname; } catch(_) { return "unknown"; } }));

      // Timeline: requests per 10s bucket for last 120s
      const timeline = [];
      for (let i = 11; i >= 0; i--) {
        const bucketEnd   = now - i * 10000;
        const bucketStart = bucketEnd - 10000;
        timeline.push(requests.filter(r => r.capturedAt >= bucketStart && r.capturedAt < bucketEnd).length);
      }

      // Domain breakdown (top 8)
      const domainMap = {};
      requests.forEach(r => {
        try { const h = new URL(r.url).hostname; domainMap[h] = (domainMap[h]||0)+1; } catch(_) {}
      });
      const topDomains = Object.entries(domainMap).sort((a,b)=>b[1]-a[1]).slice(0,8)
        .map(([domain,count]) => ({ domain, count }));

      // Method breakdown
      const methodMap = {};
      requests.forEach(r => { const m = r.method||"GET"; methodMap[m]=(methodMap[m]||0)+1; });

      // Status breakdown
      const statusMap = { "2xx":0, "3xx":0, "4xx":0, "5xx":0, "failed":0 };
      requests.forEach(r => {
        if (!r.status || r.status === 0) statusMap.failed++;
        else if (r.status < 300) statusMap["2xx"]++;
        else if (r.status < 400) statusMap["3xx"]++;
        else if (r.status < 500) statusMap["4xx"]++;
        else statusMap["5xx"]++;
      });

      resolve({ total, errors, failed, slow, active, avgTime,
        domainCount: domains.size, sessionDuration: dur,
        timeline, topDomains, methodMap, statusMap });
    });
  });
}

// ─── Debugger Attach / Detach ─────────────────────────────────────────────────
async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    attachedTabs.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxPostDataSize: 65536, maxResourceBufferSize: 10485760, maxTotalBufferSize: 104857600
    });
    if (isIntercepting) await enableFetch(tabId);
  } catch (err) {
    attachedTabs.delete(tabId);
    console.warn(`[Inspectly] Attach failed (tab ${tabId}):`, err.message);
  }
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  attachedTabs.delete(tabId);
}

async function enableFetch(tabId) {
  const patterns = interceptPatterns.length > 0
    ? interceptPatterns.map(p => ({ urlPattern: p, requestStage: "Request" }))
    : [{ urlPattern: "*", requestStage: "Request" }];
  try {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", { patterns });
  } catch (err) { console.warn(`[Inspectly] Fetch.enable failed:`, err.message); }
}

async function disableFetch(tabId) {
  try { await chrome.debugger.sendCommand({ tabId }, "Fetch.disable", {}); } catch (_) {}
}

// ─── Debugger Events ──────────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  switch (method) {

    case "Network.requestWillBeSent": {
      if (!isRecording) break;
      const { requestId, request, timestamp, type } = params;
      pendingRequests.set(requestId, {
        id: requestId, tabId,
        url: request.url, method: request.method,
        requestHeaders: request.headers, requestBody: request.postData || null,
        type: type || "Other", startTime: timestamp,
        startWallTime: Date.now(),
        endTime: null, duration: null, status: null, statusText: null,
        responseHeaders: null, responseBody: null, mimeType: null,
        capturedAt: Date.now(), intercepted: false, modified: false, blocked: false
      });
      broadcastToPopup({ type: "REQUEST_STARTED", count: pendingRequests.size });
      break;
    }

    case "Network.responseReceived": {
      if (!isRecording) break;
      const { requestId, response, timestamp } = params;
      const req = pendingRequests.get(requestId);
      if (!req) break;
      req.status = response.status; req.statusText = response.statusText;
      req.responseHeaders = response.headers; req.mimeType = response.mimeType;
      req.endTime = timestamp;
      req.duration = Math.round((timestamp - req.startTime) * 1000);
      break;
    }

    case "Network.loadingFinished": {
      if (!isRecording) break;
      const { requestId, timestamp } = params;
      const req = pendingRequests.get(requestId);
      if (!req) break;
      if (!req.endTime) { req.endTime = timestamp; req.duration = Math.round((timestamp - req.startTime) * 1000); }
      try {
        const body = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId });
        req.responseBody = body?.base64Encoded ? atob(body.body) : (body?.body || null);
      } catch (_) { req.responseBody = null; }
      await persistRequest({ ...req });
      pendingRequests.delete(requestId);
      broadcastToPopup({ type: "REQUEST_COMPLETE", count: pendingRequests.size });
      break;
    }

    case "Network.loadingFailed": {
      if (!isRecording) break;
      const { requestId, errorText, timestamp } = params;
      const req = pendingRequests.get(requestId);
      if (!req) break;
      req.status = 0; req.statusText = errorText || "Failed";
      req.endTime = timestamp; req.duration = Math.round((timestamp - req.startTime) * 1000);
      req.responseBody = null;
      await persistRequest({ ...req });
      pendingRequests.delete(requestId);
      broadcastToPopup({ type: "REQUEST_FAILED", count: pendingRequests.size });
      break;
    }

    case "Fetch.requestPaused": {
      const { requestId, request, resourceType, frameId } = params;
      if (!isIntercepting) {
        try { await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId }); } catch (_) {}
        break;
      }
      const paused = {
        id: requestId, tabId, frameId,
        url: request.url, method: request.method,
        requestHeaders: headersArrToObj(request.headers || []),
        requestBody: request.postData || null,
        type: resourceType || "Other",
        pausedAt: Date.now(), status: "paused",
        originalUrl: request.url, originalMethod: request.method
      };
      interceptedQueue.set(requestId, paused);
      await persistIntercepted({ ...paused });
      broadcastToPopup({ type: "REQUEST_PAUSED", request: paused });
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source) => { attachedTabs.delete(source.tabId); });

// ─── Interception Actions ─────────────────────────────────────────────────────
async function forwardRequest(requestId) {
  const p = interceptedQueue.get(requestId);
  if (!p) return { success: false, error: "Not in queue" };
  try {
    await chrome.debugger.sendCommand({ tabId: p.tabId }, "Fetch.continueRequest", { requestId });
    p.status = "forwarded"; await updateIntercepted(p);
    interceptedQueue.delete(requestId);
    broadcastToPopup({ type: "REQUEST_FORWARDED", requestId });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

async function modifyAndSend(requestId, mods) {
  const p = interceptedQueue.get(requestId);
  if (!p) return { success: false, error: "Not in queue" };
  try {
    const cmd = { requestId };
    if (mods.url)              cmd.url      = mods.url;
    if (mods.method)           cmd.method   = mods.method;
    if (mods.headers)          cmd.headers  = headersObjToArr(mods.headers);
    if (mods.body !== undefined) cmd.postData = mods.body || "";
    await chrome.debugger.sendCommand({ tabId: p.tabId }, "Fetch.continueRequest", cmd);
    p.status = "modified"; p.modifications = mods;
    await updateIntercepted(p); interceptedQueue.delete(requestId);
    broadcastToPopup({ type: "REQUEST_MODIFIED", requestId });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

async function blockRequest(requestId) {
  const p = interceptedQueue.get(requestId);
  if (!p) return { success: false, error: "Not in queue" };
  try {
    await chrome.debugger.sendCommand({ tabId: p.tabId }, "Fetch.failRequest",
      { requestId, errorReason: "BlockedByClient" });
    p.status = "blocked"; await updateIntercepted(p);
    interceptedQueue.delete(requestId);
    broadcastToPopup({ type: "REQUEST_BLOCKED", requestId });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

async function duplicateRequest(requestId) {
  const p = interceptedQueue.get(requestId);
  if (!p) return { success: false, error: "Not in queue" };
  const fwd = await forwardRequest(requestId);
  if (!fwd.success) return fwd;
  try {
    const result = await replayRequest(p.url, p.method, p.requestHeaders, p.requestBody);
    broadcastToPopup({ type: "DUPLICATE_RESPONSE", requestId, result });
    return { success: true, result };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── Replay ───────────────────────────────────────────────────────────────────
const FORBIDDEN = new Set(["host","content-length","connection","transfer-encoding",
  "upgrade","te","trailer","keep-alive","proxy-authorization","proxy-authenticate"]);

async function replayRequest(url, method, headers, body) {
  const safe = {};
  for (const [k,v] of Object.entries(headers||{})) {
    if (!FORBIDDEN.has(k.toLowerCase())) safe[k] = v;
  }
  const opts = { method: method||"GET", headers: safe };
  if (body && !["GET","HEAD"].includes((method||"").toUpperCase())) opts.body = body;
  const t0 = performance.now();
  const res = await fetch(url, opts);
  const dur = Math.round(performance.now() - t0);
  const rh = {}; res.headers.forEach((v,k) => { rh[k]=v; });
  let rb = null; try { rb = await res.text(); } catch(_) {}
  return { status: res.status, statusText: res.statusText, responseHeaders: rh, responseBody: rb, duration: dur };
}

// ─── Storage ──────────────────────────────────────────────────────────────────
async function persistRequest(req) {
  return new Promise(resolve => {
    chrome.storage.local.get(["requests"], ({ requests=[] }) => {
      if (requests.length >= MAX_REQUESTS) requests = requests.slice(-(MAX_REQUESTS-1));
      requests.push(req);
      chrome.storage.local.set({ requests }, resolve);
    });
  });
}
async function persistIntercepted(req) {
  return new Promise(resolve => {
    chrome.storage.local.get(["intercepted"], ({ intercepted=[] }) => {
      if (intercepted.length >= 1000) intercepted = intercepted.slice(-999);
      intercepted.push(req);
      chrome.storage.local.set({ intercepted }, resolve);
    });
  });
}
async function updateIntercepted(req) {
  return new Promise(resolve => {
    chrome.storage.local.get(["intercepted"], ({ intercepted=[] }) => {
      const i = intercepted.findIndex(r => r.id === req.id);
      if (i >= 0) intercepted[i] = req;
      chrome.storage.local.set({ intercepted }, resolve);
    });
  });
}
const getAllRequests    = () => new Promise(r => chrome.storage.local.get(["requests"],    ({requests=[]})    => r(requests)));
const getIntercepted   = () => new Promise(r => chrome.storage.local.get(["intercepted"],({intercepted=[]})  => r(intercepted)));
const clearRequests    = () => new Promise(r => chrome.storage.local.set({requests:[]},   r));
const clearIntercepted = () => new Promise(r => chrome.storage.local.set({intercepted:[]},r));

// ─── Utilities ────────────────────────────────────────────────────────────────
function headersArrToObj(arr) { const o={}; (arr||[]).forEach(({name,value})=>{o[name]=value;}); return o; }
function headersObjToArr(obj) { return Object.entries(obj||{}).map(([name,value])=>({name,value})); }
function broadcastToPopup(msg) { chrome.runtime.sendMessage(msg).catch(()=>{}); }

// ─── Tab Lifecycle ────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && (isRecording || isIntercepting) && !attachedTabs.has(tabId)) {
    attachDebugger(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  detachDebugger(tabId);
  pendingRequests.forEach((v,k)=>{ if(v.tabId===tabId) pendingRequests.delete(k); });
  interceptedQueue.forEach((v,k)=>{ if(v.tabId===tabId) interceptedQueue.delete(k); });
});

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case "START_RECORDING":
      chrome.tabs.query({active:true,currentWindow:true}, (tabs) => {
        isRecording = true;
        sessionStartTime = Date.now();
        chrome.storage.local.set({isRecording:true, sessionStartTime});
        startStatsInterval();
        if (tabs[0]) attachDebugger(tabs[0].id).then(()=>sendResponse({success:true}));
        else sendResponse({success:true});
      });
      return true;

    case "STOP_RECORDING":
      isRecording = false;
      chrome.storage.local.set({isRecording:false});
      stopStatsInterval();
      chrome.tabs.query({active:true,currentWindow:true}, (tabs) => {
        if (tabs[0] && !isIntercepting) detachDebugger(tabs[0].id).then(()=>sendResponse({success:true}));
        else sendResponse({success:true});
      });
      return true;

    case "START_INTERCEPTING":
      chrome.tabs.query({active:true,currentWindow:true}, async (tabs) => {
        isIntercepting    = true;
        interceptPatterns = msg.patterns || [];
        chrome.storage.local.set({isIntercepting:true, interceptPatterns});
        if (tabs[0]) {
          if (!attachedTabs.has(tabs[0].id)) await attachDebugger(tabs[0].id);
          else await enableFetch(tabs[0].id);
        }
        sendResponse({success:true});
      });
      return true;

    case "STOP_INTERCEPTING":
      chrome.tabs.query({active:true,currentWindow:true}, async (tabs) => {
        isIntercepting = false;
        chrome.storage.local.set({isIntercepting:false});
        for (const [rid, p] of interceptedQueue) {
          try { await chrome.debugger.sendCommand({tabId:p.tabId},"Fetch.continueRequest",{requestId:rid}); } catch(_){}
          interceptedQueue.delete(rid);
        }
        if (tabs[0]) await disableFetch(tabs[0].id);
        if (tabs[0] && !isRecording) await detachDebugger(tabs[0].id);
        sendResponse({success:true});
      });
      return true;

    case "FORWARD_REQUEST":    forwardRequest(msg.requestId).then(sendResponse);                return true;
    case "MODIFY_AND_SEND":    modifyAndSend(msg.requestId,msg.modifications).then(sendResponse);return true;
    case "BLOCK_REQUEST":      blockRequest(msg.requestId).then(sendResponse);                  return true;
    case "DUPLICATE_REQUEST":  duplicateRequest(msg.requestId).then(sendResponse);              return true;

    case "GET_REQUESTS":    getAllRequests().then(requests   =>sendResponse({requests}));     return true;
    case "GET_INTERCEPTED": getIntercepted().then(intercepted=>sendResponse({intercepted}));  return true;
    case "CLEAR_REQUESTS":  clearRequests().then(()=>sendResponse({success:true}));           return true;
    case "CLEAR_INTERCEPTED": clearIntercepted().then(()=>sendResponse({success:true}));      return true;
    case "GET_QUEUE":       sendResponse({queue:[...interceptedQueue.values()]});              return true;

    case "GET_STATS":
      computeStats().then(stats => sendResponse({ stats }));
      return true;

    case "GET_STATUS":
      chrome.storage.local.get(["isRecording","isIntercepting","sessionStartTime"], (s) => {
        sendResponse({
          isRecording:     !!s.isRecording,
          isIntercepting:  !!s.isIntercepting,
          sessionStartTime: s.sessionStartTime || null,
          attachedTabs:    [...attachedTabs],
          queueLength:     interceptedQueue.size
        });
      });
      return true;

    case "REPLAY_REQUEST":
      replayRequest(msg.request.url,msg.request.method,msg.request.headers,msg.request.body)
        .then(result=>sendResponse({success:true,result}))
        .catch(err  =>sendResponse({success:false,error:err.message}));
      return true;

    // ── Workspace window management ───────────────────────────────────────────
    case "OPEN_DASHBOARD_TAB":
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
      sendResponse({ success: true });
      return true;

    case "OPEN_DASHBOARD_WINDOW":
      chrome.windows.create({
        url:    chrome.runtime.getURL("dashboard.html"),
        type:   "popup",
        width:  1400,
        height: 900,
        top:    40,
        left:   40
      });
      sendResponse({ success: true });
      return true;

    case "OPEN_DASHBOARD_FULLSCREEN":
      chrome.windows.create({
        url:   chrome.runtime.getURL("dashboard.html"),
        type:  "normal",
        state: "maximized"
      });
      sendResponse({ success: true });
      return true;
  }
});

console.log("[Inspectly] Background service worker v3.0 ready.");
