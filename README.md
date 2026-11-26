# CloudBoard

Your personal cloud clipboard. Copy on one device, paste on another: Windows, Mac, Android, iPhone and iPad.

- **Ctrl + Alt + C** cloud-copies the selected text (or your clipboard if nothing is selected).
  Normal Ctrl + C stays local, so only what you choose is synced.
- **Ctrl + Alt + V** types your latest cloud clip into the field you're in.
- On your **other devices** a notification pops up with a **Copy** button. On computers with the
  extension, the clip lands straight on the clipboard, so a plain Ctrl + V pastes it.

No native apps: it's a website (installable as an app) plus an optional browser extension and iOS Shortcut.

| Device | Send | Receive |
|---|---|---|
| Windows / Mac (Chrome, Edge) + extension | Ctrl+Alt+C, right-click → *Send to CloudBoard* | Automatic: straight onto your clipboard |
| Android (installed web app) | Share → CloudBoard, or *Send clipboard* in the app | Notification → **Copy** |
| iPhone / iPad (web app on Home Screen) | Shortcut from Control Center / Share sheet / Back Tap | Notification → tap → **Copy** |
| Any browser | Paste into cloudboard web app | Click a clip to copy |

## Project layout

```
web/         The web app (PWA). Plain HTML/CSS/JS, no build step. Hosted on Vercel.
  js/app.js              UI logic
  js/backend-firebase.js Firebase Auth + Firestore + API calls
  js/backend-demo.js     In-memory backend for demo mode
  js/firebase-config.js  ← your Firebase config goes here
  sw.js                  Service worker: push notifications with a Copy action
api/index.js Vercel serverless entry point → server/handler.js
server/
  handler.js REST API: creates clips, sends Web Push to your other devices, access keys
  lib.js     Pure helpers (unit-tested)
  dev.js     Local dev server (web app + API on http://localhost:5000)
extension/   Chrome / Edge extension (Manifest V3)
  config.js  ← your web app URL goes here
firestore.rules   Users can only read/write their own data
```

## How it works

1. Every device sends clips to `POST /api/clips`, which saves them in Firestore at
   `users/{uid}/clips/{id}`.
2. The API then sends an encrypted **Web Push** message to every *other* device of that user
   and keeps only the latest 50 clips. The web app also watches Firestore live.
3. The web app's service worker shows a notification with a **Copy** button; the extension writes the clip
   to the system clipboard.

The extension and the Shortcut authenticate with revocable **access keys** (`cb_…`) created from the
web app's *Devices* tab. Only a SHA-256 hash of each key is stored.

## Try it without setting anything up

Serve the `web/` folder (e.g. `npx serve web`) and open it. Until the Firebase `apiKey` is filled in,
it runs in **demo mode** with sample data.

**Free to run:** Firebase Spark plan (Auth + Firestore) and Vercel Hobby (website + API). No credit card.

**Ready to go live? Follow [SETUP.md](SETUP.md).**

## Development

```bash
npm install
npm test               # unit tests
npm run emulators      # terminal 1: Firebase Auth + Firestore emulators (needs firebase-tools + Java)
npm run dev            # terminal 2: web app + API on http://localhost:5000
```

On `localhost` the web app and API automatically use the emulators. Put VAPID keys in a `.env` file
(see `env.example`) to test push locally.
