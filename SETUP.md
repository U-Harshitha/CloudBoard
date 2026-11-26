# Setting up CloudBoard

About 15 minutes. You need a Google account and Node.js 20+.

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Add project** (Google Analytics is not needed).
2. **Upgrade to the Blaze plan** (bottom-left ⚙ → *Usage and billing*). Cloud Functions require it.
   Personal use stays inside the free quota, but you can set a budget alert of e.g. $1 to be safe.
3. **Build → Authentication → Get started → Google → Enable**, then save.
4. **Build → Firestore Database → Create database** → production mode → pick a region near you.
5. **Project settings (⚙) → Your apps → Web (</>)**: register an app named *CloudBoard*.
   Copy the `firebaseConfig` values into **`web/js/firebase-config.js`**.
   Set `authDomain` to `YOUR_PROJECT_ID.firebaseapp.com` and open the app on that domain
   (not `.web.app`): Google sign-in on iPhone/iPad needs the two to match.

## 2. Install the Firebase CLI and link the project

```bash
npm install -g firebase-tools
firebase login
firebase use --add            # pick your project, alias "default"
```

(or put your project ID in `.firebaserc`)

## 3. Push notification keys (VAPID)

```bash
cd functions
npm install
npx web-push generate-vapid-keys
cp env.example .env           # then paste the PUBLIC key and your email into .env
firebase functions:secrets:set VAPID_PRIVATE_KEY     # paste the PRIVATE key when asked
cd ..
```

## 4. Deploy

```bash
firebase deploy
```

Open `https://YOUR_PROJECT_ID.firebaseapp.com` and sign in with Google. 🎉

## 5. Connect your devices

### Windows / Mac: browser extension (Chrome or Edge)
1. Edit **`extension/config.js`** and set `WEB_APP_URL` to your app URL.
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**,
   click **Load unpacked** and pick the `extension` folder.
3. Open CloudBoard → **Devices** → **Connect this browser**.
4. Optional, for use outside the browser: open `chrome://extensions/shortcuts`, find
   *Send your clipboard to CloudBoard* (Ctrl+Shift+1) and set it to **Global**. Then in *any* Windows app,
   press Ctrl+C followed by Ctrl+Shift+1 (Chrome must be running).

| Shortcut | What it does |
|---|---|
| Ctrl+Alt+C | Cloud-copy the selection (or the clipboard if nothing is selected) |
| Ctrl+Alt+V | Insert the latest cloud clip into the focused text field |
| Alt+Shift+C | Same as Ctrl+Alt+C; also works on pages where the content script can't run |
| Ctrl+Shift+1 | Send the clipboard (can be made global) |
| Right-click → Send to CloudBoard | Send selection, link or image URL |

> On keyboard layouts where Ctrl+Alt acts as AltGr (Polish, German…), Ctrl+Alt+C may type a character.
> Use Alt+Shift+C there, or rebind it at `chrome://extensions/shortcuts`.

### Android
1. Open the app in **Chrome** → menu ⋮ → **Install app**.
2. Open it from the home screen → **Turn on** notifications.
3. To send: in any app, **Share → CloudBoard**, or open CloudBoard → **Send clipboard**.
4. To receive: tap **Copy** on the notification.

### iPhone / iPad (iOS / iPadOS 16.4+)
1. Open the app in **Safari** → **Share** → **Add to Home Screen**.
2. Open it **from the Home Screen** → **Turn on** notifications.
3. To receive: tap the notification → tap **Copy to clipboard**.
4. To send: **Devices → Set up Shortcut** and follow the steps shown (they include your personal key and URLs).
   Add the *Send to CloudBoard* shortcut to Control Center or the Share sheet; on iPhone also to
   **Settings → Accessibility → Touch → Back Tap**.

## Troubleshooting

- **No notifications on iPhone/iPad**: CloudBoard must be opened from the Home Screen icon, not from Safari.
- **Sign-in popup closes immediately on iOS**: make sure `authDomain` matches the domain you're on.
- **Extension says "Pairing is only allowed from…"**: `extension/config.js` doesn't match the URL you
  opened. Fix it, then click reload on the extension in `chrome://extensions`.
- **Functions deploy fails with a secret error**: run step 3 again (`firebase functions:secrets:set VAPID_PRIVATE_KEY`).
- **Check logs**: `firebase functions:log`.
