// The URL where your CloudBoard web app is hosted (no trailing slash).
// Use the same domain you open CloudBoard on, e.g. "https://my-cloudboard.firebaseapp.com".
export const WEB_APP_URL = "https://YOUR_PROJECT_ID.firebaseapp.com";

// Pages allowed to pair with this extension (the web app plus local development servers).
export const APP_ORIGINS = [new URL(WEB_APP_URL).origin, "http://localhost:5000", "http://127.0.0.1:5000"];
