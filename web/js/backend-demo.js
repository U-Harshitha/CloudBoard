// Demo backend: in-memory data so the UI can be explored before Firebase is configured.
const now = Date.now();
const min = 60 * 1000;

let user = null;
let clips = [
  { id: "c1", text: "https://maps.app.goo.gl/x7Qb2 — dinner at 8, table for four", deviceId: "phone", deviceName: "Pixel 8", deviceType: "android", createdAt: now - 2 * min },
  { id: "c2", text: "const sync = await cloudboard.send(selection);", deviceId: "ext", deviceName: "Windows · Chrome", deviceType: "extension", createdAt: now - 26 * min },
  { id: "c3", text: "Flight AI 101 · Confirmation code QX7P2L", deviceId: "ipad", deviceName: "iPad", deviceType: "shortcut", createdAt: now - 3 * 60 * min },
  { id: "c4", text: "Meeting notes:\n• Ship v1 on Friday\n• Ctrl+Alt+C to cloud-copy, Ctrl+Alt+V to cloud-paste\n• Collect feedback from beta users", deviceId: "ext", deviceName: "Windows · Chrome", deviceType: "extension", createdAt: now - 26 * 60 * min },
];
let devices = [
  { id: "phone", name: "Pixel 8", type: "web", platform: "Android", push: true, updatedAt: now - 2 * min },
  { id: "ext", name: "Windows · Chrome", type: "extension", platform: "Windows", push: true, updatedAt: now - 26 * min },
];
let tokens = [{ id: "t1", kind: "shortcut", label: "iPad Shortcut", createdAt: now - 5 * 24 * 60 * min, lastUsedAt: now - 3 * 60 * min }];

const clipSubs = new Set();
const deviceSubs = new Set();
const emitClips = () => clipSubs.forEach((cb) => cb([...clips]));
const emitDevices = () => deviceSubs.forEach((cb) => cb([...devices]));
const delay = (ms = 150) => new Promise((r) => setTimeout(r, ms));

export const backend = {
  demo: true,
  onAuth(cb) {
    this._authCb = cb;
    setTimeout(() => cb(user), 0);
    return () => {};
  },
  async signIn() {
    await delay();
    user = { uid: "demo", name: "Demo User", email: "demo@cloudboard.app", photoURL: null };
    this._authCb && this._authCb(user);
  },
  async signOut() {
    user = null;
    this._authCb && this._authCb(null);
  },
  watchClips(cb) {
    clipSubs.add(cb);
    setTimeout(() => cb([...clips]), 0);
    return () => clipSubs.delete(cb);
  },
  async addClip(text, device) {
    await delay();
    clips = [{ id: "c" + Math.random().toString(36).slice(2), text, deviceId: device.id, deviceName: device.name, deviceType: device.type, createdAt: Date.now() }, ...clips];
    emitClips();
  },
  async deleteClip(id) {
    clips = clips.filter((c) => c.id !== id);
    emitClips();
  },
  async getClip(id) {
    return clips.find((c) => c.id === id) || null;
  },
  watchDevices(cb) {
    deviceSubs.add(cb);
    setTimeout(() => cb([...devices]), 0);
    return () => deviceSubs.delete(cb);
  },
  async saveDevice(device, subscription) {
    const existing = devices.find((d) => d.id === device.id);
    const next = { id: device.id, name: device.name, type: device.type, platform: device.platform, push: subscription === undefined ? !!(existing && existing.push) : !!subscription, updatedAt: Date.now() };
    devices = existing ? devices.map((d) => (d.id === device.id ? next : d)) : [next, ...devices];
    emitDevices();
  },
  async removeDevice(id) {
    devices = devices.filter((d) => d.id !== id);
    emitDevices();
  },
  async vapidPublicKey() {
    throw new Error("Notifications need a real Firebase project (demo mode)");
  },
  async createLinkToken(kind, label) {
    await delay();
    const t = { id: "t" + Date.now(), kind, label, createdAt: Date.now(), lastUsedAt: null };
    tokens = [t, ...tokens];
    return { ...t, token: "cb_demo_" + Math.random().toString(36).slice(2, 14) };
  },
  async listLinkTokens() {
    await delay();
    return [...tokens];
  },
  async revokeLinkToken(id) {
    tokens = tokens.filter((t) => t.id !== id);
  },
};
