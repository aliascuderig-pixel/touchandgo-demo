// Verifica health.js: chiave mancante -> 503 senza rete; chiamata Anthropic
// ok/ko/timeout -> 200/503 con motivo. Fetch finto, nessuna rete reale.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const handlerPath = path.join(__dirname, "..", "health.js");
function freshHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath).handler;
}

const originalFetch = global.fetch;
const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.ANTHROPIC_API_KEY = originalKey;
});

test("chiave assente: 503 senza nemmeno provare a chiamare Anthropic", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let called = false;
  global.fetch = () => { called = true; return Promise.resolve({ status: 200 }); };
  const handler = freshHandler();
  const res = await handler();
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).reason, "missing_api_key");
  assert.equal(called, false);
});

test("Anthropic risponde 200: healthy", async () => {
  global.fetch = (url, opts) => {
    assert.match(url, /\/v1\/models\/claude-sonnet-5$/);
    assert.equal(opts.method, "GET");
    assert.equal(opts.headers["x-api-key"], "test-key");
    return Promise.resolve({ status: 200 });
  };
  const handler = freshHandler();
  const res = await handler();
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test("Anthropic risponde 401: unhealthy con motivo esplicito", async () => {
  global.fetch = () => Promise.resolve({ status: 401 });
  const handler = freshHandler();
  const res = await handler();
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).reason, "anthropic_auth_failed");
});

test("fetch che lancia (rete giù): unhealthy", async () => {
  global.fetch = () => Promise.reject(new Error("ECONNREFUSED"));
  const handler = freshHandler();
  const res = await handler();
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).reason, "anthropic_unreachable");
});

test("timeout (AbortError): unhealthy con motivo timeout", async () => {
  global.fetch = () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  };
  const handler = freshHandler();
  const res = await handler();
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).reason, "anthropic_timeout");
});
