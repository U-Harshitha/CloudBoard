const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: err.message }));

let toastTimer;
function toast(text, err = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("err", err);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

function timeAgo(ms) {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

let webAppUrl = "";
const openApp = (e) => {
  e && e.preventDefault();
  chrome.tabs.create({ url: `${webAppUrl}/#devices` });
};

async function init() {
  const st = await send({ type: "status" });
  webAppUrl = st.webAppUrl;
  $("#status").textContent = st.linked ? "Connected" : "Not connected";
  $("#status").classList.toggle("on", !!st.linked);
  $("#unlinked").hidden = !!st.linked;
  $("#linked").hidden = !st.linked;
  if (!st.linked) return;

  $("#account").textContent = st.account ? st.account.email || st.account.name || "" : "";
  $("#auto-copy").checked = st.autoCopy;
  $("#notify").checked = st.notify;
  $("#device-name").value = st.deviceName || "";
  loadRecent();
}

async function loadRecent() {
  const list = $("#recent");
  const res = await send({ type: "recent" });
  if (!res || res.ok === false) {
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = (res && res.error) || "Couldn't load clips";
    list.append(li);
    return;
  }
  list.replaceChildren();
  if (!res.clips.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No clips yet. Select text anywhere and press Ctrl+Alt+C.";
    list.append(li);
  }
  for (const c of res.clips) {
    const li = document.createElement("li");
    li.className = "clip";
    li.title = "Click to copy";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = c.text;
    const m = document.createElement("div");
    m.className = "m";
    m.textContent = `${c.deviceName || "Unknown"} · ${timeAgo(c.createdAt)}`;
    li.append(t, m);
    li.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(c.text);
        toast("Copied to clipboard");
      } catch (_) {
        toast("Couldn't copy", true);
      }
    });
    list.append(li);
  }
}

$("#open-app").addEventListener("click", openApp);
$("#open-app-2").addEventListener("click", openApp);
$("#shortcuts").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: navigator.userAgent.includes("Edg/") ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts" });
});
$("#send-clipboard").addEventListener("click", async () => {
  const btn = $("#send-clipboard");
  btn.disabled = true;
  let text = "";
  try {
    text = await navigator.clipboard.readText(); // popup has focus, so this works directly
  } catch (_) {}
  const res = text ? await send({ type: "send-text", text }) : await send({ type: "send-clipboard" });
  btn.disabled = false;
  if (res.ok) {
    toast("Sent to your devices");
    loadRecent();
  } else toast(res.error || "Couldn't send", true);
});
$("#auto-copy").addEventListener("change", (e) => send({ type: "settings", autoCopy: e.target.checked }));
$("#notify").addEventListener("change", (e) => send({ type: "settings", notify: e.target.checked }));
$("#device-name").addEventListener("change", (e) => send({ type: "settings", deviceName: e.target.value }).then(() => toast("Saved")));
$("#unlink").addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm("Disconnect this browser from CloudBoard?")) return;
  await send({ type: "unlink" });
  init();
});

init();
