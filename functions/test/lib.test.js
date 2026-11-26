const test = require("node:test");
const assert = require("node:assert");
const lib = require("../lib");

test("truncateBytes keeps multibyte characters intact", () => {
  const r = lib.truncateBytes("héllo 👋 world", 9);
  assert.strictEqual(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text) <= 9);
  assert.strictEqual(r.text, "héllo ");
  assert.deepStrictEqual(lib.truncateBytes("short", 100), { text: "short", truncated: false });
});

test("buildPushPayload stays under the web-push size limit", () => {
  for (const sample of ["a", "\"\n\\", "😀", "中"]) {
    const payload = lib.buildPushPayload("abc", { text: sample.repeat(20000), deviceName: "Pixel" });
    assert.ok(Buffer.byteLength(payload) < 4000, `payload too big for ${sample}: ${Buffer.byteLength(payload)}`);
    const parsed = JSON.parse(payload);
    assert.strictEqual(parsed.truncated, true);
    assert.strictEqual(parsed.id, "abc");
  }
  const small = JSON.parse(lib.buildPushPayload("x", { text: "hi", deviceId: "d1" }));
  assert.strictEqual(small.text, "hi");
  assert.strictEqual(small.truncated, false);
});

test("extractText handles json, form and plain bodies", () => {
  assert.strictEqual(lib.extractText({ text: "a" }), "a");
  assert.strictEqual(lib.extractText('{"text":"b"}'), "b");
  assert.strictEqual(lib.extractText("plain"), "plain");
  assert.strictEqual(lib.extractText(Buffer.from("buf")), "buf");
  assert.strictEqual(lib.extractText(undefined), "");
});

test("normalizePath strips the /api prefix", () => {
  assert.strictEqual(lib.normalizePath("/api/clips/latest"), "/clips/latest");
  assert.strictEqual(lib.normalizePath("/clips/"), "/clips");
  assert.strictEqual(lib.normalizePath("/api"), "/");
  assert.strictEqual(lib.normalizePath("/apiary"), "/apiary");
});

test("link tokens are prefixed and hash deterministically", () => {
  const t = lib.newLinkToken();
  assert.match(t, /^cb_[A-Za-z0-9_-]{32}$/);
  assert.strictEqual(lib.hashToken(t), lib.hashToken(t));
  assert.strictEqual(lib.bearer({ headers: { authorization: "Bearer xyz " } }), "xyz");
});
