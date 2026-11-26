// CloudBoard Cloud Functions
//
//  api     – HTTPS API used by the browser extension and the iOS Shortcut
//            (served at https://<your-app>/api/** through a Hosting rewrite)
//  fanout  – runs whenever a clip is created and sends a web-push to every
//            other device of the same user, then trims old history.

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const webpush = require("web-push");
const {
  MAX_TEXT,
  hashToken,
  newLinkToken,
  buildPushPayload,
  extractText,
  normalizePath,
  bearer,
} = require("./lib");

initializeApp();
const db = getFirestore();

const VAPID_PUBLIC_KEY = defineString("VAPID_PUBLIC_KEY");
const VAPID_SUBJECT = defineString("VAPID_SUBJECT", { default: "mailto:admin@example.com" });
const VAPID_PRIVATE_KEY = defineSecret("VAPID_PRIVATE_KEY");

const HISTORY_LIMIT = 50; // clips kept per user
const REGION = "us-central1";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Signed-in web user (Firebase ID token). */
async function requireUser(req) {
  const token = bearer(req);
  if (!token || token.startsWith("cb_")) throw new HttpError(401, "Sign in required");
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return { uid: decoded.uid };
  } catch (_) {
    throw new HttpError(401, "Invalid or expired session");
  }
}

/** Extension / Shortcut (CloudBoard link token, "cb_..."). */
async function requireLink(req) {
  const token = bearer(req);
  if (!token || !token.startsWith("cb_")) throw new HttpError(401, "Missing CloudBoard key");
  const id = hashToken(token);
  const snap = await db.collection("linkTokens").doc(id).get();
  if (!snap.exists) throw new HttpError(401, "This CloudBoard key was revoked or is invalid");
  const data = snap.data();
  // Cheap "last used" bookkeeping, at most once every 10 minutes.
  const last = data.lastUsedAt && data.lastUsedAt.toMillis ? data.lastUsedAt.toMillis() : 0;
  if (Date.now() - last > 10 * 60 * 1000) {
    snap.ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => {});
  }
  return { uid: data.uid, tokenId: id, kind: data.kind, label: data.label };
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function clipsRef(uid) {
  return db.collection("users").doc(uid).collection("clips");
}

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
  const ref = await clipsRef(uid).add({
    text,
    deviceId: deviceId ? String(deviceId).slice(0, 100) : null,
    deviceName: deviceName ? String(deviceName).slice(0, 60) : null,
    deviceType: deviceType ? String(deviceType).slice(0, 30) : null,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

function send(res, status, body) {
  if (typeof body === "string") {
    res.status(status).set("Content-Type", "text/plain; charset=utf-8").send(body);
  } else {
    res.status(status).json(body);
  }
}

async function route(req, res) {
  const path = normalizePath(req.path);
  const method = req.method;
  const parts = path.split("/").filter(Boolean); // e.g. ["clips", "latest"]

  // Public config -----------------------------------------------------------
  if (method === "GET" && path === "/config") {
    return send(res, 200, { vapidPublicKey: VAPID_PUBLIC_KEY.value() });
  }

  // Link tokens (managed from the signed-in web app) -------------------------
  if (parts[0] === "link-tokens") {
    const { uid } = await requireUser(req);
    if (method === "POST" && parts.length === 1) {
      const kind = ["extension", "shortcut"].includes(req.body && req.body.kind) ? req.body.kind : "shortcut";
      const label = String((req.body && req.body.label) || (kind === "extension" ? "Browser extension" : "iOS Shortcut")).slice(0, 60);
      const token = newLinkToken();
      await db.collection("linkTokens").doc(hashToken(token)).set({
        uid,
        kind,
        label,
        createdAt: FieldValue.serverTimestamp(),
      });
      return send(res, 201, { token, id: hashToken(token), kind, label });
    }
    if (method === "GET" && parts.length === 1) {
      const snap = await db.collection("linkTokens").where("uid", "==", uid).get();
      const tokens = snap.docs
        .map((d) => {
          const t = d.data();
          return {
            id: d.id,
            kind: t.kind,
            label: t.label,
            createdAt: t.createdAt ? t.createdAt.toMillis() : null,
            lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toMillis() : null,
          };
        })
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return send(res, 200, { tokens });
    }
    if (method === "DELETE" && parts.length === 2) {
      const ref = db.collection("linkTokens").doc(parts[1]);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) throw new HttpError(404, "Key not found");
      await revokeToken(uid, parts[1]);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, "Not found");
  }

  // Everything below uses a link token (extension / Shortcut) ----------------
  const link = await requireLink(req);
  const { uid } = link;

  if (method === "GET" && path === "/me") {
    const user = await getAuth().getUser(uid).catch(() => null);
    return send(res, 200, {
      uid,
      email: user ? user.email : null,
      name: user ? user.displayName : null,
      photoURL: user ? user.photoURL : null,
      key: { kind: link.kind, label: link.label },
    });
  }

  if (parts[0] === "clips") {
    if (method === "POST" && parts.length === 1) {
      const body = req.body || {};
      const text = extractText(typeof body === "object" && !Buffer.isBuffer(body) ? body : req.rawBody || body);
      const id = await createClip(uid, {
        text,
        deviceId: body.deviceId || `${link.kind}-${link.tokenId.slice(0, 12)}`,
        deviceName: body.deviceName || link.label,
        deviceType: body.deviceType || link.kind,
      });
      return send(res, 201, { ok: true, id });
    }
    if (method === "GET" && parts.length === 1) {
      const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), HISTORY_LIMIT);
      const snap = await clipsRef(uid).orderBy("createdAt", "desc").limit(n).get();
      return send(res, 200, { clips: snap.docs.map(serializeClip) });
    }
    if (method === "GET" && parts[1] === "latest") {
      const snap = await clipsRef(uid).orderBy("createdAt", "desc").limit(1).get();
      if (snap.empty) return req.query.format === "json" ? send(res, 404, { error: "No clips yet" }) : send(res, 404, "");
      const clip = serializeClip(snap.docs[0]);
      return req.query.format === "json" ? send(res, 200, clip) : send(res, 200, clip.text);
    }
    if (method === "GET" && parts.length === 2) {
      const snap = await clipsRef(uid).doc(parts[1]).get();
      if (!snap.exists) throw new HttpError(404, "Clip not found");
      return send(res, 200, serializeClip(snap));
    }
    throw new HttpError(404, "Not found");
  }

  if (parts[0] === "devices" && parts.length === 2) {
    const ref = db.collection("users").doc(uid).collection("devices").doc(parts[1]);
    if (method === "PUT") {
      const b = req.body || {};
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
      // Unlinking from the extension: remove this device and its key.
      await ref.delete();
      await revokeToken(uid, link.tokenId);
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, "Not found");
}

async function revokeToken(uid, tokenId) {
  const devices = await db.collection("users").doc(uid).collection("devices").where("linkTokenId", "==", tokenId).get();
  const batch = db.batch();
  devices.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(db.collection("linkTokens").doc(tokenId));
  await batch.commit();
}

exports.api = onRequest({ region: REGION, invoker: "public", cors: false }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.set("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.status(204).send("");
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) logger.error(err);
    send(res, status, { error: err.message || "Server error" });
  }
});

// ---------------------------------------------------------------------------
// Fan-out: push each new clip to the user's other devices
// ---------------------------------------------------------------------------

exports.fanout = onDocumentCreated(
  { document: "users/{uid}/clips/{clipId}", region: REGION, secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    const { uid, clipId } = event.params;
    const clip = event.data && event.data.data();
    if (!clip) return;

    webpush.setVapidDetails(VAPID_SUBJECT.value(), VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
    const payload = buildPushPayload(clipId, clip);

    const devices = await db.collection("users").doc(uid).collection("devices").get();
    const sends = devices.docs
      .filter((d) => d.id !== clip.deviceId)
      .filter((d) => d.data().subscription && d.data().subscription.endpoint && d.data().notify !== false)
      .map(async (d) => {
        try {
          await webpush.sendNotification(d.data().subscription, payload, { TTL: 60 * 60, urgency: "high" });
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            // Subscription expired or was removed on the device.
            await d.ref.update({ subscription: null }).catch(() => {});
          } else {
            logger.warn("push failed", { device: d.id, status: err.statusCode, body: err.body });
          }
        }
      });
    await Promise.all(sends);

    // Keep only the newest HISTORY_LIMIT clips.
    const old = await db
      .collection("users")
      .doc(uid)
      .collection("clips")
      .orderBy("createdAt", "desc")
      .offset(HISTORY_LIMIT)
      .limit(100)
      .get();
    if (!old.empty) {
      const batch = db.batch();
      old.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  },
);
