import { isConfigured } from "./firebase-config.js";

const params = new URLSearchParams(location.search);
const useDemo = !isConfigured || params.has("demo");
const { backend } = await import(useDemo ? "./backend-demo.js" : "./backend-firebase.js");

const $ = (sel) => document.querySelector(sel);
const MAX_TEXT = 50000;

// Tell the browser extension (if installed) that this page is the CloudBoard app,
// so it doesn't also handle Ctrl+Alt+C here.
document.documentElement.dataset.cloudboardApp = "1";

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

function detectDevice() {
  const ua = navigator.userAgent;
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isIPhone = /iPhone|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const platform = isIPad ? "iPad" : isIPhone ? "iPhone" : isAndroid ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const formFactor = isIPad || (isAndroid && !/Mobile/.test(ua)) ? "tablet" : isIPhone || isAndroid ? "phone" : "desktop";
  return { platform, browser, formFactor, isIOS: isIPad || isIPhone, isAndroid };
}

const env = detectDevice();
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

const device = (() => {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("cb.device") || "{}");
  } catch (_) {}
  const d = {
    id: saved.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
    name: saved.name || (env.formFactor === "desktop" ? `${env.platform} · ${env.browser}` : env.platform),
    type: env.formFactor,
    platform: env.platform,
  };
  persistDevice(d);
  return d;
})();

function persistDevice(d) {
  try {
    localStorage.setItem("cb.device", JSON.stringify({ id: d.id, name: d.name }));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function iconForType(type) {
  switch (type) {
    case "phone":
    case "android":
    case "iphone":
      return "phone";
    case "tablet":
    case "ipad":
      return "tablet";
    case "shortcut":
      return "bolt";
    case "extension":
      return "puzzle";
    default:
      return "laptop";
  }
}

function timeAgo(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

let toastTimer;
function toast(message, { error = false, ok = false } = {}) {
  const t = $("#toast");
  t.replaceChildren(...(ok ? [icon("check")] : []), document.createTextNode(message));
  t.classList.toggle("error", error);
  t.hidden = false;
  // restart animation
  t.style.animation = "none";
  void t.offsetHeight;
  t.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 4200 : 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = el("textarea", { style: "position:fixed;top:-1000px;opacity:0", readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_) {}
    ta.remove();
    return ok;
  }
}

const URL_RE = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;

function renderRichText(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(el("a", { href: m[0], target: "_blank", rel: "noopener noreferrer", onclick: (e) => e.stopPropagation() }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

const looksLikeCode = (t) => /^(?: {2,}|\t)\S|[{};]\s*$|=>|\b(?:const|let|function|import|def|class|return)\b/m.test(t) && !/^https?:\/\//.test(t.trim());

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  user: null,
  clips: null,
  devices: [],
  filter: "",
  seen: new Set(),
  pushOn: false,
  extension: document.documentElement.dataset.cloudboardExtension || null, // null | "ready" | "linked"
  unsubs: [],
};

// ---------------------------------------------------------------------------
// Auth & boot
// ---------------------------------------------------------------------------

if (backend.demo) $("#demo-banner").hidden = false;

$("#signin-btn").addEventListener("click", async () => {
  try {
    await backend.signIn();
  } catch (err) {
    toast(err.message || "Sign-in failed", { error: true });
  }
});
$("#signout-btn").addEventListener("click", () => backend.signOut());

backend.onAuth((user) => {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  state.user = user;
  $("#boot").hidden = true;
  $("#signin").hidden = !!user;
  $("#app").hidden = !user;
  if (!user) return;
  renderAccount();
  startApp();
});

function renderAccount() {
  const u = state.user;
  const btn = $("#account-btn");
  if (u.photoURL) {
    btn.style.backgroundImage = `url("${u.photoURL.replace(/"/g, "")}")`;
    btn.textContent = "";
  } else {
    btn.style.backgroundImage = "";
    btn.textContent = (u.name || u.email || "?").trim().charAt(0).toUpperCase();
  }
  $("#account-name").textContent = u.name || "Signed in";
  $("#account-email").textContent = u.email || "";
}

$("#account-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#account-menu").hidden = !$("#account-menu").hidden;
});
document.addEventListener("click", () => ($("#account-menu").hidden = true));

function startApp() {
  state.clips = null;
  renderClips();
  state.unsubs.push(
    backend.watchClips(
      (clips) => {
        const first = state.clips === null;
        state.clips = clips;
        renderClips(first);
      },
      (err) => toast(err.message, { error: true }),
    ),
  );
  state.unsubs.push(
    backend.watchDevices((devices) => {
      state.devices = devices;
      renderDevices();
    }),
  );
  backend.saveDevice(device).catch(() => {});
  initPush();
  handleIncomingIntents();
  route();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function route() {
  const tab = location.hash === "#devices" ? "devices" : "clips";
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $("#view-clips").hidden = tab !== "clips";
  $("#view-devices").hidden = tab !== "devices";
  if (tab === "devices") loadKeys();
}
window.addEventListener("hashchange", route);
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    history.replaceState(null, "", b.dataset.tab === "devices" ? "#devices" : location.pathname + location.search);
    route();
  }),
);

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

const input = $("#composer-input");
const sendBtn = $("#send-btn");

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 280) + "px";
  sendBtn.disabled = !input.value.trim();
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendComposer();
  }
});
sendBtn.addEventListener("click", sendComposer);

async function sendComposer() {
  const text = input.value;
  if (!text.trim()) return;
  if (await sendText(text)) {
    input.value = "";
    autosize();
  }
}

async function sendText(text, { quiet = false } = {}) {
  if (!text || !text.trim()) {
    toast("Nothing to send", { error: true });
    return false;
  }
  if (text.length > MAX_TEXT) {
    toast(`That's too long (max ${MAX_TEXT.toLocaleString()} characters)`, { error: true });
    return false;
  }
  try {
    await backend.addClip(text, device);
    if (!quiet) toast("Sent to your devices", { ok: true });
    return true;
  } catch (err) {
    toast(err.message || "Couldn't send", { error: true });
    return false;
  }
}

$("#paste-send-btn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return toast("Your clipboard is empty", { error: true });
    await sendText(text);
  } catch (_) {
    toast("Clipboard access was blocked. Paste into the box instead.", { error: true });
    input.focus();
  }
});

// Ctrl+Alt+C on this page: send the current selection (or the composer contents).
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyC") || !state.user) return;
  e.preventDefault();
  let text = "";
  const a = document.activeElement;
  if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && a.selectionStart !== a.selectionEnd) {
    text = a.value.slice(a.selectionStart, a.selectionEnd);
  } else {
    text = String(window.getSelection() || "");
  }
  if (!text.trim() && input.value.trim()) return sendComposer();
  sendText(text);
});

// ---------------------------------------------------------------------------
// Clip list
// ---------------------------------------------------------------------------

$("#search-input").addEventListener("input", (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  renderClips();
});

function renderClips(initial = false) {
  const list = $("#clip-list");
  if (state.clips === null) {
    list.replaceChildren(...[0, 1, 2].map(() => el("li", { class: "skeleton" })));
    $("#empty").hidden = true;
    $("#clip-count").textContent = "";
    return;
  }
  const clips = state.filter ? state.clips.filter((c) => c.text.toLowerCase().includes(state.filter)) : state.clips;
  $("#clip-count").textContent = state.clips.length ? String(state.clips.length) : "";
  $("#empty").hidden = state.clips.length > 0;
  list.replaceChildren(...clips.map((c) => clipItem(c, !initial && !state.seen.has(c.id))));
  if (state.filter && !clips.length && state.clips.length) {
    list.append(el("li", { class: "empty" }, el("p", { text: "No clips match your search." })));
  }
  state.clips.forEach((c) => state.seen.add(c.id));
}

function clipItem(clip, isNew) {
  const mine = clip.deviceId === device.id;
  const copyBtn = el("button", { class: "icon-btn copy-btn", "aria-label": "Copy", title: "Copy" }, icon("copy"));
  const doCopy = async (e) => {
    e && e.stopPropagation();
    if (window.getSelection && String(window.getSelection()).length) return; // user is selecting text
    if (await copyText(clip.text)) {
      copyBtn.classList.add("copied");
      copyBtn.replaceChildren(icon("check"));
      toast("Copied", { ok: true });
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.replaceChildren(icon("copy"));
      }, 1600);
    } else {
      toast("Couldn't copy", { error: true });
    }
  };
  copyBtn.addEventListener("click", doCopy);

  const del = el(
    "button",
    {
      class: "icon-btn delete",
      "aria-label": "Delete",
      title: "Delete",
      onclick: async (e) => {
        e.stopPropagation();
        try {
          await backend.deleteClip(clip.id);
        } catch (err) {
          toast(err.message, { error: true });
        }
      },
    },
    icon("trash"),
  );

  const textEl = el("p", { class: "clip-text" + (looksLikeCode(clip.text) ? " mono" : "") }, renderRichText(clip.text));
  const li = el(
    "li",
    { class: "clip" + (isNew ? " is-new" : ""), tabindex: "0", title: "Click to copy" },
    textEl,
    el(
      "div",
      { class: "clip-meta" },
      icon(iconForType(clip.deviceType)),
      mine ? el("span", { class: "you", text: "This device" }) : el("span", { text: clip.deviceName || "Unknown device" }),
      el("span", { class: "dot", text: "·" }),
      el("time", { "data-ts": clip.createdAt, text: timeAgo(clip.createdAt) }),
    ),
    el("div", { class: "clip-actions" }, del, copyBtn),
  );
  li.addEventListener("click", doCopy);
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doCopy(e);
  });
  li.addEventListener("dblclick", () => li.classList.toggle("expanded"));
  return li;
}

setInterval(() => {
  document.querySelectorAll("time[data-ts]").forEach((t) => (t.textContent = timeAgo(Number(t.dataset.ts))));
}, 30000);

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "copy-clip") handleCopyRequest(e.data);
  });
}

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function initPush() {
  const toggle = $("#notify-toggle");
  const iosNeedsInstall = env.isIOS && !standalone;
  $("#ios-install-hint").hidden = !iosNeedsInstall;

  if (pushSupported && Notification.permission === "granted" && !backend.demo) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        state.pushOn = true;
        backend.saveDevice(device, sub.toJSON()).catch(() => {}); // keep the server copy fresh
      }
    } catch (_) {}
  }
  if (backend.demo) state.pushOn = localStorage.getItem("cb.demoPush") === "1";
  renderPushState();

  const dismissed = localStorage.getItem("cb.notifyDismissed") === "1";
  const canOffer = pushSupported || iosNeedsInstall || backend.demo;
  $("#notify-banner").hidden = state.pushOn || dismissed || !canOffer;
  if (iosNeedsInstall) {
    $("#notify-banner-sub").textContent = "First add CloudBoard to your Home Screen: tap Share, then Add to Home Screen.";
    $("#notify-banner-btn").hidden = true;
  }
  toggle.disabled = !pushSupported && !backend.demo;
}

function renderPushState() {
  const toggle = $("#notify-toggle");
  toggle.setAttribute("aria-checked", String(state.pushOn));
  let status = state.pushOn ? "On. You'll get a popup for every new clip" : "Off";
  if (!pushSupported && !backend.demo) status = env.isIOS && !standalone ? "Add to Home Screen to enable" : "Not supported in this browser";
  else if (!backend.demo && pushSupported && Notification.permission === "denied") status = "Blocked in browser settings";
  $("#notify-status").textContent = status;
  if (state.pushOn) $("#notify-banner").hidden = true;
}

async function enablePush() {
  if (backend.demo) {
    state.pushOn = true;
    localStorage.setItem("cb.demoPush", "1");
    await backend.saveDevice(device, {});
    renderPushState();
    return toast("Demo: notifications on", { ok: true });
  }
  if (!pushSupported) return toast("This browser can't show notifications", { error: true });
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      renderPushState();
      return toast("Notifications were not allowed", { error: true });
    }
    const reg = await navigator.serviceWorker.ready;
    const key = await backend.vapidPublicKey();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) });
    await backend.saveDevice(device, sub.toJSON());
    state.pushOn = true;
    renderPushState();
    toast("Notifications on", { ok: true });
  } catch (err) {
    toast(err.message || "Couldn't enable notifications", { error: true });
  }
}

async function disablePush() {
  state.pushOn = false;
  renderPushState();
  if (backend.demo) {
    localStorage.removeItem("cb.demoPush");
    return backend.saveDevice(device, null);
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    await backend.saveDevice(device, null);
  } catch (_) {}
}

$("#notify-toggle").addEventListener("click", () => (state.pushOn ? disablePush() : enablePush()));
$("#notify-banner-btn").addEventListener("click", enablePush);
$("#notify-banner-close").addEventListener("click", () => {
  localStorage.setItem("cb.notifyDismissed", "1");
  $("#notify-banner").hidden = true;
});

// ---------------------------------------------------------------------------
// Notification taps, share target
// ---------------------------------------------------------------------------

async function handleIncomingIntents() {
  // Opened from a notification ("Copy" action or tap)
  const copyId = params.get("copy");
  if (copyId) {
    history.replaceState(null, "", "/" + location.hash);
    const clip = await backend.getClip(copyId).catch(() => null);
    if (clip) handleCopyRequest({ id: clip.id, text: clip.text, truncated: false, deviceName: clip.deviceName });
    else toast("That clip is no longer available", { error: true });
  }

  // Shared from another app (Android share sheet → CloudBoard)
  if (location.pathname === "/share") {
    const shared = [params.get("text"), params.get("url")].filter(Boolean).join(" ").trim() || params.get("title") || "";
    history.replaceState(null, "", "/");
    if (shared) {
      if (await sendText(shared, { quiet: true })) toast("Shared to your devices", { ok: true });
    }
  }
}

async function handleCopyRequest({ id, text, truncated, deviceName }) {
  let full = text;
  if (truncated || !full) {
    const clip = await backend.getClip(id).catch(() => null);
    if (clip) full = clip.text;
  }
  if (!full) return;
  // Chrome on Android/desktop usually allows this right after a notification tap.
  // Safari needs a real tap, so fall back to the copy sheet.
  let ok = false;
  try {
    if (document.hasFocus()) {
      await navigator.clipboard.writeText(full);
      ok = true;
    }
  } catch (_) {}
  if (ok) return toast(`Copied from ${deviceName || "your device"}`, { ok: true });
  openCopySheet(full, deviceName);
}

function openCopySheet(text, from) {
  $("#copy-sheet-from").textContent = from ? `From ${from}` : "New clip";
  $("#copy-sheet-text").textContent = text;
  $("#copy-sheet").hidden = false;
  $("#copy-sheet-btn").onclick = async () => {
    if (await copyText(text)) {
      $("#copy-sheet").hidden = true;
      toast("Copied", { ok: true });
    } else toast("Couldn't copy. Select the text and copy it manually.", { error: true });
  };
}
$("#copy-sheet-close").addEventListener("click", () => ($("#copy-sheet").hidden = true));
$("#copy-sheet").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});

// ---------------------------------------------------------------------------
// Devices view
// ---------------------------------------------------------------------------

const nameInput = $("#device-name");
nameInput.value = device.name;
$("#this-device-icon").replaceChildren(...icon(iconForType(device.type)).childNodes);
nameInput.addEventListener("change", () => {
  const name = nameInput.value.trim().slice(0, 40);
  if (!name) return (nameInput.value = device.name);
  device.name = name;
  persistDevice(device);
  backend.saveDevice(device).then(() => toast("Device renamed", { ok: true }));
});
nameInput.addEventListener("keydown", (e) => e.key === "Enter" && nameInput.blur());

function renderDevices() {
  const list = $("#device-list");
  const devices = [...state.devices].sort((a, b) => (a.id === device.id ? -1 : b.id === device.id ? 1 : (b.updatedAt || 0) - (a.updatedAt || 0)));
  if (!devices.length) {
    list.replaceChildren(el("li", { class: "list-empty", text: "No devices yet" }));
    return;
  }
  list.replaceChildren(
    ...devices.map((d) => {
      const isThis = d.id === device.id;
      const sub = [d.type === "extension" ? "Browser extension" : d.platform, d.push ? "notifications on" : "notifications off", d.updatedAt ? `active ${timeAgo(d.updatedAt)}` : null]
        .filter(Boolean)
        .join(" · ");
      return el(
        "li",
        {},
        el("div", { class: "glyph" }, icon(iconForType(d.type))),
        el("div", { class: "row-main" }, el("strong", { text: d.name || "Unnamed device" }), el("span", { text: sub })),
        isThis ? el("span", { class: "pill", text: "This device" }) : null,
        !isThis
          ? el(
              "button",
              {
                class: "icon-btn",
                title: "Remove device",
                "aria-label": `Remove ${d.name}`,
                onclick: async () => {
                  if (!confirm(`Remove "${d.name}"? It will stop receiving popups.`)) return;
                  await backend.removeDevice(d.id).catch((err) => toast(err.message, { error: true }));
                },
              },
              icon("trash"),
            )
          : null,
      );
    }),
  );
}

async function loadKeys() {
  const list = $("#key-list");
  try {
    const keys = await backend.listLinkTokens();
    if (!keys.length) {
      list.replaceChildren(el("li", { class: "list-empty", text: "No keys yet. They're created when you connect the extension or a Shortcut." }));
      return;
    }
    list.replaceChildren(
      ...keys.map((k) =>
        el(
          "li",
          {},
          el("div", { class: "glyph" }, icon(k.kind === "extension" ? "puzzle" : "bolt")),
          el(
            "div",
            { class: "row-main" },
            el("strong", { text: k.label }),
            el("span", { text: [`created ${timeAgo(k.createdAt)}`, k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"].join(" · ") }),
          ),
          el(
            "button",
            {
              class: "btn btn-danger btn-sm",
              onclick: async () => {
                if (!confirm(`Revoke "${k.label}"? That device will be disconnected.`)) return;
                try {
                  await backend.revokeLinkToken(k.id);
                  toast("Key revoked", { ok: true });
                  loadKeys();
                } catch (err) {
                  toast(err.message, { error: true });
                }
              },
            },
            "Revoke",
          ),
        ),
      ),
    );
  } catch (err) {
    list.replaceChildren(el("li", { class: "list-empty", text: `Couldn't load keys: ${err.message}` }));
  }
}

// ---------------------------------------------------------------------------
// Browser extension pairing
// ---------------------------------------------------------------------------

function renderExtension() {
  $("#connect-ext-btn").hidden = state.extension !== "ready";
  $("#ext-missing").hidden = !!state.extension;
  $("#ext-connected").hidden = state.extension !== "linked";
}
renderExtension();

let pendingLink = null;
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== "cloudboard-ext") return;
  if (e.data.type === "hello") {
    state.extension = e.data.linked ? "linked" : "ready";
    renderExtension();
  }
  if (e.data.type === "linked" && pendingLink) {
    pendingLink(e.data);
    pendingLink = null;
  }
});

$("#connect-ext-btn").addEventListener("click", async () => {
  const btn = $("#connect-ext-btn");
  btn.disabled = true;
  try {
    const { token } = await backend.createLinkToken("extension", `${env.platform} · ${env.browser} extension`);
    const result = await new Promise((resolve) => {
      pendingLink = resolve;
      window.postMessage({ source: "cloudboard-web", type: "link", token }, location.origin);
      setTimeout(() => resolve({ ok: false, error: "The extension didn't respond. Is it installed and enabled?" }), 10000);
    });
    if (!result.ok) throw new Error(result.error || "Couldn't connect the extension");
    state.extension = "linked";
    renderExtension();
    toast("Browser connected. Try Ctrl+Alt+C on any page.", { ok: true });
    loadKeys();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// iOS Shortcut setup
// ---------------------------------------------------------------------------

$("#shortcut-btn").addEventListener("click", async () => {
  const btn = $("#shortcut-btn");
  btn.disabled = true;
  try {
    const label = env.isIOS ? `${env.platform} Shortcut` : "iOS Shortcut";
    const { token } = await backend.createLinkToken("shortcut", label);
    $("#shortcut-token").textContent = token;
    $("#shortcut-url-send").textContent = `${location.origin}/api/clips`;
    $("#shortcut-url-latest").textContent = `${location.origin}/api/clips/latest`;
    $("#shortcut-token-copy").onclick = async () => {
      if (await copyText(token)) toast("Key copied", { ok: true });
    };
    $("#shortcut-sheet").hidden = false;
    loadKeys();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    btn.disabled = false;
  }
});
$("#shortcut-sheet").addEventListener("click", (e) => {
  if (e.target === e.currentTarget || e.target.closest("[data-close]")) $("#shortcut-sheet").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".sheet-backdrop").forEach((s) => (s.hidden = true));
});
