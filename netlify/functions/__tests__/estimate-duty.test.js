// Verifica netlify/functions/estimate-duty.js — stima dazi doganali SOLO
// informativa (vedi MANUALE.md per i 5 vincoli non negoziabili decisi con
// Giuseppe). Copre in particolare:
// (2) il testo del disclaimer è sempre presente nel PROMPT costruito lato
//     server (System prompt fisso, testabile senza chiamare Anthropic).
// (4) nessuna regressione: rate limiting, validazione, ogni tipo di
//     risposta (200/400/429/500/502/errore Anthropic inoltrato).
//
// Il punto (1) (un fallimento non blocca il resto del flusso) e il punto
// (3) (isolamento dal calcolo prezzo) sono verificati lato client in
// dist/assets/__tests__/duty-estimate.test.js, non qui: qui c'è solo la
// function, il flusso "non bloccante" è una proprietà di app.js
// (runClassification() non fa mai await su questa chiamata).
//
// Stesso pattern di mocking già usato in questo repository:
// @netlify/blobs finto (rate limit) + global.fetch finto (Anthropic).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

let stores = {};
function resetStores() {
  stores = {};
}
const fakeBlobsModule = {
  getStore(opts) {
    const name = typeof opts === "string" ? opts : opts.name;
    if (!stores[name]) stores[name] = new Map();
    const store = stores[name];
    return {
      async get(key, { type } = {}) {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      async setJSON(key, value) {
        store.set(key, JSON.stringify(value));
      },
      async list() {
        return { blobs: Array.from(store.keys()).map((key) => ({ key })) };
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@netlify/blobs") return fakeBlobsModule;
  return originalLoad.call(this, request, ...args);
};

const handlerPath = path.join(__dirname, "..", "estimate-duty.js");
function freshModule() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath);
}

function makeEvent(body, ip) {
  return {
    httpMethod: "POST",
    headers: { "x-nf-client-connection-ip": ip || "127.0.0.1" },
    body: JSON.stringify(body || {}),
  };
}

const originalFetch = global.fetch;
const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  resetStores();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.ANTHROPIC_API_KEY = originalKey;
});

function mockAnthropicFetch(replyText) {
  let lastCall = null;
  global.fetch = (url, opts) => {
    lastCall = { url, body: JSON.parse(opts.body) };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: replyText || "Stima di prova." }] }),
    });
  };
  return () => lastCall;
}

// ---------------------------------------------------------------------
// (2) Il disclaimer è nel prompt costruito lato server — testato SENZA
// chiamare Anthropic, sulla stringa fissa che il server invia come
// "system" ad ogni richiesta.
// ---------------------------------------------------------------------

test('(2) DUTY_ESTIMATE_SYSTEM_PROMPT contiene il disclaimer esatto, parola per parola', () => {
  const mod = freshModule();
  assert.ok(mod.DUTY_ESTIMATE_SYSTEM_PROMPT.includes(mod.DUTY_ESTIMATE_DISCLAIMER), "il prompt fisso deve contenere il testo esatto del disclaimer");
  assert.equal(
    mod.DUTY_ESTIMATE_DISCLAIMER,
    "Stima indicativa, non vincolante — verifica sempre con le autorità doganali del paese di destinazione prima di partire."
  );
});

test('(2) il prompt istruisce esplicitamente di includere SEMPRE il disclaimer nella risposta', () => {
  const mod = freshModule();
  assert.match(mod.DUTY_ESTIMATE_SYSTEM_PROMPT, /SEMPRE/);
  assert.match(mod.DUTY_ESTIMATE_SYSTEM_PROMPT, /disclaimer/i);
});

test('(2) il prompt istruisce di dichiarare esplicitamente un contesto insufficiente invece di inventare un numero', () => {
  const mod = freshModule();
  assert.match(mod.DUTY_ESTIMATE_SYSTEM_PROMPT, /non inventare/i);
  assert.match(mod.DUTY_ESTIMATE_SYSTEM_PROMPT, /non ha[i]? un contesto|non affidabile/i);
});

test('il prompt istruisce esplicitamente a non collegare la stima al prezzo del servizio Touch&Go', () => {
  const mod = freshModule();
  assert.match(mod.DUTY_ESTIMATE_SYSTEM_PROMPT, /non fa parte.*prezzo/i);
});

test('(2) end-to-end: il "system" inviato realmente ad Anthropic è esattamente DUTY_ESTIMATE_SYSTEM_PROMPT', async () => {
  const mod = freshModule();
  const getLastCall = mockAnthropicFetch("15% circa, circa 20€. " + mod.DUTY_ESTIMATE_DISCLAIMER);
  const res = await mod.handler(makeEvent({ hs_code: "691200", category: "Ceramica", weight_kg: 1.2, value_eur: 80, country: "Stati Uniti" }, "1.1.1.1"));
  assert.equal(res.statusCode, 200);
  const call = getLastCall();
  assert.equal(call.body.system, mod.DUTY_ESTIMATE_SYSTEM_PROMPT);
  assert.ok(call.body.system.includes(mod.DUTY_ESTIMATE_DISCLAIMER));
});

// ---------------------------------------------------------------------
// buildDutyEstimateUserMessage — parte variabile del prompt.
// ---------------------------------------------------------------------

test("buildDutyEstimateUserMessage include tutti i dati forniti", () => {
  const mod = freshModule();
  const msg = mod.buildDutyEstimateUserMessage({ hsCode: "691200", category: "Ceramica", weightKg: 1.2, valueEur: 80, country: "Stati Uniti", lang: "it" });
  assert.match(msg, /691200/);
  assert.match(msg, /Ceramica/);
  assert.match(msg, /1\.2 kg/);
  assert.match(msg, /€80/);
  assert.match(msg, /Stati Uniti/);
});

test("buildDutyEstimateUserMessage gestisce campi mancanti senza inventare valori", () => {
  const mod = freshModule();
  const msg = mod.buildDutyEstimateUserMessage({ country: "Giappone" });
  assert.match(msg, /non disponibile/);
  assert.match(msg, /Giappone/);
});

test("buildDutyEstimateUserMessage rispetta lang: en/it", () => {
  const mod = freshModule();
  assert.match(mod.buildDutyEstimateUserMessage({ country: "USA", lang: "en" }), /Rispondi in inglese/);
  assert.match(mod.buildDutyEstimateUserMessage({ country: "USA", lang: "it" }), /Rispondi in italiano/);
  assert.match(mod.buildDutyEstimateUserMessage({ country: "USA" }), /Rispondi in italiano/, "default italiano se lang non specificato");
});

// ---------------------------------------------------------------------
// (4) Nessuna regressione — validazione, rate limit, ogni tipo di risposta.
// ---------------------------------------------------------------------

test("country mancante: 400, nessuna chiamata ad Anthropic", async () => {
  const mod = freshModule();
  let called = false;
  global.fetch = () => { called = true; return Promise.reject(new Error("non deve mai essere chiamato")); };
  const res = await mod.handler(makeEvent({ hs_code: "691200" }, "2.2.2.2"));
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test("metodo diverso da POST: 405", async () => {
  const mod = freshModule();
  const res = await mod.handler({ httpMethod: "GET", headers: {} });
  assert.equal(res.statusCode, 405);
});

test("rate limiting: oltre 20 richieste/ora dallo stesso IP -> 429", async () => {
  const mod = freshModule();
  mockAnthropicFetch();
  let lastRes;
  for (let i = 0; i < 21; i++) {
    lastRes = await mod.handler(makeEvent({ hs_code: "691200", country: "Francia" }, "3.3.3.3"));
  }
  assert.equal(lastRes.statusCode, 429);
});

test("ANTHROPIC_API_KEY assente: 500 esplicito", async () => {
  const mod = freshModule();
  delete process.env.ANTHROPIC_API_KEY;
  const res = await mod.handler(makeEvent({ hs_code: "691200", country: "Francia" }, "4.4.4.4"));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error.message, /ANTHROPIC_API_KEY/);
});

test("risposta AI vuota: 502", async () => {
  const mod = freshModule();
  global.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ content: [] }) });
  const res = await mod.handler(makeEvent({ hs_code: "691200", country: "Francia" }, "5.5.5.5"));
  assert.equal(res.statusCode, 502);
});

test("errore Anthropic (es. 401) inoltrato con lo stesso status", async () => {
  const mod = freshModule();
  global.fetch = () => Promise.resolve({ ok: false, status: 401, json: async () => ({ error: { message: "invalid api key" } }) });
  const res = await mod.handler(makeEvent({ hs_code: "691200", country: "Francia" }, "6.6.6.6"));
  assert.equal(res.statusCode, 401);
});

test("eccezione generica (fetch che lancia): 500", async () => {
  const mod = freshModule();
  global.fetch = () => { throw new Error("boom"); };
  const res = await mod.handler(makeEvent({ hs_code: "691200", country: "Francia" }, "7.7.7.7"));
  assert.equal(res.statusCode, 500);
});

test("200 di successo: restituisce { estimate } col testo dell'AI", async () => {
  const mod = freshModule();
  mockAnthropicFetch("Circa 10-15%, indicativamente 8-12€. " + mod.DUTY_ESTIMATE_DISCLAIMER);
  const res = await mod.handler(makeEvent({ hs_code: "691200", category: "Ceramica", weight_kg: 1, value_eur: 80, country: "Canada" }, "8.8.8.8"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.match(body.estimate, /Circa 10-15%/);
  assert.match(body.estimate, /verifica sempre con le autorità doganali/);
});
