// CloudBoard API: a single request handler that runs as a Vercel serverless function
// (api/index.js) and in the local dev server (server/dev.js).
//
// It works on Firebase's free Spark plan: it only uses Auth + Firestore through the
// Admin SDK, and sends Web Push itself (no Cloud Functions, no FCM server key).
//
// Environment variables:
//   FIREBASE_SERVICE_ACCOUNT  service-account JSON (raw or base64). Not needed with emulators.
//   FIREBASE_PROJECT_ID       optional if the service account is set
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   Web Push keys

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const webpush = require("web-push");
const { MAX_TEXT, hashToken, newLinkToken, buildPushPayload, extractText, normalizePath, bearer } = require("./lib");

const HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  const json = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(json);
}

let db, auth;
function init() {
  if (db) return;
  if (!getApps().length) {
    const sa = loadServiceAccount();
    const projectId = process.env.FIREBASE_PROJECT_ID || (sa && sa.project_id);
    initializeApp(sa ? { credential: cert(sa), projectId } : { projectId });
  }
  db = getFirestore();
  auth = getAuth();
  if (process.env.VAPID_PRIVATE_KEY && process.env.VAPID_PUBLIC_KEY) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Signed-in web user (Firebase ID token). */
async function userFromIdToken(token) {
  try {
    const decoded = await auth.verifyIdToken(token);
    return { uid: decoded.uid, kind: "web" };
  } catch (_) {
    throw new HttpError(401, "Invalid or expired session. Sign in again.");
  }
}

/** Extension / Shortcut (CloudBoard access key, "cb_..."). */
async function userFromLinkToken(token) {
  const id = hashToken(token);
  const snap = await db.collection("linkTokens").doc(id).get();
  if (!snap.exists) throw new HttpError(401, "This CloudBoard key was revoked or is invalid");
  const data = snap.data();
  const last = data.lastUsedAt && data.lastUsedAt.toMillis ? data.lastUsedAt.toMillis() : 0;
  if (Date.now() - last > 10 * 60 * 1000) snap.ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => {});
  return { uid: data.uid, tokenId: id, kind: data.kind, label: data.label };
}

async function requireUser(req) {
  const token = bearer(req);
  if (!token || token.startsWith("cb_")) throw new HttpError(401, "Sign in required");
  return userFromIdToken(token);
}

async function requireLink(req) {
  const token = bearer(req);
  if (!token || !token.startsWith("cb_")) throw new HttpError(401, "Missing CloudBoard key");
  return userFromLinkToken(token);
}

/** Either a web session or an access key. */
async function requireAny(req) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "Sign in required");
  return token.startsWith("cb_") ? userFromLinkToken(token) : userFromIdToken(token);
}

// ---------------------------------------------------------------------------
// Clips & push fan-out
// ---------------------------------------------------------------------------

const userRef = (uid) => db.collection("users").doc(uid);

function serializeClip(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    text: d.text,
    deviceId: d.deviceId || null,
    deviceName: d.deviceName || null,
    deviceType: d.deviceType || null,
    createdAt: d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : null,
  };
}

async function createClip(uid, { text, deviceId, deviceName, deviceType }) {
  if (typeof text !== "string" || !text.length) throw new HttpError(400, "Clip text is empty");
  if (text.length > MAX_TEXT) throw new HttpError(413, `Clip is too long (max ${MAX_TEXT} characters)`);
  const clip = {
    text,
    deviceId: deviceId ? String(deviceId).slice(0, 100) : null,
    deviceName: deviceName ? String(deviceName).slice(0, 60) : null,
    deviceType: deviceType ? String(deviceType).slice(0, 30) : null,
    createdAt: FieldValue.serverTimestamp(),
  };
  const ref = await userRef(uid).collection("clips").add(clip);
  // Serverless functions may be frozen once the response is sent, so finish the
  // fan-out before replying (it's a handful of parallel HTTPS calls).
  await Promise.all([fanout(uid, ref.id, { ...clip, createdAt: null }), trimHistory(uid)]).catch((err) =>
    console.error("fanout failed", err),
  );
  return ref.id;
}

/** Send the new clip to every other device of this user via Web Push. */
async function fanout(uid, clipId, clip) {
  if (!process.env.VAPID_PRIVATE_KEY) return;
  const payload = buildPushPayload(clipId, clip);
  const devices = await userRef(uid).collection("devices").get();
  await Promise.all(
    devices.docs
      .filter((d) => d.id !== clip.deviceId)
      .filter((d) => d.data().subscription && d.data().subscription.endpoint && d.data().notify !== false)
      .map(async (d) => {
        try {
          await webpush.sendNotification(d.data().subscription, payload, { TTL: 60 * 60, urgency: "high", timeout: 8000 });
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await d.ref.update({ subscription: null }).catch(() => {}); // expired on the device
          } else {
            console.warn("push failed", d.id, err.statusCode, err.body || err.message);
          }
        }
      }),
  );
}

async function trimHistory(uid) {
  const old = await userRef(uid).collection("clips").orderBy("createdAt", "desc").offset(HISTORY_LIMIT).limit(100).get();
  if (old.empty) return;
  const batch = db.batch();
  old.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

async function revokeToken(uid, tokenId) {
  const devices = await userRef(uid).collection("devices").where("linkTokenId", "==", tokenId).get();
  const batch = db.batch();
  devices.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(db.collection("linkTokens").doc(tokenId));
  await batch.commit();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function send(res, status, body) {
  if (typeof body === "string") {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
  } else {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }
}

async function route(req, res, path, query, body) {
  const method = req.method;
  const parts = path.split("/").filter(Boolean);

  if (method === "GET" && path === "/config") {
    return send(res, 200, { vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null });
  }

  // Access keys, managed from the signed-in web app
  if (parts[0] === "link-tokens") {
    const { uid } = await requireUser(req);
    if (method === "POST" && parts.length === 1) {
      const kind = ["extension", "shortcut"].includes(body && body.kind) ? body.kind : "shortcut";
      const label = String((body && body.label) || (kind === "extension" ? "Browser extension" : "iOS Shortcut")).slice(0, 60);
      const token = newLinkToken();
      await db.collection("linkTokens").doc(hashToken(token)).set({ uid, kind, label, createdAt: FieldValue.serverTimestamp() });
      return send(res, 201, { token, id: hashToken(token), kind, label });
    }
    if (method === "GET" && parts.length === 1) {
      const snap = await db.collection("linkTokens").where("uid", "==", uid).get();
      const tokens = snap.docs
        .map((d) => {
          const t = d.data();
          return { id: d.id, kind: t.kind, label: t.label, createdAt: t.createdAt ? t.createdAt.toMillis() : null, lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toMillis() : null };
        })
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return send(res, 200, { tokens });
    }
    if (method === "DELETE" && parts.length === 2) {
      const snap = await db.collection("linkTokens").doc(parts[1]).get();
      if (!snap.exists || snap.data().uid !== uid) throw new HttpError(404, "Key not found");
      await revokeToken(uid, parts[1]);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, "Not found");
  }

  // Creating clips: web app (session) or extension / Shortcut (access key)
  if (method === "POST" && path === "/clips") {
    const who = await requireAny(req);
    const b = body && typeof body === "object" && !Buffer.isBuffer(body) ? body : {};
    const id = await createClip(who.uid, {
      text: extractText(body),
      deviceId: b.deviceId || (who.tokenId ? `${who.kind}-${who.tokenId.slice(0, 12)}` : null),
      deviceName: b.deviceName || who.label || null,
      deviceType: b.deviceType || who.kind,
    });
    return send(res, 201, { ok: true, id });
  }

  // Everything below: extension / Shortcut
  const link = await requireLink(req);
  const { uid } = link;

  if (method === "GET" && path === "/me") {
    const user = await auth.getUser(uid).catch(() => null);
    return send(res, 200, {
      uid,
      email: user ? user.email : null,
      name: user ? user.displayName : null,
      photoURL: user ? user.photoURL : null,
      key: { kind: link.kind, label: link.label },
    });
  }

  if (parts[0] === "clips" && method === "GET") {
    const clips = userRef(uid).collection("clips");
    if (parts.length === 1) {
      const n = Math.min(Math.max(parseInt(query.get("limit"), 10) || 20, 1), HISTORY_LIMIT);
      const snap = await clips.orderBy("createdAt", "desc").limit(n).get();
      return send(res, 200, { clips: snap.docs.map(serializeClip) });
    }
    const json = query.get("format") === "json";
    if (parts[1] === "latest") {
      const snap = await clips.orderBy("createdAt", "desc").limit(1).get();
      if (snap.empty) return json ? send(res, 404, { error: "No clips yet" }) : send(res, 404, "");
      const clip = serializeClip(snap.docs[0]);
      return json ? send(res, 200, clip) : send(res, 200, clip.text);
    }
    const snap = await clips.doc(parts[1]).get();
    if (!snap.exists) throw new HttpError(404, "Clip not found");
    return send(res, 200, serializeClip(snap));
  }

  if (parts[0] === "devices" && parts.length === 2) {
    const ref = userRef(uid).collection("devices").doc(parts[1]);
    if (method === "PUT") {
      const b = body || {};
      await ref.set(
        {
          name: String(b.name || link.label).slice(0, 60),
          type: String(b.type || link.kind).slice(0, 30),
          platform: String(b.platform || "").slice(0, 60),
          subscription: b.subscription && b.subscription.endpoint ? b.subscription : null,
          notify: true,
          linkTokenId: link.tokenId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      await ref.delete();
      await revokeToken(uid, link.tokenId);
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------
// Entry point (Node http-style req/res; Vercel adds conveniences we don't rely on)
// ---------------------------------------------------------------------------

async function readBody(req) {
  if (req.body !== undefined) return req.body; // already parsed by Vercel
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  if ((req.headers["content-type"] || "").includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch (_) {
      throw new HttpError(400, "Invalid JSON");
    }
  }
  if ((req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  try {
    init();
    const url = new URL(req.url, "http://localhost");
    // On Vercel, /api/<path> is rewritten to /api?path=<path>
    const rawPath = url.searchParams.has("path") ? "/" + url.searchParams.get("path") : url.pathname;
    url.searchParams.delete("path");
    const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : undefined;
    await route(req, res, normalizePath(rawPath), url.searchParams, body);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    send(res, status, { error: status >= 500 ? "Server error" : err.message });
  }
};
