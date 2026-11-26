// Firebase web config for the cloudboard-ffc48 project.
// Fill in apiKey, messagingSenderId and appId from:
// Firebase console → Project settings (⚙) → General → Your apps → Web app → "Config".
// (These values are public identifiers, not secrets. Security comes from firestore.rules.)
//
// While apiKey is a placeholder, the app runs in DEMO MODE with fake local data.
const PROJECT_ID = "cloudboard-ffc48";

const deployed = !["localhost", "127.0.0.1"].includes(location.hostname);

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  // Sign-in is proxied through this site (see vercel.json), which keeps Google sign-in
  // working on iPhone/iPad. Locally we fall back to the default Firebase domain.
  authDomain: deployed ? location.host : `${PROJECT_ID}.firebaseapp.com`,
  projectId: PROJECT_ID,
  storageBucket: `${PROJECT_ID}.firebasestorage.app`,
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

export const isConfigured = !firebaseConfig.apiKey.startsWith("YOUR_");
