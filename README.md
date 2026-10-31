# Live Try-On (Chrome extension + Decart AI)

Works like Anywear: hover a product picture on a clothing shop, click **Try On**, and see yourself wearing it
live on your webcam. Decart's realtime AI model (`lucy-vton-latest`) redraws every camera frame with the garment.

## Parts

| Folder / file | What it does |
|---|---|
| `server/index.js` | Keeps your Decart key secret. Gives the extension short-lived keys (try-on model only, max 5-minute sessions, 30 sessions per day). |
| `extension/` | The Chrome extension you load into Chrome. |
| `extension/content.js` | Runs on shop pages: finds clothing shops, shows the "Try On" button, picks the right picture, clicks the shop's "Add to cart". |
| `extension/widget.html` + `src/widget.js` | The try-on window: camera → Decart AI → video. |
| `extension/background.js` | Toolbar button, "open in its own window" fallback. |
| `src/config.js` | Server address and auto-stop timers. |

## First-time setup

1. `.env` in this folder must contain `DECART_API_KEY=...` (already done).
2. Double-click **`start.bat`** (or run `npm install` once, then `npm start`). Keep that window open.
3. In Chrome open `chrome://extensions` → turn on **Developer mode** (top right) → **Load unpacked** →
   choose the `D:\clothTryOn\extension` folder.

## Use it

1. Keep `start.bat` running.
2. Open a clothing shop (Zara, H&M, Myntra, Gymshark, any Shopify store…).
3. Hover a product picture → click **Try On** → allow the camera.
4. After a few seconds you see yourself wearing it. Click **Try On** on other items to switch instantly.
5. Change the item type in the dropdown if the AI puts it in the wrong place (e.g. pants vs top).
6. On a product page, **Add to cart** clicks the shop's own button.

Not showing on a site? Click the extension's toolbar icon to turn it on for that page.

**Test without the extension:** with the server running, open http://localhost:3000 — the same try-on window as a
normal page; choose or drop a garment picture.

## Saving credits

Decart charges per second of live video. The widget stops by itself after 90 s with no action, after 20 s in a
hidden tab, and at the 5-minute session cap. Press **Stop** or **✕** when done.

## Settings (`.env`)

| Name | Default | Meaning |
|---|---|---|
| `DECART_API_KEY` | — | Your Decart key (never put it in the extension) |
| `PORT` | 3000 | Server port (also change `SERVER_URL` in `src/config.js`, then `npm run build`) |
| `MAX_SESSION_SECONDS` | 300 | Longest single try-on session |
| `DAILY_SESSIONS_PER_USER` | 30 | Sessions per person per day |
| `EXTENSION_ID` | any | Lock the server to your extension (ID from `chrome://extensions`) |

After changing anything in `src/`, run `npm run build` and press the reload icon on the extension card.
