/**
 * Inspectly — Background Service Worker v2.1 (background.js)
 * ─────────────────────────────────────────────────────────────
 * Fixes in v2.1:
 *   • Interception: attach debugger BEFORE enabling Fetch domain
 *   • Interception: correctly forward all non-matching requests
 *   • Interception: auto-forward queue on stop
 *   • Network capture now works independently of interception state
 *   • Restore isIntercepting state from storage on worker restart
 */
"use strict";

const MAX_REQUESTS     = 5000;
const DEBUGGER_VERSION = "1.3";

const attachedTabs     = new Set();
const pendingRequests  = new Map();
const interceptedQueue = new Map();  // requestId → paused request
let isRecording        = false;
let isIntercepting     = false;
let interceptPatterns  = [];

// ─── Restore persisted state on service worker restart ───────────────────────
chrome.storage.local.get(["isRecording","isIntercepting","interceptPatterns"], (s) => {
  isRecording       = !!s.isRecording;
  isIntercepting    = !!s.isIntercepting;
  interceptPatterns = s.interceptPatterns || [];
});

// ─── Debugger: Attach / Detach ────────────────────────────────────────────────
async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    attachedTabs.add(tabId);
    // Always enable Network domain first
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxPostDataSize: 65536, maxResourceBufferSize: 10485760, maxTotalBufferSize: 104857600
    });
    // Enable Fetch domain only if interception is active
    if (isIntercepting) await enableFetch(tabId);
    console.log(`[Inspectly] Debugger attached → tab ${tabId}`);
  } catch (err) {
    attachedTabs.delete(tabId);
    console.warn(`[Inspectly] Attach failed (tab ${tabId}):`, err.message);
  }
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {}
  attachedTabs.delete(tabId);
}

async function enableFetch(tabId) {
  const patterns = interceptPatterns.length > 0
    ? interceptPatterns.map(p => ({ urlPattern: p, requestStage: "Request" }))
    : [{ urlPattern: "*", requestStage: "Request" }];
  try {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", { patterns });
    console.log(`[Inspectly] Fetch interception ON → tab ${tabId}`);
  } catch (err) {
    console.warn(`[Inspectly] Fetch.enable failed:`, err.message);
  }
}

async function disableFetch(tabId) {
  try { await chrome.debugger.sendCommand({ tabId }, "Fetch.disable", {}); } catch (_) {}
}

// ─── Debugger Events ──────────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;

  switch (method) {

    // Network capture events (always active when debugger attached)
    case "Network.requestWillBeSent": {
      if (!isRecording) break;
      const { requestId, request, timestamp, type } = params;
      pendingRequests.set(requestId, {
        id: requestId, tabId,
        url: request.url, method: request.method,
        requestHeaders: request.headers, requestBody: request.postData || null,
        type: type || "Other", startTime: timestamp,
        endTime: null, duration: null, status: null, statusText: null,
        responseHeaders: null, responseBody: null, mimeType: null,
        capturedAt: Date.now(), intercepted: false, modified: false, blocked: false
      });
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
      break;
    }

    // Fetch interception event — fires when a request is PAUSED
    case "Fetch.requestPaused": {
      const { requestId, request, resourceType, frameId } = params;
      if (!isIntercepting) {
        // Interception was disabled after event fired — auto-forward
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

chrome.debugger.onDetach.addListener((source) => {
  attachedTabs.delete(source.tabId);
});

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
  // Forward original first, then fire a copy via fetch
  const fwd = await forwardRequest(requestId);
  if (!fwd.success) return fwd;
  try {
    const result = await replayRequest(p.url, p.method, p.requestHeaders, p.requestBody);
    broadcastToPopup({ type: "DUPLICATE_RESPONSE", requestId, result });
    return { success: true, result };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── Request Replay ───────────────────────────────────────────────────────────
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
const getAllRequests   = () => new Promise(r => chrome.storage.local.get(["requests"],    ({requests=[]})   => r(requests)));
const getIntercepted  = () => new Promise(r => chrome.storage.local.get(["intercepted"],({intercepted=[]}) => r(intercepted)));
const clearRequests   = () => new Promise(r => chrome.storage.local.set({requests:[]},  r));
const clearIntercepted= () => new Promise(r => chrome.storage.local.set({intercepted:[]},r));

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
        chrome.storage.local.set({isRecording:true});
        if (tabs[0]) attachDebugger(tabs[0].id).then(()=>sendResponse({success:true}));
        else sendResponse({success:true});
      });
      return true;

    case "STOP_RECORDING":
      isRecording = false;
      chrome.storage.local.set({isRecording:false});
      chrome.tabs.query({active:true,currentWindow:true}, (tabs) => {
        // Only detach if NOT intercepting — keep debugger alive if interception still on
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
          // Must attach debugger first (if not already), then enable Fetch
          if (!attachedTabs.has(tabs[0].id)) {
            await attachDebugger(tabs[0].id);
          } else {
            await enableFetch(tabs[0].id);
          }
        }
        sendResponse({success:true});
      });
      return true;

    case "STOP_INTERCEPTING":
      chrome.tabs.query({active:true,currentWindow:true}, async (tabs) => {
        isIntercepting = false;
        chrome.storage.local.set({isIntercepting:false});
        // Auto-forward everything still in queue
        for (const [rid, p] of interceptedQueue) {
          try { await chrome.debugger.sendCommand({tabId:p.tabId},"Fetch.continueRequest",{requestId:rid}); } catch(_){}
          interceptedQueue.delete(rid);
        }
        if (tabs[0]) await disableFetch(tabs[0].id);
        // Detach if also not recording
        if (tabs[0] && !isRecording) await detachDebugger(tabs[0].id);
        sendResponse({success:true});
      });
      return true;

    case "FORWARD_REQUEST":    forwardRequest(msg.requestId).then(sendResponse);  return true;
    case "MODIFY_AND_SEND":    modifyAndSend(msg.requestId,msg.modifications).then(sendResponse); return true;
    case "BLOCK_REQUEST":      blockRequest(msg.requestId).then(sendResponse);    return true;
    case "DUPLICATE_REQUEST":  duplicateRequest(msg.requestId).then(sendResponse);return true;

    case "GET_REQUESTS":    getAllRequests().then(requests   =>sendResponse({requests}));    return true;
    case "GET_INTERCEPTED": getIntercepted().then(intercepted=>sendResponse({intercepted})); return true;
    case "CLEAR_REQUESTS":  clearRequests().then(()=>sendResponse({success:true}));          return true;
    case "CLEAR_INTERCEPTED": clearIntercepted().then(()=>sendResponse({success:true}));     return true;

    case "GET_QUEUE":
      sendResponse({queue:[...interceptedQueue.values()]});
      return true;

    case "GET_STATUS":
      chrome.storage.local.get(["isRecording","isIntercepting"], (s) => {
        sendResponse({
          isRecording:    !!s.isRecording,
          isIntercepting: !!s.isIntercepting,
          attachedTabs:   [...attachedTabs],
          queueLength:    interceptedQueue.size
        });
      });
      return true;

    case "REPLAY_REQUEST":
      replayRequest(msg.request.url,msg.request.method,msg.request.headers,msg.request.body)
        .then(result=>sendResponse({success:true,result}))
        .catch(err  =>sendResponse({success:false,error:err.message}));
      return true;
  }
});

console.log("[Inspectly] Background service worker v2.1 ready.");
