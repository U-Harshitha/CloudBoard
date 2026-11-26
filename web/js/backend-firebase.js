// Real backend: Firebase Auth + Firestore + the CloudBoard HTTPS API.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  connectAuthEmulator,
  signOut as fbSignOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  deleteDoc,
  getDoc,
  setDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// When served by `firebase emulators:start` on localhost, talk to the local emulators.
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, location.hostname, 8080);
}

const toClip = (snap) => {
  const d = snap.data({ serverTimestamps: "estimate" });
  return {
    id: snap.id,
    text: d.text,
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    deviceType: d.deviceType,
    createdAt: d.createdAt ? d.createdAt.toMillis() : Date.now(),
  };
};

const uid = () => {
  if (!auth.currentUser) throw new Error("Not signed in");
  return auth.currentUser.uid;
};

async function api(path, { method = "GET", body } = {}) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const backend = {
  demo: false,

  onAuth(cb) {
    getRedirectResult(auth).catch(() => {});
    return onAuthStateChanged(auth, (u) =>
      cb(u ? { uid: u.uid, name: u.displayName, email: u.email, photoURL: u.photoURL } : null),
    );
  },

  async signIn() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (standalone) return signInWithRedirect(auth, provider); // popups are unreliable in installed PWAs
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(err.code)) {
        return signInWithRedirect(auth, provider);
      }
      if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") throw err;
    }
  },

  signOut: () => fbSignOut(auth),

  watchClips(cb, onError) {
    const q = query(collection(db, "users", uid(), "clips"), orderBy("createdAt", "desc"), limit(50));
    return onSnapshot(q, (snap) => cb(snap.docs.map(toClip)), onError);
  },

  async addClip(text, device) {
    await addDoc(collection(db, "users", uid(), "clips"), {
      text,
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
      createdAt: serverTimestamp(),
    });
  },

  deleteClip: (id) => deleteDoc(doc(db, "users", uid(), "clips", id)),

  async getClip(id) {
    const snap = await getDoc(doc(db, "users", uid(), "clips", id));
    return snap.exists() ? toClip(snap) : null;
  },

  watchDevices(cb) {
    return onSnapshot(collection(db, "users", uid(), "devices"), (snap) =>
      cb(
        snap.docs.map((d) => {
          const v = d.data({ serverTimestamps: "estimate" });
          return {
            id: d.id,
            name: v.name,
            type: v.type,
            platform: v.platform,
            push: !!(v.subscription && v.subscription.endpoint),
            updatedAt: v.updatedAt ? v.updatedAt.toMillis() : null,
          };
        }),
      ),
    );
  },

  saveDevice(device, subscription) {
    const data = {
      name: device.name,
      type: device.type,
      platform: device.platform,
      notify: true,
      updatedAt: serverTimestamp(),
    };
    if (subscription !== undefined) data.subscription = subscription;
    return setDoc(doc(db, "users", uid(), "devices", device.id), data, { merge: true });
  },

  removeDevice: (id) => deleteDoc(doc(db, "users", uid(), "devices", id)),

  async vapidPublicKey() {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("Could not load push configuration");
    return (await res.json()).vapidPublicKey;
  },

  createLinkToken: (kind, label) => api("/link-tokens", { method: "POST", body: { kind, label } }),
  listLinkTokens: async () => (await api("/link-tokens")).tokens,
  revokeLinkToken: (id) => api(`/link-tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
