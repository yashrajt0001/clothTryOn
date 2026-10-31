// Token server: keeps the permanent Decart API key secret and hands the extension
// short-lived keys that only work for the try-on model and for a limited session length.
import express from "express";
import path from "node:path";
import { KeyPool, AllKeysExhaustedError, parseKeys } from "./keyPool.js";

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.DECART_MODEL || "lucy-vton-latest";
const MAX_SESSION_SECONDS = Number(process.env.MAX_SESSION_SECONDS || 300);
const DAILY_SESSIONS = Number(process.env.DAILY_SESSIONS_PER_USER || 30);
// Optional: lock the server to your extension only (find the ID on chrome://extensions)
const EXTENSION_ID = process.env.EXTENSION_ID || "";

const keys = parseKeys();
if (!keys.length) {
  console.error("Missing API keys. Put DECART_API_KEYS=key1,key2,... in the .env file in the project folder.");
  process.exit(1);
}
const pool = new KeyPool({ keys });
const app = express();
app.set("trust proxy", 1); // behind Caddy on the VM: use the real client IP
app.use(express.json({ limit: "10kb" }));

// Only the extension (or the local preview page) may ask for tokens.
function originAllowed(origin) {
  if (!origin) return false;
  if (origin === `http://localhost:${PORT}`) return true;
  if (EXTENSION_ID) return origin === `chrome-extension://${EXTENSION_ID}`;
  return origin.startsWith("chrome-extension://");
}

app.use("/api", (req, res, next) => {
  const origin = req.get("origin");
  const allowed = originAllowed(origin);
  if (allowed) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
  if (!allowed) return res.status(403).json({ code: "forbidden_origin" });
  next();
});

// Simple per-user daily limit. Resets when the server restarts; use a database for real users.
const usage = new Map();
// Which key each install was last given, so a client can report "this key hit its limit".
const issued = new Map();

// Per-IP limit on token requests (a public server shouldn't let one client burn all keys).
const ipHits = new Map();
const IP_LIMIT_PER_MIN = Number(process.env.IP_LIMIT_PER_MIN || 20);
setInterval(() => ipHits.clear(), 60_000).unref();
function ipLimit(req, res, next) {
  const hits = (ipHits.get(req.ip) || 0) + 1;
  ipHits.set(req.ip, hits);
  if (hits > IP_LIMIT_PER_MIN) return res.status(429).json({ code: "too_many_requests" });
  next();
}

app.post("/api/tokens", ipLimit, async (req, res) => {
  const installId = String(req.body?.installId || "");
  if (!/^[0-9a-f-]{36}$/i.test(installId)) return res.status(400).json({ code: "missing_install_id" });

  const key = `${installId}:${new Date().toISOString().slice(0, 10)}`;
  const count = usage.get(key) || 0;
  if (count >= DAILY_SESSIONS) return res.status(429).json({ code: "daily_limit_reached" });

  try {
    const { token, index } = await pool.createToken({
      expiresIn: 120, // only needed to open the connection; the live session keeps going after it expires
      allowedModels: [MODEL],
      constraints: { realtime: { maxSessionDuration: MAX_SESSION_SECONDS } },
      metadata: { installId },
    });
    usage.set(key, count + 1);
    issued.set(installId, index);
    res.json({
      apiKey: token.apiKey,
      expiresAt: token.expiresAt,
      model: MODEL,
      maxSessionSeconds: MAX_SESSION_SECONDS,
    });
  } catch (err) {
    if (err instanceof AllKeysExhaustedError) {
      return res.status(503).json({ code: err.code, message: err.message });
    }
    console.error("Token error:", err);
    res.status(502).json({ code: "decart_error", message: err.message });
  }
});

// The widget calls this when the key it was given hit its limit while connecting/live.
app.post("/api/keys/exhausted", ipLimit, (req, res) => {
  const installId = String(req.body?.installId || "");
  const index = issued.get(installId);
  if (index === undefined) return res.status(400).json({ code: "unknown_install" });
  pool.markExhausted(index, req.body?.reason || "reported by client");
  issued.delete(installId);
  res.json(pool.status());
});

app.get("/api/health", (_req, res) => res.json({ ok: true, model: MODEL, keys: pool.status() }));

// Preview: the same widget as a normal web page, to test without installing the extension.
app.use("/preview", express.static(path.resolve("extension")));
app.get("/", (_req, res) => res.redirect("/preview/widget.html"));

app.listen(PORT, (err) => {
  if (err) {
    console.error(
      err.code === "EADDRINUSE"
        ? `Port ${PORT} is already used by another program. Close it, or set PORT in .env (and SERVER_URL in src/config.js).`
        : `Server failed to start: ${err.message}`
    );
    process.exit(1);
  }
  console.log(`Try-on server running: http://localhost:${PORT}`);
  const { total, available } = pool.status();
  console.log(`API keys: ${available} available of ${total}`);
  if (!available) console.error("All API keys are exhausted. Add new keys to DECART_API_KEYS in .env and restart.");
  console.log(`Preview page:          http://localhost:${PORT}/preview/widget.html`);
});
