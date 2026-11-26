// Local development server: serves web/ and the API on http://localhost:5000.
//
//   npm run emulators   (terminal 1: Firebase Auth + Firestore emulators)
//   npm run dev         (terminal 2)
//
// Reads VAPID keys etc. from a .env file in the project root, if present.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}
// Use the emulators unless a real service account was provided.
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
  process.env.FIREBASE_PROJECT_ID ||= "demo-cloudboard";
}

const handler = require("./handler");
const web = path.join(root, "web");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
const port = Number(process.env.PORT) || 5000;

http
  .createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (pathname === "/api" || pathname.startsWith("/api/")) return handler(req, res);
    let file = path.join(web, pathname);
    if (!file.startsWith(web) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(web, "index.html");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`CloudBoard dev server on http://localhost:${port}`));
