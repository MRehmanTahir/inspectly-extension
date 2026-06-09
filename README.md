# Inspectly v3.0

> **Professional network monitoring, request interception, replay, analytics, and a full developer workspace — all in one Chrome Extension.**

Inspectly is a Manifest V3 Chrome Extension that gives developers a DevTools-grade inspector directly in the browser. Use it as a quick **popup**, or open the new **full-screen Professional Dashboard** with live metrics, a request waterfall, and analytics charts. It covers HTTP traffic capture, real-time request interception and modification, request replay, and all four browser storage types: Cache Storage, localStorage, sessionStorage, and IndexedDB.

---

## ⬇️ Download & Install (for users)

Inspectly is **not** published on the Chrome Web Store — you install it directly from the ZIP. No accounts, no build tools, no Node.js. It takes under a minute.

### 1. Download the ZIP

Grab **`inspectly.zip`** from this folder (or from the [landing page](https://github.com/MRehmanTahir/inspectly-extension)).

### 2. Unzip it

- **Windows:** Right-click `inspectly.zip` → **Extract All…** → choose a folder you'll keep (e.g. `Documents\inspectly`).
- **macOS:** Double-click `inspectly.zip` — it extracts next to the file.
- **Linux:** `unzip inspectly.zip -d inspectly`

> ⚠️ Keep the unzipped folder somewhere permanent. If you delete or move it, Chrome will disable the extension.

### 3. Load it into Chrome

1. Open **Google Chrome** (or Edge / Brave / Opera).
2. Go to `chrome://extensions` in the address bar.
3. Turn on **Developer Mode** (toggle, top-right).
4. Click **Load unpacked**.
5. Select the **unzipped `inspectly` folder** (the one containing `manifest.json`).
6. The Inspectly icon appears in your toolbar — click 📌 to pin it.

> **First-run note:** When you start recording, Chrome shows a warning bar that says *"Inspectly started debugging this browser."* This is normal and required — Inspectly uses the same Chrome Debugger API that DevTools uses. Just leave the bar open while you work.

### 4. You're ready

Click the Inspectly icon → press **Record** → browse. Requests stream in live. Open the full **Dashboard** from the popup for the complete workspace.

---

## 🚀 Quick Start

| Goal | Steps |
|------|-------|
| **Capture network traffic** | Open popup → **Request Capturing** → **Record** → browse → **Stop** |
| **Open the full workspace** | Open popup → **Open Dashboard** (new tab) / **Popout Window** / **Full Screen** |
| **Intercept a request** | Dashboard/popup → **Intercept** → set URL pattern → **Enable Interception** → act on paused requests |
| **Replay a request** | Click any captured request → **Replay** tab → edit fields → **Send Replay** |
| **Inspect storage** | Dashboard → **Storage** → switch between Local / Session / Cache / IndexedDB |

---

## 🖥️ The v3 Professional Dashboard

New in v3 — open Inspectly beyond the popup in three modes:

- **Open Dashboard** — full page in a new browser tab
- **Popout Window** — detached resizable window that floats over your app
- **Full Screen** — maximized workspace

The dashboard has a collapsible sidebar with five workspaces:

| Workspace | What it shows |
|-----------|---------------|
| **Overview** | 8 live metric cards (total, errors, avg time, slow, active, failed, domains, session duration), a live request timeline, status breakdown, top domains, and HTTP method split |
| **Requests** | Sortable/searchable request table with domain column and All / XHR / Fetch / Errors / Slow filters; click any row for a detail side-panel |
| **Waterfall** | DevTools-style timing waterfall — waiting vs. receiving bars on a shared timeline ruler |
| **Analytics** | Response-time distribution chart, status-code pie chart, requests-per-domain bars, HTTP-method bars, and a slowest-requests table |
| **Intercept** | Live interception queue + history with the full edit modal |
| **Storage** | Tabbed Local / Session / Cache / IndexedDB browser with refresh |

---

## 🗺️ Features

| Feature                   | Description |
|---------------------------|-------------|
| **Request Capturing**     | Record/Stop with live timer; captures fetch, XHR, and form submissions with full headers, body, status, and timing |
| **Professional Dashboard**| Full-screen / popout / new-tab workspace with sidebar navigation *(new in v3)* |
| **Live Overview Metrics** | 8 real-time metric cards + live request timeline and breakdowns *(new in v3)* |
| **Request Waterfall**     | Visual timing waterfall of all captured requests *(new in v3)* |
| **Analytics Charts**      | Response-time distribution, status-code pie, per-domain & per-method bars, slowest-requests table *(new in v3)* |
| **Request Interception**  | Pause requests, edit URL/headers/body/params, then Forward / Modify / Block / Duplicate |
| **Request Replay**        | Re-send any request with editable fields and see the live response inline |
| **Cache Monitoring**      | Browse all Service Worker Cache Storage caches |
| **Local Storage**         | Inspect localStorage key-value pairs |
| **Session Storage**       | Inspect sessionStorage (tab-scoped) |
| **IndexedDB**             | Browse databases, object stores, and records — tree view or table view with column picker |
| **Search & Filter**       | Real-time search with method/type/error/slow filter pills |
| **Export JSON**           | Download all captured requests as a structured `.json` file |
| **Dark / Light Mode**     | Auto-detected from OS preference, with manual toggle in the dashboard |
| **5000 Request Cap**      | Oldest requests auto-pruned when the limit is reached |

---

## 📁 What's in the folder

```
inspectly/
├── manifest.json          MV3 extension configuration (v3.0.0)
├── background.js          Service worker: Debugger API + interception engine + replay
├── content.js             Page script: form interception + storage readers
├── popup.html / popup.js  Compact toolbar popup UI
├── dashboard.html         Full professional dashboard (new tab / window / fullscreen)
├── dashboard.js           Dashboard controller: overview, waterfall, analytics, intercept, storage
├── dashboard.css          Dashboard theme
├── styles.css             Popup theme (dark/light, Inter + JetBrains Mono)
├── icons/                 Toolbar / store icons (16, 48, 128) + source logo
├── README.md              ← You are here
└── GUIDE.md               Technical architecture deep-dive
```

---

## 🔧 Updating to a new version

1. Download the new `inspectly.zip` and unzip it (replace your old folder).
2. Go to `chrome://extensions`.
3. Click **↻ Reload** on the Inspectly card.

---

## ✅ Browser Compatibility

| Browser     | Supported |
|-------------|-----------|
| Chrome 88+  | ✅        |
| Edge 88+    | ✅        |
| Brave       | ✅        |
| Opera       | ✅        |
| Firefox     | ❌ (no Chrome Debugger API) |

---

## 🐛 Troubleshooting

| Problem | Fix |
|---------|-----|
| **"Cannot attach debugger"** | Close Chrome DevTools on that tab — only one debugger can attach at a time. |
| **Extension disabled after restart** | You moved/deleted the unzipped folder. Re-add it via **Load unpacked**. |
| **Nothing captured on a page** | `chrome://`, the Web Store, and other built-in pages can't be debugged. Try a normal website. |
| **Doesn't work in Incognito** | Enable it at `chrome://extensions` → Inspectly → **Allow in Incognito**. |
| **Recording paused briefly** | MV3 service workers can sleep when idle; state is restored automatically on the next event. |

---

## 🔒 Privacy & Security

- **Zero external requests** — all data stays on your machine
- **No analytics, no telemetry, no tracking**
- Storage via `chrome.storage.local` only
- Intercepted and replayed requests never leave the browser

---

## 📄 License

MIT — free to use, modify, and distribute.

---

## 👤 Author

**Muhammad Rehman Tahir** — Software Engineer  
[GitHub](https://github.com/MRehmanTahir) · [LinkedIn](https://www.linkedin.com/in/muhammad-rehman-tahir/) · [NuGet](https://www.nuget.org/profiles/Muhammad_Rehman_Tahir)
