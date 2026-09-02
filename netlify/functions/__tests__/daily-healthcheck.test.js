// Verifica netlify/functions/daily-healthcheck.js: caso "tutto ok" (i
// quattro dispositivi rispondono correttamente -> overallStatus "ok",
// report salvato) e caso "un dispositivo irraggiungibile" (il report resta
// "problem" solo per quel dispositivo, gli altri tre restano "ok", e il
// report viene comunque salvato per intero — nessun abort al primo
// errore). Fetch e store Netlify Blobs finti, nessuna rete reale.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

// ---- Fake minimale di @netlify/blobs, in memoria, azzerabile tra i test ----
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
      async delete(key) {
        store.delete(key);
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

const handlerPath = path.join(__dirname, "..", "daily-healthcheck.js");
function freshModule() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath);
}

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  resetStores();
  process.env.NETLIFY_BLOBS_SITE_ID = "test-site";
  process.env.NETLIFY_BLOBS_TOKEN = "test-token";
  delete process.env.GUEST_MODE;
  delete process.env.CRM_VISITOR_USER;
  delete process.env.CRM_VISITOR_PASSWORD;
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

// Mappa URL -> risposta finta, usata dai due test principali sotto.
function fetchRouter(responses) {
  return async (url) => {
    for (const [match, respond] of responses) {
      if (url.includes(match)) return respond();
    }
    throw new Error(`URL non atteso nel test: ${url}`);
  };
}

const ALL_OK_RESPONSES = [
  ["benevolent-longma-57c78a.netlify.app/.netlify/functions/health", () => ({ status: 200, json: async () => ({ ok: true }) })],
  ["touchandgo-guest.netlify.app/.netlify/functions/health", () => ({ status: 200, json: async () => ({ ok: true }) })],
  [
    "touchandgo-router.netlify.app/.netlify/functions/status",
    () => ({
      status: 200,
      json: async () => ({ ok: true, mode: "auto", redirectsTo: "https://benevolent-longma-57c78a.netlify.app/" }),
    }),
  ],
  ["cute-moxie-cd1e4b.netlify.app/.netlify/functions/crm", () => ({ status: 400, json: async () => ({ error: "Unknown action" }) })],
];

test("caso tutto ok: quattro dispositivi ok, overallStatus ok, report salvato", async () => {
  global.fetch = fetchRouter(ALL_OK_RESPONSES);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.overallStatus, "ok");
  assert.equal(report.devices.main.status, "ok");
  assert.equal(report.devices.guest.status, "ok");
  assert.equal(report.devices.router.status, "ok");
  assert.equal(report.devices.crm.status, "ok");
  assert.ok(report.date.match(/^\d{4}-\d{2}-\d{2}$/));

  const saved = await stores["system-reports"].get(report.date);
  assert.ok(saved, "il report deve essere stato scritto nello store");
  assert.equal(JSON.parse(saved).overallStatus, "ok");
});

test("caso router irraggiungibile: report parziale salvato, solo router in problem", async () => {
  global.fetch = fetchRouter([
    ALL_OK_RESPONSES[0],
    ALL_OK_RESPONSES[1],
    [
      "touchandgo-router.netlify.app/.netlify/functions/status",
      () => {
        throw new Error("ECONNREFUSED");
      },
    ],
    ALL_OK_RESPONSES[3],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.overallStatus, "problem");
  assert.equal(report.devices.main.status, "ok");
  assert.equal(report.devices.guest.status, "ok");
  assert.equal(report.devices.crm.status, "ok");
  assert.equal(report.devices.router.status, "problem");
  assert.equal(report.devices.router.error, "ECONNREFUSED");

  // Il report viene comunque salvato per intero, non solo gli esiti ok.
  const saved = await stores["system-reports"].get(report.date);
  assert.ok(saved);
  const parsed = JSON.parse(saved);
  assert.equal(parsed.overallStatus, "problem");
  assert.equal(parsed.devices.main.status, "ok");
});

test("CRM senza credenziali Visitor Access configurate e bloccato: motivo esplicito, non falso ok", async () => {
  global.fetch = fetchRouter([
    ALL_OK_RESPONSES[0],
    ALL_OK_RESPONSES[1],
    ALL_OK_RESPONSES[2],
    ["cute-moxie-cd1e4b.netlify.app/.netlify/functions/crm", () => ({ status: 401, json: async () => ({}) })],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_visitor_auth_non_configurata");
  assert.equal(report.overallStatus, "problem");
});

test("spazio ospite (GUEST_MODE=true): la function si ferma subito, nessun controllo eseguito", async () => {
  process.env.GUEST_MODE = "true";
  global.fetch = async () => {
    throw new Error("fetch non doveva essere chiamato in guest mode");
  };
  const mod = freshModule();
  const result = await mod.runDailyHealthcheck();
  assert.deepEqual(result, { skipped: true, reason: "guest_mode" });
});

test("pulizia storico: mantiene solo gli ultimi 30 giorni dopo la scrittura", async () => {
  global.fetch = fetchRouter(ALL_OK_RESPONSES);
  const mod = freshModule();

  // Pre-popola 32 giorni finti più vecchi di oggi.
  const store = stores["system-reports"] || (stores["system-reports"] = new Map());
  for (let i = 32; i >= 1; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    store.set(d, JSON.stringify({ date: d }));
  }
  assert.equal(store.size, 32);

  await mod.runDailyHealthcheck();

  // 32 vecchi + 1 di oggi = 33, deve restare solo KEEP_DAYS = 30.
  assert.equal(store.size, 30);
});
