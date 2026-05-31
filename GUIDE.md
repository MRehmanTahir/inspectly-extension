# Inspectly v2.0 — Technical Guide

Complete technical reference for the architecture, internals, and design decisions of Inspectly.

---

## 1. Architecture Overview

```
┌───────────────────────────────────────────────────────────┐
│                     Chrome Browser Tab                     │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                content.js (injected)                 │  │
│  │  • Intercepts form submit events                     │  │
│  │  • Reads localStorage / sessionStorage               │  │
│  │  • Reads CacheStorage via caches API                 │  │
│  │  • Reads IndexedDB via indexedDB.databases()         │  │
│  │  • Responds to popup messages via onMessage          │  │
│  └────────────────────────┬────────────────────────────┘  │
└───────────────────────────│───────────────────────────────┘
                            │ chrome.tabs.sendMessage
                            ▼
┌───────────────────────────────────────────────────────────┐
│           background.js  (MV3 Service Worker)              │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Chrome Debugger API — Network Domain            │    │
│  │  Network.requestWillBeSent → capture metadata    │    │
│  │  Network.responseReceived  → capture status      │    │
│  │  Network.loadingFinished   → getResponseBody     │    │
│  │  Network.loadingFailed     → log error           │    │
│  └──────────────────────────────────────────────────┘    │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Chrome Debugger API — Fetch Domain              │    │
│  │  Fetch.enable  → enable interception             │    │
│  │  Fetch.requestPaused → hold request in queue     │    │
│  │  Fetch.continueRequest → forward / modify        │    │
│  │  Fetch.failRequest     → block / drop            │    │
│  └──────────────────────────────────────────────────┘    │
│                                                           │
│  pendingRequests Map  (in-memory, requestId → record)     │
│  interceptedQueue Map (in-memory, requestId → paused)     │
│                                                           │
│  chrome.storage.local                                     │
│    requests[]    — up to 5000, auto-pruned               │
│    intercepted[] — up to 1000, auto-pruned               │
│    isRecording, isIntercepting (persisted state)         │
│                                                           │
│  Message Router: START/STOP_RECORDING, START/STOP_        │
│  INTERCEPTING, FORWARD, MODIFY_AND_SEND, BLOCK,          │
│  DUPLICATE, GET_*, CLEAR_*, REPLAY_REQUEST                │
└──────────────────────────┬────────────────────────────────┘
                           │ chrome.runtime.sendMessage
                           ▼
┌───────────────────────────────────────────────────────────┐
│              popup.html + popup.js                         │
│                                                           │
│  Dashboard → 6 feature views                              │
│  Request view: record/stop/timer, table, detail modal     │
│  Intercept view: live queue, history, edit modal          │
│  Storage views: cache, localStorage, sessionStorage, IDB  │
└───────────────────────────────────────────────────────────┘
```

---

## 2. How Request Capturing Works

### Mechanism
Inspectly uses the **Chrome DevTools Protocol (CDP)** via `chrome.debugger`. This is the same protocol that Chrome DevTools uses internally. Attaching the debugger gives full access to all network traffic — including POST bodies and binary response bodies.

### Attach Flow
```
User clicks Record
      │
chrome.debugger.attach({ tabId }, "1.3")
      │
chrome.debugger.sendCommand → "Network.enable" (with buffer limits)
      │
chrome.debugger.onEvent listener fires for every network event
```

### 3-Event Assembly Pattern

Each HTTP request fires three sequential CDP events that must be stitched together:

| Event | Data Captured |
|---|---|
| `Network.requestWillBeSent` | URL, method, headers, POST body, start timestamp |
| `Network.responseReceived`  | Status code, response headers, MIME type, end timestamp |
| `Network.loadingFinished`   | Triggers `getResponseBody` call, final duration calc |

Requests are assembled in a `Map<requestId, partialRecord>` until `loadingFinished` fires, then persisted. Using a Map ensures concurrent requests (different `requestId` values) are correctly assembled regardless of event ordering.

### Response Body Retrieval
```js
const body = await chrome.debugger.sendCommand(
  { tabId }, "Network.getResponseBody", { requestId }
);
// body.base64Encoded: true for binary content
req.responseBody = body.base64Encoded ? atob(body.body) : body.body;
```

This must be called **immediately in `loadingFinished`** — Chrome flushes the buffer shortly after.

---

## 3. How Request Interception Works

### Architecture
Interception uses the **Fetch Domain** of CDP (`Fetch.enable` / `Fetch.requestPaused`), which runs at a lower level than the Network Domain and can actually hold and modify requests before they leave the browser.

### Intercept Flow
```
User clicks "Enable Interception"
      │
chrome.debugger.sendCommand → "Fetch.enable" with URL patterns
      │
Browser fires Fetch.requestPaused for each matching request
      │
background.js adds request to interceptedQueue Map
      │
broadcastToPopup({ type: "REQUEST_PAUSED", request })
      │
popup.js renders request in Live Queue with action buttons
      │
User chooses: Forward / Modify & Send / Block / Duplicate
      │
background.js calls appropriate Fetch command:
  • Forward     → Fetch.continueRequest (no changes)
  • Modify      → Fetch.continueRequest (with url/method/headers/body overrides)
  • Block       → Fetch.failRequest (errorReason: "BlockedByClient")
  • Duplicate   → Fetch.continueRequest (original) + fetch() copy
```

### Modifiable Fields
When using **Modify & Send**, the following can be changed:
- Full URL (including query parameters via the param editor)
- HTTP Method
- All request headers (as JSON)
- Request body / JSON payload
- Content-Type header

### Forbidden Headers
Browsers block certain headers from being set manually. Inspectly automatically strips these before sending:
```
host, content-length, connection, transfer-encoding, upgrade,
te, trailer, keep-alive, proxy-authorization, proxy-authenticate
```

---

## 4. How Request Replay Works

Replay runs entirely in the background service worker context — separate from any page — using native `fetch()`.

```
popup.js → REPLAY_REQUEST message → background.js
      │
replayRequest(url, method, headers, body)
      │
fetch() with sanitized headers
      │
Returns: { status, statusText, responseHeaders, responseBody, duration }
      │
popup.js renders result in modal Replay tab
```

**Why use the background context?**
Service workers have `<all_urls>` host permissions and are not subject to the same same-origin CORS restrictions as popup windows — giving much wider replay coverage.

---

## 5. Storage System (5000 Request Cap)

### Implementation
`chrome.storage.local` is used as the persistence layer (up to 10 MB). All data is stored as JSON under two keys: `"requests"` and `"intercepted"`.

### Auto-Prune Logic
```js
async function persistRequest(req) {
  chrome.storage.local.get(["requests"], ({ requests = [] }) => {
    if (requests.length >= MAX_REQUESTS) {
      // Remove oldest entries from the front of the array
      requests = requests.slice(requests.length - (MAX_REQUESTS - 1));
    }
    requests.push(req);  // Newest appended at end
    chrome.storage.local.set({ requests });
  });
}
```

- `"requests"` cap: **5000** records
- `"intercepted"` cap: **1000** records
- Pruning: oldest entries sliced off the front when cap is reached
- The popup reverses the array for display (newest first)

### Persisted State
```js
chrome.storage.local.set({ isRecording: true, isIntercepting: true });
```

Recording and interception state survive popup close/reopen. The popup restores this state on `init()`.

---

## 6. Storage Monitoring — Content Script Bridge

All storage reads happen in `content.js` (injected into the active page), because storage APIs are origin-scoped to the page:

| API | Scope |
|---|---|
| `localStorage` | Origin (protocol + hostname + port) |
| `sessionStorage` | Origin + tab session |
| `caches` (CacheStorage) | Origin |
| `indexedDB` | Origin |

### Message Flow
```
popup.js
  → chrome.tabs.sendMessage(tabId, { type: "GET_LOCAL_STORAGE" })
content.js (running in page context)
  → reads localStorage
  → sendResponse({ success: true, data: {...}, count: N })
popup.js
  → renders KV table
```

### IndexedDB Depth Limit
Each object store is capped at **50 records** via `store.getAll(null, 50)` to avoid hanging on large databases. The schema (database names, store names, version) is always fully shown.

---

## 7. Known Limitations

| Limitation | Details |
|---|---|
| **DevTools conflict** | Only one debugger per tab. Close Chrome DevTools before using Inspectly's recording/interception. |
| **CORS on replay** | Replayed requests originate from the extension context (null origin). APIs enforcing strict CORS may reject them. |
| **chrome:// pages** | Debugger cannot attach to `chrome://`, `chrome-extension://`, or built-in browser pages. |
| **Service Worker lifecycle** | MV3 service workers can be terminated by Chrome when idle. Recording state is persisted and restored, but capture may pause briefly during a worker restart. |
| **Response body size** | Very large (>10MB) or streaming responses may return empty body from `getResponseBody`. |
| **WebSockets / SSE** | Only the initial HTTP handshake is logged. WebSocket frames and SSE events are not captured. |
| **Incognito** | Enable via `chrome://extensions` → Inspectly → Allow in Incognito. |
| **IndexedDB.databases()** | Not available in all browsers. Gracefully falls back with a try/catch. |
| **Fetch interception scope** | `Fetch.enable` intercepts requests made by the page. Requests from service workers or extensions themselves are not intercepted. |

---

## 8. File Responsibilities

| File | Responsibility |
|---|---|
| `manifest.json` | Declares permissions, entry points, icons, content scripts |
| `background.js` | CDP attach/detach, Network + Fetch domains, storage write, replay, message router |
| `content.js` | Form interception, localStorage/sessionStorage/Cache/IDB reads on demand |
| `popup.html` | All screen templates: dashboard, request table, intercept views, both modals |
| `popup.js` | Navigation, recording controls, table render, filter/search, intercept queue/history, storage loaders |
| `styles.css` | Full UI theme — light/dark, all components, animations |

---

## 9. Author

**Muhammad Rehman Tahir** — Software Engineer (ASP.NET Core, React, Azure)  
[GitHub](https://github.com/MRehmanTahir) · [LinkedIn](https://www.linkedin.com/in/muhammad-rehman-tahir/) · [NuGet](https://www.nuget.org/profiles/Muhammad_Rehman_Tahir)
