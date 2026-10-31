import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyPool, AllKeysExhaustedError, parseKeys, isLimitError } from "./keyPool.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keypool-")), "userkey.json");

// Fake Decart client: keys listed in `bad` throw `error`, others return a token.
const fake = (bad = {}) => (apiKey) => ({
  tokens: {
    create: async () => {
      if (bad[apiKey]) throw bad[apiKey];
      return { apiKey: `tok-${apiKey}` };
    },
  },
});

test("parseKeys: comma/space separated, trimmed, deduped, fallback to DECART_API_KEY", () => {
  assert.deepEqual(parseKeys({ DECART_API_KEYS: " a, b ,a\nc " }), ["a", "b", "c"]);
  assert.deepEqual(parseKeys({ DECART_API_KEY: "solo" }), ["solo"]);
  assert.deepEqual(parseKeys({}), []);
});

test("isLimitError: statuses and messages", () => {
  assert.equal(isLimitError({ data: { status: 429 } }), true);
  assert.equal(isLimitError({ message: "Rate limit exceeded" }), true);
  assert.equal(isLimitError({ data: { status: 500 }, message: "boom" }), false);
  assert.equal(isLimitError(new Error("fetch failed")), false);
});

test("uses first key; skips exhausted key and persists it", async () => {
  const file = tmp();
  const pool = new KeyPool({
    keys: ["key-aaaaaaaa", "key-bbbbbbbb"],
    file,
    createClient: fake({ "key-aaaaaaaa": { data: { status: 429 }, message: "Too many requests" } }),
  });
  const { token, index } = await pool.createToken({});
  assert.equal(index, 1);
  assert.equal(token.apiKey, "tok-key-bbbbbbbb");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.exhausted.length, 1);
  assert.equal(saved.exhausted[0].key, "aaaaaaaa"); // only the last 8 chars, never the full key
  assert.deepEqual(pool.status(), { total: 2, available: 1, exhausted: 1 });
});

test("exhausted keys are remembered across restarts (new pool, same file)", async () => {
  const file = tmp();
  const keys = ["key-aaaaaaaa", "key-bbbbbbbb"];
  new KeyPool({ keys, file, createClient: fake() }).markExhausted(0, "limit");
  const { index } = await new KeyPool({ keys, file, createClient: fake() }).createToken({});
  assert.equal(index, 1);
});

test("network error does not burn the key", async () => {
  const file = tmp();
  const pool = new KeyPool({ keys: ["key-aaaaaaaa"], file, createClient: fake({ "key-aaaaaaaa": new Error("fetch failed") }) });
  await assert.rejects(() => pool.createToken({}), /fetch failed/);
  assert.equal(pool.status().exhausted, 0);
});

test("all keys exhausted -> AllKeysExhaustedError", async () => {
  const file = tmp();
  const limit = { data: { status: 402 }, message: "no credits" };
  const pool = new KeyPool({
    keys: ["key-aaaaaaaa", "key-bbbbbbbb"],
    file,
    createClient: fake({ "key-aaaaaaaa": limit, "key-bbbbbbbb": limit }),
  });
  await assert.rejects(() => pool.createToken({}), AllKeysExhaustedError);
  assert.equal(pool.status().available, 0);
});

test("new key added to .env works without touching userkey.json", async () => {
  const file = tmp();
  const old = new KeyPool({ keys: ["key-aaaaaaaa"], file, createClient: fake() });
  old.markExhausted(0, "limit");
  const next = new KeyPool({ keys: ["key-aaaaaaaa", "key-cccccccc"], file, createClient: fake() });
  assert.equal((await next.createToken({})).index, 1);
});
