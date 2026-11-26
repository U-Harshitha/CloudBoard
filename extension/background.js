// CloudBoard extension background worker.
//
//  • Ctrl+Alt+C (content script) / Alt+Shift+C / context menu → send selection to CloudBoard
//  • Ctrl+Shift+1 (can be made global) → send clipboard
//  • Ctrl+Alt+V (content script) → insert the latest cloud clip into the focused field
//  • Web push from the server → new clip is written to the system clipboard

import { WEB_APP_URL, APP_ORIGINS } from "./config.js";

const DEFAULTS = { autoCopy: true, notify: true };

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function getState() {
  const s = await chrome.storage.local.get(["token", "apiBase", "deviceId", "deviceName", "account", "autoCopy", "notify"]);
  if (!s.deviceId) {
    s.deviceId = "ext-" + crypto.randomUUID();
    s.deviceName = await defaultDeviceName();
    await chrome.storage.local.set({ deviceId: s.deviceId, deviceName: s.deviceName });
  }
  return { ...DEFAULTS, ...s };
}

async function defaultDeviceName() {
  const info = await chrome.runtime.getPlatformInfo().catch(() => ({}));
  const os = { win: "Windows", mac: "Mac", linux: "Linux", cros: "ChromeOS" }[info.os] || "Computer";
  const browser = /Edg\//.test(navigator.userAgent) ? "Edge" : "Chrome";
  return `${os} · ${browser}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, { method = "GET", body, raw = false } = {}) {
  const s = await getState();
  if (!s.token) throw new Error("Not connected. Open CloudBoard and click “Connect this browser”.");
  const res = await fetch(`${s.apiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${s.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    await chrome.storage.local.remove(["token", "account"]);
    updateBadge();
    throw new Error("This browser was disconnected from CloudBoard. Connect it again from the web app.");
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function sendClip(text) {
  if (!text || !text.trim()) throw new Error("Nothing selected or copied");
  const s = await getState();
  await api("/clips", { method: "POST", body: { text, deviceId: s.deviceId, deviceName: s.deviceName, deviceType: "extension" } });
}

async function latestClip() {
  const res = await api("/clips/latest?format=json", { raw: true });
  if (res.status === 404) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Couldn't fetch the latest clip");
  return data;
}

// ---------------------------------------------------------------------------
// Clipboard (via offscreen document)
// ---------------------------------------------------------------------------

let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({ url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "Sync clipboard text with your other devices" })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

async function writeClipboard(text) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "write", text });
  return !!(res && res.ok);
}

async function readClipboard() {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "read" });
  return (res && res.text) || "";
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon-128.png", title, message: message || "", priority: 0 });
}

function preview(text, n = 120) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

async function updateBadge() {
  const { token } = await chrome.storage.local.get("token");
  chrome.action.setBadgeBackgroundColor({ color: "#d43c4c" });
  chrome.action.setBadgeText({ text: token ? "" : "!" });
  chrome.action.setTitle({ title: token ? "CloudBoard" : "CloudBoard: not connected" });
}

async function flashBadge(text, color = "#138a5b") {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(updateBadge, 1800);
}

// ---------------------------------------------------------------------------
// Pairing & push subscription
// ---------------------------------------------------------------------------

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);

async function putDevice(subscription) {
  const s = await getState();
  const info = await chrome.runtime.getPlatformInfo().catch(() => ({}));
  await api(`/devices/${encodeURIComponent(s.deviceId)}`, {
    method: "PUT",
    body: { name: s.deviceName, type: "extension", platform: info.os || "", subscription: subscription ? subscription.toJSON() : null },
  });
}

async function subscribePush() {
  const s = await getState();
  const cfg = await fetch(`${s.apiBase}/config`).then((r) => r.json());
  const key = urlB64ToUint8Array(cfg.vapidPublicKey);
  const opts = (userVisibleOnly) => ({ userVisibleOnly, applicationServerKey: key });
  try {
    // Chrome 121+ lets extensions receive silent pushes.
    return await withTimeout(self.registration.pushManager.subscribe(opts(false)), 30000);
  } catch (err) {
    if (/timed out/.test(err.message)) throw err;
    return await withTimeout(self.registration.pushManager.subscribe(opts(true)), 30000);
  }
}

/**
 * Register this browser with the server. The device record is saved right away;
 * the push subscription (which can take a while) is added when it's ready.
 */
async function registerDevice({ waitForPush = true } = {}) {
  const s = await getState();
  if (!s.token) return;
  const existing = await self.registration.pushManager.getSubscription().catch(() => null);
  await putDevice(existing);
  if (existing) return;
  const finish = subscribePush()
    .then((sub) => putDevice(sub))
    .catch((err) => console.warn("CloudBoard: push subscription failed", err));
  if (waitForPush) await finish;
}

async function link(token, origin) {
  if (!APP_ORIGINS.includes(origin)) throw new Error(`Pairing is only allowed from ${WEB_APP_URL}. Update extension/config.js if your app lives elsewhere.`);
  if (!/^cb_[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Invalid key");
  await chrome.storage.local.set({ token, apiBase: `${origin}/api` });
  try {
    const me = await api("/me");
    await chrome.storage.local.set({ account: { email: me.email, name: me.name, photoURL: me.photoURL } });
    await registerDevice({ waitForPush: false });
  } catch (err) {
    await chrome.storage.local.remove(["token", "apiBase", "account"]);
    throw err;
  }
  updateBadge();
}

async function unlink() {
  const s = await getState();
  if (s.token) await api(`/devices/${encodeURIComponent(s.deviceId)}`, { method: "DELETE" }).catch(() => {});
  const sub = await self.registration.pushManager.getSubscription().catch(() => null);
  if (sub) await sub.unsubscribe().catch(() => {});
  await chrome.storage.local.remove(["token", "account"]);
  updateBadge();
}

// ---------------------------------------------------------------------------
// Incoming clips
// ---------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch (_) {}
      if (data.type !== "clip") return;
      const s = await getState();
      if (data.deviceId === s.deviceId) return;

      let text = data.text || "";
      if (data.truncated) {
        const full = await api(`/clips/${encodeURIComponent(data.id)}`).catch(() => null);
        if (full) text = full.text;
      }
      const from = data.deviceName || "another device";
      if (s.autoCopy && text) {
        const ok = await writeClipboard(text).catch(() => false);
        if (s.notify) notify(ok ? `Copied from ${from}` : `New clip from ${from}`, preview(text));
        if (ok) flashBadge("✓");
      } else if (s.notify) {
        notify(`New clip from ${from}`, preview(text) + "\nOpen CloudBoard to copy it.");
      }
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(registerDevice().catch(() => {}));
});

// ---------------------------------------------------------------------------
// Sending: shortcuts, context menu, messages
// ---------------------------------------------------------------------------

async function cloudCopy(text, { source = "selection" } = {}) {
  let payload = text;
  if (!payload || !payload.trim()) payload = await readClipboard();
  await sendClip(payload);
  flashBadge("↑");
  return { ok: true, preview: preview(payload, 60), source: text && text.trim() ? source : "clipboard" };
}

async function selectionInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return "";
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const a = document.activeElement;
        if (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && /^(text|search|url|email|tel)$/i.test(a.type))) && a.selectionStart !== a.selectionEnd) {
          return a.value.slice(a.selectionStart, a.selectionEnd);
        }
        return String(window.getSelection() || "");
      },
    });
    return (results.find((r) => r.result && r.result.trim()) || {}).result || "";
  } catch (_) {
    return ""; // chrome:// pages, the Web Store, PDF viewer…
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "cloud-copy") {
      const r = await cloudCopy(await selectionInActiveTab());
      const s = await getState();
      if (s.notify) notify(r.source === "clipboard" ? "Clipboard sent to CloudBoard" : "Sent to CloudBoard", r.preview);
    } else if (command === "send-clipboard") {
      const r = await cloudCopy("");
      const s = await getState();
      if (s.notify) notify("Clipboard sent to CloudBoard", r.preview);
    }
  } catch (err) {
    notify("CloudBoard", err.message);
    flashBadge("!", "#d43c4c");
  }
});

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "cloudboard-send", title: "Send to CloudBoard", contexts: ["selection", "link", "image"] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  const text = info.selectionText || info.linkUrl || info.srcUrl || "";
  try {
    await sendClip(text);
    flashBadge("↑");
  } catch (err) {
    notify("CloudBoard", err.message);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return;
  const senderOrigin = sender.origin || (sender.url ? new URL(sender.url).origin : "");
  const handlers = {
    "cloud-copy": () => cloudCopy(msg.text),
    "cloud-paste": async () => {
      const clip = await latestClip();
      if (!clip) throw new Error("No clips yet");
      return { ok: true, text: clip.text, from: clip.deviceName };
    },
    "is-app-origin": async () => {
      const { token } = await chrome.storage.local.get("token");
      return { isApp: APP_ORIGINS.includes(senderOrigin), linked: !!token };
    },
    link: async () => {
      await link(msg.token, senderOrigin);
      return { ok: true };
    },
    // Popup actions
    status: async () => {
      const s = await getState();
      return { linked: !!s.token, account: s.account || null, deviceName: s.deviceName, autoCopy: s.autoCopy, notify: s.notify, webAppUrl: s.apiBase ? s.apiBase.replace(/\/api$/, "") : WEB_APP_URL };
    },
    recent: async () => ({ clips: (await api("/clips?limit=8")).clips }),
    "send-clipboard": () => cloudCopy(""),
    "send-text": async () => {
      await sendClip(msg.text);
      return { ok: true };
    },
    settings: async () => {
      const patch = {};
      if (typeof msg.autoCopy === "boolean") patch.autoCopy = msg.autoCopy;
      if (typeof msg.notify === "boolean") patch.notify = msg.notify;
      if (typeof msg.deviceName === "string" && msg.deviceName.trim()) patch.deviceName = msg.deviceName.trim().slice(0, 40);
      await chrome.storage.local.set(patch);
      if (patch.deviceName) await registerDevice().catch(() => {});
      return { ok: true };
    },
    unlink: async () => {
      await unlink();
      return { ok: true };
    },
  };
  const handler = handlers[msg.type];
  if (!handler) return;
  Promise.resolve()
    .then(handler)
    .then((r) => sendResponse(r || { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // async response
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  setupContextMenu();
  updateBadge();
  await registerDevice().catch(() => {});
  if (details.reason === "install") chrome.tabs.create({ url: `${WEB_APP_URL}/#devices` });
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  registerDevice().catch(() => {});
});
