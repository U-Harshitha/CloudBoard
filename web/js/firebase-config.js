// Paste your Firebase web app config here
// (Firebase console → Project settings → Your apps → Web app → SDK setup → Config).
//
// TIP: set authDomain to the domain you open CloudBoard on
// (e.g. "your-project.firebaseapp.com") so Google sign-in works smoothly on iPhone/iPad.
//
// While these are placeholders the app runs in DEMO MODE with fake local data.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

export const isConfigured = !firebaseConfig.apiKey.startsWith("YOUR_");
