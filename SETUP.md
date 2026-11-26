# Setting up CloudBoard (100% free, no credit card)

| Piece | Service | Plan |
|---|---|---|
| Google sign-in + Firestore database | Firebase project `cloudboard-ffc48` | **Spark** (free) |
| Website + API + push notifications | Vercel | **Hobby** (free) |

Neither needs a card. On Spark, Firebase can't bill you: if a daily limit is ever hit, it simply pauses until
the next day. (Limits: 50k reads and 20k writes per day, far more than personal use.)
Vercel's Hobby plan is for personal, non-commercial projects.

About 15 minutes.

## 1. Firebase (console.firebase.google.com → cloudboard-ffc48)

1. **Build → Authentication → Get started → Sign-in method → Google → Enable → Save.**
2. **Build → Firestore Database → Create database** → *Start in production mode* → choose a region near you.
3. **Firestore Database → Rules** tab: replace everything with the contents of
   [`firestore.rules`](firestore.rules) → **Publish**.
4. **Project settings (⚙) → General → Your apps → Add app → Web (</>)**, nickname *CloudBoard*
   (no need for Firebase Hosting). Copy `apiKey`, `messagingSenderId` and `appId` into
   [`web/js/firebase-config.js`](web/js/firebase-config.js), then commit and push.
   These values are public identifiers, so committing them is fine.
5. **Project settings → Service accounts → Generate new private key** → downloads a `.json` file.
   ⚠️ This one *is* secret: never commit it or share it. You'll paste it into Vercel in step 3.

## 2. Push notification keys

On any computer with Node.js:

```bash
npx web-push generate-vapid-keys
```

Keep the **Public Key** and **Private Key** for the next step.

## 3. Vercel

1. Sign up at <https://vercel.com/signup> with **Continue with GitHub** (Hobby plan).
2. **Add New… → Project → Import** `CloudBoard`. Framework preset: **Other**. Leave build settings empty.
3. Open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | the entire contents of the `.json` file from step 1.5 |
   | `VAPID_PUBLIC_KEY` | public key from step 2 |
   | `VAPID_PRIVATE_KEY` | private key from step 2 |
   | `VAPID_SUBJECT` | `mailto:` + your email |

4. **Deploy.** Vercel deploys the `main` branch, so merge this branch into `main` first
   (or pick the branch under *Settings → Git*). Every later push redeploys automatically.

You'll get an address like `https://cloudboard-xyz.vercel.app`. That's your app.

## 4. Allow sign-in from your Vercel address

1. Firebase console → **Authentication → Settings → Authorized domains → Add domain** →
   `cloudboard-xyz.vercel.app` (yours, without `https://`).
2. <https://console.cloud.google.com/apis/credentials?project=cloudboard-ffc48> → under *OAuth 2.0 Client IDs*
   open **Web client (auto created by Google Service)** → **Authorized redirect URIs → Add URI** →
   `https://cloudboard-xyz.vercel.app/__/auth/handler` → **Save**.
   (Sign-in runs through your own domain so it works on iPhone/iPad. Changes can take a few minutes.)

Open your Vercel address and sign in with Google. 🎉

## 5. Connect your devices

### Windows / Mac: browser extension (Chrome or Edge)
1. Set `WEB_APP_URL` in [`extension/config.js`](extension/config.js) to your Vercel address.
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode** →
   **Load unpacked** → pick the `extension` folder.
3. In CloudBoard, go to **Devices** → **Connect this browser**.
4. Optional, for use in any Windows app: at `chrome://extensions/shortcuts` set
   *Send your clipboard to CloudBoard* (Ctrl+Shift+1) to **Global**. Then press Ctrl+C, then Ctrl+Shift+1,
   anywhere (Chrome must be running).

| Shortcut | What it does |
|---|---|
| Ctrl+Alt+C | Cloud-copy the selection (or the clipboard if nothing is selected) |
| Ctrl+Alt+V | Insert the latest cloud clip into the focused text field |
| Alt+Shift+C | Same as Ctrl+Alt+C; also works where the page script can't run |
| Ctrl+Shift+1 | Send the clipboard (can be made global) |
| Right-click → Send to CloudBoard | Send selection, link or image address |

> On keyboard layouts where Ctrl+Alt acts as AltGr (Polish, German…), Ctrl+Alt+C may type a character.
> Use Alt+Shift+C there, or rebind it at `chrome://extensions/shortcuts`.

### Android
1. Open your CloudBoard address in **Chrome** → ⋮ → **Install app** (or *Add to Home screen*).
2. Open it from the home screen → **Turn on** notifications.
3. To send: **Share → CloudBoard** from any app, or **Send clipboard** in the app.
4. To receive: tap **Copy** on the notification.

### iPhone / iPad (iOS / iPadOS 16.4+)
1. Open your CloudBoard address in **Safari** → **Share** → **Add to Home Screen**.
2. Open it **from the Home Screen**, sign in → **Turn on** notifications.
3. To receive: tap the notification → **Copy to clipboard**.
4. To send: **Devices → Set up Shortcut** and follow the steps shown. Add the shortcut to Control Center
   or the Share sheet (and to Back Tap on iPhone).

## Troubleshooting

- **"redirect_uri_mismatch" or the sign-in page errors:** step 4.2 is missing, or hasn't taken effect yet.
- **"auth/unauthorized-domain":** step 4.1 is missing.
- **Sending works but no popups on other devices:** check the VAPID variables in Vercel, then turn
  notifications off and on again on the receiving device. Logs: Vercel → Project → **Logs**.
- **No notifications on iPhone/iPad:** CloudBoard must be opened from the Home Screen icon.
- **Extension says "Pairing is only allowed from…":** `extension/config.js` doesn't match the address
  you opened. Fix it, then press reload on the extension in `chrome://extensions`.
