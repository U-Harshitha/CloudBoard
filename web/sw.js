// CloudBoard service worker: receives web-push messages for new clips and
// turns them into notifications with a "Copy" action.
const SHELL = "cloudboard-shell-v1";
const SHELL_FILES = ["/", "/index.html", "/styles.css", "/js/app.js", "/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// Network-first for the app shell so updates show up immediately; cache is the offline fallback.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && SHELL_FILES.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === "navigate" ? caches.match("/index.html") : Response.error())),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { text: event.data ? event.data.text() : "" };
  }
  if (data.type && data.type !== "clip") return;

  const preview = (data.text || "").replace(/\s+/g, " ").trim();
  const body = preview.length > 160 ? preview.slice(0, 157) + "…" : preview || "New clip";
  event.waitUntil(
    self.registration.showNotification(`Copied on ${data.deviceName || "another device"}`, {
      body,
      tag: "cloudboard-clip",
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data,
      // Action buttons show on Android, Windows and Mac (Chrome/Edge). iOS ignores them;
      // tapping the notification there opens the app with a Copy sheet.
      actions: [{ action: "copy", title: "Copy" }],
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (!data.id) return;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = all.find((c) => new URL(c.url).origin === location.origin);
      if (client) {
        await client.focus();
        client.postMessage({ type: "copy-clip", id: data.id, text: data.text, truncated: data.truncated, deviceName: data.deviceName });
      } else {
        await self.clients.openWindow(`/?copy=${encodeURIComponent(data.id)}`);
      }
    })(),
  );
});
