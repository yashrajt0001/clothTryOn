// API key pool. Keys come from DECART_API_KEYS (comma separated) in .env.
// A key that hits its limit is written to server/userkey.json and never used again
// (limits don't recover). Replace/add keys in .env to continue; no code change needed.
import fs from "node:fs";
import path from "node:path";
import { createDecartClient } from "@decartai/sdk";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

// Structured logs. Silent in production except errors. Never pass keys in fields.
function log(level, msg, fields = {}) {
  if (LEVELS[level] < LEVEL) return;
  if (process.env.NODE_ENV === "production" && level !== "error") return;
  const out = level === "debug" || level === "info" ? "log" : level;
  console[out](JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
}

export class AllKeysExhaustedError extends Error {
  constructor() {
    super("All API keys are exhausted. Add new keys to DECART_API_KEYS in .env and restart the server.");
    this.code = "all_keys_exhausted";
  }
}

export function parseKeys(env = process.env) {
  const raw = env.DECART_API_KEYS || env.DECART_API_KEY || "";
  return [...new Set(raw.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean))];
}

// Decart SDK errors are plain objects: { code, message, data: { status } }
export function isLimitError(err) {
  const status = err?.data?.status ?? err?.status;
  if ([401, 402, 403, 429].includes(status)) return true;
  return /rate.?limit|too many|quota|credit|exceed|limit reached/i.test(String(err?.message || ""));
}

export class KeyPool {
  constructor({
    keys,
    file = path.resolve("server/userkey.json"),
    createClient = (apiKey) => createDecartClient({ apiKey }),
  }) {
    this.keys = keys;
    this.file = file;
    this.createClient = createClient;
    this.clients = [];
  }

  // userkey.json: { "exhausted": [{ "key": "<last 8 chars>", "reason": "...", "at": "..." }] }
  // Read every time, so editing/deleting the file takes effect without a restart.
  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(data.exhausted) ? data.exhausted : [];
    } catch {
      return [];
    }
  }

  isExhausted(index, list = this.load()) {
    return list.some((e) => this.keys[index].endsWith(e.key));
  }

  markExhausted(index, reason) {
    const list = this.load();
    if (this.isExhausted(index, list)) return;
    list.push({
      key: this.keys[index].slice(-8),
      reason: String(reason ?? "unknown").slice(0, 200),
      at: new Date().toISOString(),
    });
    fs.writeFileSync(this.file, JSON.stringify({ exhausted: list }, null, 2));
    log("warn", "key exhausted", { index, reason: String(reason).slice(0, 200), ...this.status() });
  }

  nextIndex() {
    const list = this.load();
    return this.keys.findIndex((_, i) => !this.isExhausted(i, list));
  }

  status() {
    const list = this.load();
    const exhausted = this.keys.filter((_, i) => this.isExhausted(i, list)).length;
    return { total: this.keys.length, available: this.keys.length - exhausted, exhausted };
  }

  // Try keys in order; a key that hits a limit is retired and the next one is used.
  async createToken(options) {
    for (;;) {
      const index = this.nextIndex();
      if (index === -1) {
        log("error", "all keys exhausted", this.status());
        throw new AllKeysExhaustedError();
      }
      try {
        const client = (this.clients[index] ??= this.createClient(this.keys[index]));
        const token = await client.tokens.create(options);
        log("debug", "token issued", { index });
        return { token, index };
      } catch (err) {
        if (!isLimitError(err)) throw err; // network/server hiccup: don't burn the key
        this.markExhausted(index, err?.message || err?.data?.status);
      }
    }
  }
}
