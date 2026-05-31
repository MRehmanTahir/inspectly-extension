# Inspectly v2.0

> **Professional network monitoring, request interception, replay, and browser storage inspection — all in one Chrome Extension.**

Inspectly is a Manifest V3 Chrome Extension that gives developers a DevTools-grade inspector directly in the browser popup. It covers HTTP traffic capture, real-time request interception and modification, Cache Storage, localStorage, sessionStorage, and IndexedDB.

---

## 📁 Project Structure

```
inspectly/
├── manifest.json          MV3 extension configuration
├── background.js          Service worker: Debugger API + interception engine + replay
├── content.js             Page script: form interception + storage readers
├── popup.html             All UI screens: dashboard, requests, intercept, storage views, modals
├── popup.js               Full UI controller: navigation, recording, interception, storage
├── styles.css             Complete dark/light theme (Inter + JetBrains Mono)
├── icons/
│   ├── logo.png           Source logo (1024×1024)
│   ├── icon16.png         Toolbar icon
│   ├── icon48.png         Extensions page icon
│   └── icon128.png        Web Store / large icon
├── README.md              ← You are here
└── GUIDE.md               Technical architecture deep-dive
```

---

## 🛠️ Project Setup

### 1. Create & open the folder

```bash
mkdir inspectly
cd inspectly
code .
```

Or open VS Code manually: **File → Open Folder** → select `inspectly/`

---

## 🚀 Load the Extension in Chrome

1. Open **Google Chrome** (or Edge / Brave)
2. Navigate to `chrome://extensions`
3. Enable **Developer Mode** (toggle top-right)
4. Click **"Load unpacked"**
5. Select the `inspectly/` folder
6. The Inspectly icon appears in your toolbar

> **First-run note:** Chrome shows a warning about the Debugger API — click **Keep**. This is expected for developer tools using `chrome.debugger`.

---

## 🐛 Debugging

### Background Service Worker
1. Go to `chrome://extensions`
2. Find Inspectly → click **"Inspect service worker"**
3. DevTools opens showing `background.js` console logs
4. All messages are prefixed `[Inspectly]`

### Popup UI
- Right-click the Inspectly toolbar icon → **Inspect**

### Content Script
- Open DevTools on any tab → Console — content script messages appear alongside page logs

---

## 🔄 Development Workflow

1. Edit files in VS Code and save
2. Go to `chrome://extensions`
3. Click **↻ Reload** on the Inspectly card
4. Reopen the popup to see your changes

> **Tip:** Pin Inspectly to the toolbar for faster access during development.

---

## 📦 Export as ZIP

**Windows:**
```
Right-click inspectly/ → Send to → Compressed (zipped) folder
```

**macOS / Linux:**
```bash
zip -r inspectly.zip inspectly/ -x "*.DS_Store" -x "__MACOSX/*"
```

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

## 🗺️ Features

| Feature                  | Description |
|--------------------------|-------------|
| **Request Capturing**    | Record/Stop with live timer, captures fetch, XHR, form submissions |
| **Request Interception** | Pause requests, edit URL/headers/body/params, forward/modify/block/duplicate |
| **Request Replay**       | Re-send any request with editable fields, see live response |
| **Cache Monitoring**     | Browse all Service Worker Cache Storage caches |
| **Local Storage**        | Inspect localStorage key-value pairs |
| **Session Storage**      | Inspect sessionStorage (tab-scoped) |
| **IndexedDB**            | Browse databases, object stores, and records |
| **Export JSON**          | Download all captured requests as `.json` |
| **Dark / Light Mode**    | Auto-detected from OS preference |
| **5000 Request Cap**     | Oldest auto-pruned when limit reached |

---

## 🔒 Privacy & Security

- **Zero external requests** — all data stays on your machine
- **No analytics, no telemetry, no tracking**
- Storage via `chrome.storage.local` only
- Intercepted requests never leave the browser

---

## 📄 License

MIT — free to use, modify, and distribute.

---

## 👤 Author

**Muhammad Rehman Tahir** — Software Engineer  
[GitHub](https://github.com/MRehmanTahir) · [LinkedIn](https://www.linkedin.com/in/muhammad-rehman-tahir/) · [NuGet](https://www.nuget.org/profiles/Muhammad_Rehman_Tahir)
