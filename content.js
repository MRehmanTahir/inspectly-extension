/**
 * Inspectly — Content Script (content.js)
 * ─────────────────────────────────────────
 * Injected into every page at document_start.
 *
 * Responsibilities:
 *   • Intercept HTML form submissions
 *   • Read localStorage, sessionStorage, CacheStorage, IndexedDB on demand
 *   • Relay all data back to popup via chrome.runtime messaging
 */

"use strict";

// ─── Form Submission Capture ──────────────────────────────────────────────────

document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!form || form.tagName !== "FORM") return;
  const body = {};
  new FormData(form).forEach((v, k) => { body[k] = v; });
  chrome.runtime.sendMessage({
    type:  "FORM_SUBMIT",
    entry: {
      id:             `form-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      url:            form.action || window.location.href,
      method:         (form.method || "GET").toUpperCase(),
      requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
      requestBody:    new URLSearchParams(body).toString(),
      type:           "Form",
      status:         null,
      duration:       null,
      capturedAt:     Date.now()
    }
  }).catch(() => {});
}, true);

// ─── Storage Inspection Message Handler ──────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    // ── localStorage ─────────────────────────────────────────────────────────
    case "GET_LOCAL_STORAGE": {
      try {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          data[k] = localStorage.getItem(k);
        }
        sendResponse({ success: true, data, count: localStorage.length });
      } catch (e) {
        sendResponse({ success: false, error: e.message, data: {}, count: 0 });
      }
      return true;
    }

    // ── sessionStorage ────────────────────────────────────────────────────────
    case "GET_SESSION_STORAGE": {
      try {
        const data = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          data[k] = sessionStorage.getItem(k);
        }
        sendResponse({ success: true, data, count: sessionStorage.length });
      } catch (e) {
        sendResponse({ success: false, error: e.message, data: {}, count: 0 });
      }
      return true;
    }

    // ── CacheStorage ──────────────────────────────────────────────────────────
    case "GET_CACHE_STORAGE": {
      (async () => {
        try {
          const names  = await caches.keys();
          const result = {};
          for (const name of names) {
            const cache = await caches.open(name);
            const reqs  = await cache.keys();
            result[name] = reqs.map(r => ({ url: r.url, method: r.method }));
          }
          sendResponse({ success: true, data: result, count: names.length });
        } catch (e) {
          sendResponse({ success: false, error: e.message, data: {}, count: 0 });
        }
      })();
      return true;
    }

    // ── IndexedDB ─────────────────────────────────────────────────────────────
    case "GET_INDEXEDDB": {
      (async () => {
        try {
          const dbs    = await indexedDB.databases();
          const result = {};
          for (const { name } of dbs) {
            const db = await new Promise((res, rej) => {
              const r = indexedDB.open(name);
              r.onsuccess = () => res(r.result);
              r.onerror   = () => rej(r.error);
            });
            result[name] = { version: db.version, stores: {} };
            for (const storeName of db.objectStoreNames) {
              const records = await new Promise(res => {
                try {
                  const tx  = db.transaction(storeName, "readonly");
                  const req = tx.objectStore(storeName).getAll(null, 50);
                  req.onsuccess = () => res(req.result);
                  req.onerror   = () => res([]);
                } catch (_) { res([]); }
              });
              result[name].stores[storeName] = records;
            }
            db.close();
          }
          sendResponse({ success: true, data: result, count: dbs.length });
        } catch (e) {
          sendResponse({ success: false, error: e.message, data: {}, count: 0 });
        }
      })();
      return true;
    }

    // ── Cookies (document.cookie, JS-accessible only) ─────────────────────────
    case "GET_COOKIES": {
      try {
        const cookies = document.cookie.split(";").reduce((acc, pair) => {
          const [k, ...v] = pair.trim().split("=");
          if (k) acc[decodeURIComponent(k)] = decodeURIComponent(v.join("=") || "");
          return acc;
        }, {});
        sendResponse({ success: true, data: cookies, count: Object.keys(cookies).length });
      } catch (e) {
        sendResponse({ success: false, error: e.message, data: {}, count: 0 });
      }
      return true;
    }

  }
});
