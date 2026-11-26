// CloudBoard content script
//  Ctrl+Alt+C → send the selected text (or your clipboard, if nothing is selected) to CloudBoard
//  Ctrl+Alt+V → type the latest cloud clip into the focused field
// On the CloudBoard web app itself it also handles pairing ("Connect this browser").
(() => {
  if (window.__cloudboardLoaded) return;
  window.__cloudboardLoaded = true;

  const isTop = window === window.top;
  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false, error: "CloudBoard was updated. Reload this page." } : res || { ok: false }));
      } catch (_) {
        resolve({ ok: false, error: "CloudBoard was updated. Reload this page." });
      }
    });

  // ---------------------------------------------------------------- toast
  let host, toastEl, timer;
  function toast(message, kind = "ok") {
    if (!document.body) return;
    if (!host) {
      host = document.createElement("cloudboard-toast");
      host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:50%;bottom:28px;transform:translateX(-50%);pointer-events:none";
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>
        .t{display:flex;align-items:center;gap:10px;max-width:min(440px,calc(100vw - 32px));padding:10px 16px 10px 12px;border-radius:999px;
           font:500 14px/1.35 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;background:#141726;
           box-shadow:0 18px 40px -12px rgba(0,0,0,.45);opacity:0;transform:translateY(10px) scale(.98);transition:opacity .18s ease,transform .25s cubic-bezier(.2,.9,.3,1.2)}
        .t.show{opacity:1;transform:none}
        .t.err{background:#d43c4c}
        .i{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#5b5bf0,#8b5cf6);flex:none}
        .t.err .i{background:rgba(255,255,255,.2)}
        .m{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .s{opacity:.65;font-weight:400}
      </style><div class="t"><span class="i"></span><span class="m"></span></div>`;
      toastEl = root.querySelector(".t");
    }
    if (!host.isConnected) document.documentElement.appendChild(host);
    const icon = kind === "err" ? "!" : kind === "up" ? "↑" : "✓";
    toastEl.querySelector(".i").textContent = icon;
    toastEl.querySelector(".m").textContent = message;
    toastEl.classList.toggle("err", kind === "err");
    requestAnimationFrame(() => toastEl.classList.add("show"));
    clearTimeout(timer);
    timer = setTimeout(() => toastEl.classList.remove("show"), kind === "err" ? 3800 : 2000);
  }

  const short = (t, n = 48) => {
    const s = (t || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };

  // ---------------------------------------------------------------- selection helpers
  function selectedText() {
    const a = deepActive();
    if (a && isTextField(a) && typeof a.selectionStart === "number" && a.selectionStart !== a.selectionEnd) {
      return a.value.slice(a.selectionStart, a.selectionEnd);
    }
    return String(window.getSelection() || "");
  }

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isTextField(node) {
    if (!node) return false;
    if (node.tagName === "TEXTAREA") return true;
    if (node.tagName === "INPUT") return /^(text|search|url|email|tel|password|number)?$/i.test(node.type || "text");
    return false;
  }

  function insertText(text) {
    const a = deepActive();
    const editable = a && (isTextField(a) || a.isContentEditable);
    if (!editable) return false;
    a.focus();
    // execCommand keeps the page's undo stack and fires input events frameworks listen to.
    if (document.execCommand("insertText", false, text)) return true;
    if (isTextField(a)) {
      const { selectionStart: s, selectionEnd: e, value } = a;
      a.value = value.slice(0, s) + text + value.slice(e);
      a.selectionStart = a.selectionEnd = s + text.length;
      a.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- shortcuts
  document.addEventListener(
    "keydown",
    async (e) => {
      if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey || e.repeat) return;
      if (e.code !== "KeyC" && e.code !== "KeyV") return;
      // The web app handles its own Ctrl+Alt+C.
      if (document.documentElement.dataset.cloudboardApp === "1") return;
      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.code === "KeyC") {
        const text = selectedText();
        const res = await send({ type: "cloud-copy", text });
        if (res.ok) toast(`${res.source === "clipboard" ? "Clipboard sent" : "Cloud-copied"} · ${short(res.preview, 40)}`, "up");
        else toast(res.error || "Couldn't send to CloudBoard", "err");
      } else {
        const res = await send({ type: "cloud-paste" });
        if (!res.ok) return toast(res.error || "Couldn't fetch your latest clip", "err");
        if (insertText(res.text)) toast(`Pasted from ${res.from || "CloudBoard"}`);
        else {
          // Not in a text field: put it on the clipboard instead so Ctrl+V works.
          try {
            await navigator.clipboard.writeText(res.text);
            toast(`Latest clip copied · ${short(res.text, 36)}`);
          } catch (_) {
            toast("Click into a text field first", "err");
          }
        }
      }
    },
    true,
  );

  // ---------------------------------------------------------------- pairing with the web app
  if (!isTop) return;
  send({ type: "is-app-origin" }).then((res) => {
    if (!res || !res.isApp) return;
    const announce = () => {
      document.documentElement.dataset.cloudboardExtension = res.linked ? "linked" : "ready";
      window.postMessage({ source: "cloudboard-ext", type: "hello", linked: res.linked }, location.origin);
    };
    announce();
    document.addEventListener("DOMContentLoaded", announce, { once: true });

    window.addEventListener("message", async (e) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const d = e.data;
      if (!d || d.source !== "cloudboard-web" || d.type !== "link" || typeof d.token !== "string") return;
      const result = await send({ type: "link", token: d.token });
      if (result.ok) document.documentElement.dataset.cloudboardExtension = "linked";
      window.postMessage({ source: "cloudboard-ext", type: "linked", ok: !!result.ok, error: result.error }, location.origin);
    });
  });
})();
