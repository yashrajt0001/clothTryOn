// Try-on widget: camera → Decart realtime try-on model → video of you wearing the garment.
// Runs inside an iframe on shop pages, in its own popup window, or as a plain preview page.
import { createDecartClient, models } from "@decartai/sdk";
import { SERVER_URL, IDLE_STOP_SECONDS, HIDDEN_STOP_SECONDS } from "./config.js";

const $ = (id) => document.getElementById(id);
const els = {
  local: $("local"),
  output: $("output"),
  status: $("status"),
  timer: $("timer"),
  thumb: $("thumb"),
  category: $("category"),
  cart: $("cart"),
  product: $("product"),
  resume: $("resume"),
  openWindow: $("openWindow"),
  grow: $("grow"),
};

const params = new URLSearchParams(location.hash.slice(1));
const widgetId = params.get("id") || "";
const tabId = Number(params.get("tab")) || null; // set when opened as a separate window
const inFrame = window.parent !== window;
const isExtension = typeof chrome !== "undefined" && !!chrome.runtime?.id;
if (!inFrame) {
  document.body.classList.add("standalone");
  els.grow.hidden = true;
}

let rt = null; // live Decart session
let camera = null;
let starting = false;
let run = 0; // goes up every time a session is stopped
let garment = null; // { url?, blob?, title, category, image }
let pageProduct = null; // product found on the current shop page
let loadSeq = 0;
let sessionStart = 0;
let maxSeconds = 0;
let lastAction = Date.now();
let hiddenSince = 0;

class UserError extends Error {}

// ---------- talking to the shop page ----------
function toPage(type, extra = {}) {
  const msg = { type, widgetId, ...extra };
  if (inFrame) {
    const origin = location.ancestorOrigins?.[0];
    if (origin) window.parent.postMessage(msg, origin);
  } else if (isExtension && tabId) {
    chrome.runtime.sendMessage({ type: "TO_TAB", tabId, msg }).catch(() => {});
  }
}

if (isExtension) {
  // The page's content script talks to us through the extension (the shop's own scripts can't).
  chrome.runtime.onMessage.addListener((msg) => {
    if (!widgetId || msg?.widgetId !== widgetId) return;
    if (msg.type === "TRY_ON") {
      if (!inFrame) chrome.windows?.getCurrent((w) => chrome.windows.update(w.id, { focused: true }));
      tryOn(msg.garment, msg.cart);
    } else if (msg.type === "PAGE_PRODUCT") {
      pageProduct = msg.garment;
      els.product.hidden = !pageProduct;
      setCart(msg.cart);
    } else if (msg.type === "STOP") {
      stop();
    }
  });
}

function setCart(available) {
  els.cart.hidden = !available || !(inFrame || tabId);
}

// ---------- status + modes ----------
function setMode(mode) {
  document.body.dataset.mode = mode; // idle | starting | live
  els.resume.hidden = !(mode === "idle" && garment);
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

function fail(err) {
  console.error(err);
  const message = err instanceof UserError ? err.message : `Something went wrong: ${err?.message || err}`;
  if (!rt) {
    cleanup();
    setMode("idle");
  }
  setStatus(message, "error");
}

// ---------- the try-on flow ----------
async function tryOn(g, cart) {
  if (!g) return;
  lastAction = Date.now();
  if (cart !== undefined) setCart(cart);
  const seq = ++loadSeq;
  const category = [...els.category.options].some((o) => o.value === g.category) ? g.category : els.category.value;
  els.category.value = category;
  els.openWindow.hidden = true;

  const myRun = run;
  try {
    if (!rt) setMode("starting");
    setStatus("Loading garment…");
    const image = g.image || (await loadGarmentImage(g));
    if (seq !== loadSeq) return; // a newer garment was picked meanwhile
    if (myRun !== run) return; // Stop was pressed while loading
    garment = { ...g, category, image };
    showThumb(image);

    if (starting) return; // start() picks up the newest garment when it's connected
    if (!rt) await start();
    else await apply();
  } catch (err) {
    if (seq === loadSeq) fail(err);
  }
}

async function start() {
  starting = true;
  setMode("starting");
  const myRun = run; // changes if the user presses Stop while we're still connecting
  try {
    const model = models.realtime("lucy-vton-latest");
    setStatus("Starting camera…");
    const cam = await openCamera(model);
    if (myRun !== run) return cam.getTracks().forEach((t) => t.stop());
    camera = cam;
    els.local.srcObject = camera;

    setStatus("Connecting to the AI…");
    const token = await getToken();
    if (myRun !== run) return;
    maxSeconds = token.maxSessionSeconds || 0;
    const client = createDecartClient({ apiKey: token.apiKey });
    const first = garment;
    const session = await client.realtime.connect(camera, {
      model: models.realtime(token.model || "lucy-vton-latest"),
      mirror: true, // webcams show you like a mirror
      initialState: { image: first.image, prompt: { text: buildPrompt(first), enhance: true } },
      onRemoteStream: (stream) => {
        els.output.srcObject = stream;
        els.output.play().catch(() => {});
      },
      onQueuePosition: ({ position, queueSize }) => setStatus(`Waiting for a free AI slot: ${position} of ${queueSize}`),
    });
    if (myRun !== run) return session.disconnect();
    rt = session;
    rt.on("connectionChange", (state) => {
      if (state === "reconnecting") setStatus("Connection dropped, reconnecting…");
      if (state === "generating" && document.body.dataset.mode === "live") setStatus("");
      // give the SDK a moment to reconnect by itself before giving up
      if (state === "disconnected") {
        setTimeout(() => {
          if (rt === session && session.getConnectionState() === "disconnected") {
            stop("Disconnected from the AI. Press “Try again” to reconnect.");
          }
        }, 8000);
      }
    });
    rt.on("sessionEnded", ({ reason }) => stop(endMessage(reason)));
    rt.on("error", (err) => console.warn("Decart:", err));
    sessionStart = Date.now();
    if (els.output.readyState >= 2) showLive();
    else setStatus("Dressing you up…");
    if (garment !== first) await apply(); // user picked another item while connecting
  } catch (err) {
    if (myRun !== run) return; // stopped on purpose, not an error
    cleanup();
    throw err;
  } finally {
    starting = false;
  }
}

async function apply() {
  if (!rt || !garment) return;
  setStatus("Changing outfit…");
  await rt.set({ image: garment.image, prompt: buildPrompt(garment), enhance: true });
  if (document.body.dataset.mode === "live") setStatus("");
}

// The first AI frame has arrived.
function showLive() {
  if (!rt) return;
  setMode("live");
  setStatus("");
}
els.output.addEventListener("playing", showLive);

function cleanup() {
  run++;
  const session = rt;
  rt = null;
  session?.disconnect();
  camera?.getTracks().forEach((t) => t.stop());
  camera = null;
  els.local.srcObject = null;
  els.output.srcObject = null;
  sessionStart = 0;
}

function stop(message = "") {
  cleanup();
  setMode("idle");
  setStatus(message, message ? "info" : "");
}

function endMessage(reason = "") {
  if (/duration|time|limit/i.test(reason)) return "Session time is up. Pick a garment to start a new one.";
  if (/nsfw|moderat|safety/i.test(reason)) return "Session stopped by the safety filter.";
  return `Session ended${reason ? ` (${reason})` : ""}. Pick a garment to start again.`;
}

// ---------- camera, token, image ----------
async function openCamera(model) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: model.width }, height: { ideal: model.height }, frameRate: model.fps },
    });
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      if (inFrame && isExtension) els.openWindow.hidden = false;
      throw new UserError(
        inFrame && isExtension
          ? "Camera is blocked. Allow it (camera icon in the address bar), or this shop may block cameras — use “Open in its own window”."
          : "Camera is blocked. Allow camera access and try again."
      );
    }
    if (err.name === "NotFoundError") throw new UserError("No camera found.");
    if (err.name === "NotReadableError") throw new UserError("Camera is being used by another app.");
    throw err;
  }
}

async function getInstallId() {
  if (isExtension) {
    const { installId } = await chrome.storage.local.get("installId");
    if (installId) return installId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ installId: id });
    return id;
  }
  try {
    let id = localStorage.getItem("installId");
    if (!id) localStorage.setItem("installId", (id = crypto.randomUUID()));
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

async function getToken() {
  let res;
  try {
    res = await fetch(`${SERVER_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: await getInstallId() }),
    });
  } catch {
    throw new UserError(`Can't reach the try-on server at ${SERVER_URL}. Is it running? (npm start)`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new UserError("Daily try-on limit reached. Try again tomorrow.");
  if (res.status === 403) throw new UserError("The server didn't accept this extension. Check EXTENSION_ID in .env.");
  if (!res.ok) throw new UserError(`Server error: ${data.message || data.code || res.status}`);
  return data;
}

// Download the garment picture and turn it into a clean JPEG (max 1200px), like the model expects.
async function loadGarmentImage(g) {
  let blob = g.blob;
  if (!blob) {
    let res;
    try {
      res = await fetch(g.url, { credentials: "omit" });
    } catch {
      throw new UserError("Couldn't download that picture. Save it and drop it here instead.");
    }
    if (!res.ok) throw new UserError(`Couldn't download that picture (error ${res.status}).`);
    blob = await res.blob();
  }
  if (!blob.type.startsWith("image/")) throw new UserError("That isn't a picture.");
  if (blob.size > 15 * 1024 * 1024) throw new UserError("That picture is too big.");

  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    throw new UserError("Couldn't read that picture format.");
  }
  const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; // see-through PNGs get a white background
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.95));
}

function buildPrompt({ title, category }) {
  const name = (title || "")
    .replace(/[$€£₹]\s?[\d.,]+|\s+/g, " ")
    .trim()
    .slice(0, 80);
  const item = name ? `the ${name} shown in the reference image` : "the garment shown in the reference image";
  switch (category) {
    case "bottom": return `Substitute the current pants with ${item}`;
    case "dress": return `Substitute the current outfit with ${item}`;
    case "outerwear": return `Add ${item} over the current outfit`;
    case "shoes": return `Substitute the current shoes with ${item}`;
    case "hat": return `Add ${item} to the person's head`;
    case "eyewear": return `Add ${item} to the person's face`;
    default: return `Substitute the current top with ${item}`;
  }
}

let thumbUrl = "";
function showThumb(blob) {
  URL.revokeObjectURL(thumbUrl);
  thumbUrl = URL.createObjectURL(blob);
  els.thumb.src = thumbUrl;
  els.thumb.hidden = false;
}

// ---------- timers: save credits ----------
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
setInterval(() => {
  if (!sessionStart) {
    els.timer.textContent = "";
    return;
  }
  const secs = Math.floor((Date.now() - sessionStart) / 1000);
  els.timer.textContent = maxSeconds ? `${fmt(secs)} / ${fmt(maxSeconds)}` : fmt(secs);
  if (Date.now() - lastAction > IDLE_STOP_SECONDS * 1000) stop("Paused to save credits. Press “Try again” to continue.");
  else if (hiddenSince && Date.now() - hiddenSince > HIDDEN_STOP_SECONDS * 1000) stop("Paused because the tab was hidden.");
}, 1000);

document.addEventListener("visibilitychange", () => {
  hiddenSince = document.hidden ? Date.now() : 0;
});
["pointermove", "pointerdown", "keydown"].forEach((t) =>
  window.addEventListener(t, () => (lastAction = Date.now()), { passive: true })
);

// ---------- buttons ----------
$("close").addEventListener("click", () => {
  stop();
  if (inFrame) toPage("CLOSE");
  else window.close();
});

$("stop").addEventListener("click", () => stop());

els.resume.addEventListener("click", () => garment && tryOn(garment));
els.product.addEventListener("click", () => pageProduct && tryOn(pageProduct));

els.category.addEventListener("change", () => {
  if (!garment) return;
  garment = { ...garment, category: els.category.value };
  lastAction = Date.now();
  apply().catch(fail);
});

els.cart.addEventListener("click", () => {
  toPage("ADD_TO_CART");
  setStatus("Added to cart on the shop page");
  setTimeout(() => els.status.textContent === "Added to cart on the shop page" && setStatus(""), 2500);
});

let big = false;
els.grow.addEventListener("click", () => {
  big = !big;
  toPage("RESIZE", { big });
});

els.openWindow.addEventListener("click", () => {
  const g = garment?.url ? { url: garment.url, title: garment.title, category: garment.category } : null;
  chrome.runtime.sendMessage({ type: "OPEN_WINDOW", widgetId, garment: g }).catch(() => {});
  toPage("MOVED_TO_WINDOW");
});

$("snap").addEventListener("click", () => {
  const v = els.output;
  if (!v.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  c.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `try-on-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
});

// ---------- pick a garment by file, drop, or paste ----------
const fromBlob = (blob) => tryOn({ blob, title: "", category: els.category.value });

$("file").addEventListener("change", (e) => {
  if (e.target.files[0]) fromBlob(e.target.files[0]);
  e.target.value = "";
});

window.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) fromBlob(file);
});

["dragenter", "dragover"].forEach((t) =>
  window.addEventListener(t, (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  })
);
["dragleave", "drop"].forEach((t) => window.addEventListener(t, () => document.body.classList.remove("dragging")));
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) return fromBlob(file);
  const url = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain")).split("\n")[0].trim();
  if (/^(https?:|data:image\/)/.test(url)) tryOn({ url, title: "", category: els.category.value });
});

// Release the camera and the paid AI session when the widget goes away.
window.addEventListener("pagehide", () => {
  cleanup();
  if (!inFrame) toPage("WINDOW_CLOSED");
});

// ---------- start ----------
setMode("idle");
const startGarment = params.get("garment");
if (startGarment) {
  try {
    tryOn(JSON.parse(startGarment));
  } catch {}
}
toPage("READY");
