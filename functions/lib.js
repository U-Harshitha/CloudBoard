// Pure helpers shared by the Cloud Functions. No Firebase imports here so they
// can be unit-tested with plain `node --test`.
const crypto = require("crypto");

const MAX_TEXT = 50000; // characters per clip
const PUSH_BUDGET_BYTES = 3000; // web push payloads must stay under ~4 KB

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newLinkToken() {
  return "cb_" + crypto.randomBytes(24).toString("base64url");
}

/** Truncate a string so its UTF-8 encoding fits in `maxBytes`, never splitting a character. */
function truncateBytes(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return { text: out, truncated: true };
}

/** Build the JSON payload sent to every other device for a new clip. */
function buildPushPayload(id, clip) {
  const meta = {
    type: "clip",
    id,
    deviceId: clip.deviceId || null,
    deviceName: clip.deviceName || "another device",
    deviceType: clip.deviceType || "unknown",
    createdAt: clip.createdAt && clip.createdAt.toMillis ? clip.createdAt.toMillis() : Date.now(),
  };
  const full = clip.text || "";
  const encode = (text, truncated) => JSON.stringify({ ...meta, text, truncated });
  let payload = encode(full, false);
  if (Buffer.byteLength(payload, "utf8") <= PUSH_BUDGET_BYTES) return payload;
  // JSON escaping can grow text (quotes, newlines, emoji), so shrink until it fits.
  let budget = PUSH_BUDGET_BYTES - Buffer.byteLength(encode("", true), "utf8");
  do {
    payload = encode(truncateBytes(full, budget).text, true);
    budget = Math.floor(budget * 0.8);
  } while (Buffer.byteLength(payload, "utf8") > PUSH_BUDGET_BYTES && budget > 0);
  return payload;
}

/** Extract text from a request body sent as JSON, form data or plain text. */
function extractText(body) {
  if (body == null) return "";
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object") return extractText(parsed);
    } catch (_) {
      /* plain text */
    }
    return body;
  }
  if (typeof body === "object") {
    for (const key of ["text", "clip", "content", "value"]) {
      if (typeof body[key] === "string") return body[key];
    }
  }
  return "";
}

/** Strip the /api prefix (present when called via the Hosting rewrite) and trailing slashes. */
function normalizePath(path) {
  let p = path || "/";
  if (p === "/api" || p.startsWith("/api/")) p = p.slice(4) || "/";
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

function bearer(req) {
  const h = req.get ? req.get("authorization") : req.headers && req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

module.exports = {
  MAX_TEXT,
  hashToken,
  newLinkToken,
  truncateBytes,
  buildPushPayload,
  extractText,
  normalizePath,
  bearer,
};
