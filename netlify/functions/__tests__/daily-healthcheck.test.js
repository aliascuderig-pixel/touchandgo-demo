// Verifica netlify/functions/daily-healthcheck.js: caso "tutto ok" (i
// quattro dispositivi rispondono correttamente -> overallStatus "ok",
// report salvato) e caso "un dispositivo irraggiungibile" (il report resta
// "problem" solo per quel dispositivo, gli altri tre restano "ok", e il
// report viene comunque salvato per intero — nessun abort al primo
// errore). Fetch e store Netlify Blobs finti, nessuna rete reale.
//
// Sezione CRM (Netlify Management API): due tentativi precedenti provavano
// ad autenticarsi come un browser contro la Visitor Access del sito
// (Basic Auth, poi un login simulato con cookie) — scartati perché
// dipendevano da un meccanismo non documentato/non pubblico di Netlify.
// L'approccio attuale interroga la Management API ufficiale
// (https://docs.netlify.com/api/get-started/) per leggere lo stato
// dell'ultimo deploy del progetto — endpoint stabile e documentato, quindi
// questi test (fetch finto, nessuna rete reale) provano davvero il
// comportamento contro il contratto reale dell'API, non solo contro
// un'assunzione sul formato di un login mai osservato.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");

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

// Guardia di regressione: i codici errore della Visitor Access (Basic Auth
// prima, login simulato poi) appartengono a due approcci scartati — non
// devono ricomparire nel sorgente, nemmeno in un ramo morto/un blocco catch
// dimenticato. Un errore in codice testuale, non nel comportamento a
// runtime: legge il file sorgente direttamente, quindi cattura anche una
// stringa residua che nessun test comportamentale rileverebbe se non fosse
// mai raggiunta da nessun percorso testato.
test("nessuna stringa residua dei vecchi codici errore Visitor Access nel sorgente di daily-healthcheck.js", () => {
  const source = fs.readFileSync(handlerPath, "utf8");
  const OLD_ERROR_CODES = [
    "crm_visitor_auth_fallita",
    "crm_visitor_auth_non_configurata",
    "crm_visitor_login_fallito",
    "crm_visitor_password_non_configurata",
  ];
  for (const code of OLD_ERROR_CODES) {
    assert.ok(!source.includes(code), `il vecchio codice errore "${code}" non deve comparire più nel sorgente — approccio scartato (Basic Auth/login simulato)`);
  }
});

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  resetStores();
  process.env.NETLIFY_BLOBS_SITE_ID = "test-site";
  process.env.NETLIFY_BLOBS_TOKEN = "test-token";
  delete process.env.GUEST_MODE;
  delete process.env.NETLIFY_HEALTHCHECK_TOKEN;
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

// Mappa URL -> risposta finta, usata dai test principali sotto.
function fetchRouter(responses) {
  return async (url) => {
    for (const [match, respond] of responses) {
      if (url.includes(match)) return respond();
    }
    throw new Error(`URL non atteso nel test: ${url}`);
  };
}

// Un deploy "ready" dell'ultimo minuto — la risposta di successo tipica di
// GET /api/v1/sites/{id}/deploys?per_page=1.
function readyDeploy(overrides) {
  return [{ state: "ready", created_at: new Date().toISOString(), commit_ref: "abc123", context: "production", ...overrides }];
}

function crmOkEntry() {
  return [
    "api.netlify.com/api/v1/sites/81ef474e-77e4-4852-bfae-0e159f6a2931/deploys",
    () => ({ status: 200, json: async () => readyDeploy() }),
  ];
}

const ALL_OK_RESPONSES_BASE = [
  ["benevolent-longma-57c78a.netlify.app/.netlify/functions/health", () => ({ status: 200, json: async () => ({ ok: true }) })],
  ["touchandgo-guest.netlify.app/.netlify/functions/health", () => ({ status: 200, json: async () => ({ ok: true }) })],
  [
    "touchandgo-router.netlify.app/.netlify/functions/status",
    () => ({
      status: 200,
      json: async () => ({ ok: true, mode: "auto", redirectsTo: "https://benevolent-longma-57c78a.netlify.app/" }),
    }),
  ],
];

test("caso tutto ok: quattro dispositivi ok (CRM con deploy 'ready' via Management API), overallStatus ok, report salvato", async () => {
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-di-prova";
  global.fetch = fetchRouter([...ALL_OK_RESPONSES_BASE, crmOkEntry()]);
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
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-di-prova";
  global.fetch = fetchRouter([
    ALL_OK_RESPONSES_BASE[0],
    ALL_OK_RESPONSES_BASE[1],
    [
      "touchandgo-router.netlify.app/.netlify/functions/status",
      () => {
        throw new Error("ECONNREFUSED");
      },
    ],
    crmOkEntry(),
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

test("CRM: NETLIFY_HEALTHCHECK_TOKEN non configurato -> errore esplicito, nessuna chiamata di rete tentata per il CRM", async () => {
  // Nessuna entry CRM nel router: se checkCrm() tentasse comunque una
  // fetch (bug), il router lancerebbe "URL non atteso" — quell'eccezione
  // verrebbe intercettata da checkCrm() e trasformata in un errore di tipo
  // "unreachable", diverso da quello atteso qui sotto, quindi l'assert
  // fallirebbe comunque se il codice tentasse una chiamata.
  global.fetch = fetchRouter([...ALL_OK_RESPONSES_BASE]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_healthcheck_token_non_configurato");
  assert.equal(report.overallStatus, "problem");
});

test("CRM: token non valido/senza permessi (401) -> errore esplicito, distinto da un vero errore di deploy", async () => {
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-scaduto";
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    ["api.netlify.com/api/v1/sites/81ef474e-77e4-4852-bfae-0e159f6a2931/deploys", () => ({ status: 401, json: async () => ({ message: "Invalid token" }) })],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_healthcheck_token_invalido");
});

test("CRM: 404 (Netlify nasconde i siti a cui il token non ha accesso) -> stesso errore di token invalido", async () => {
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-senza-permessi";
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    ["api.netlify.com/api/v1/sites/81ef474e-77e4-4852-bfae-0e159f6a2931/deploys", () => ({ status: 404, json: async () => ({ message: "Not found" }) })],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_healthcheck_token_invalido");
});

test("CRM: ultimo deploy in stato 'error' -> crm_deploy_in_errore, mai un falso ok", async () => {
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-di-prova";
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    [
      "api.netlify.com/api/v1/sites/81ef474e-77e4-4852-bfae-0e159f6a2931/deploys",
      () => ({ status: 200, json: async () => readyDeploy({ state: "error" }) }),
    ],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_deploy_in_errore");
});

test("CRM: deploy ancora 'building' ma recente -> ok (non è un falso 'problem' su ogni deploy in corso)", async () => {
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-di-prova";
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    [
      "api.netlify.com/api/v1/sites/81ef474e-77e4-4852-bfae-0e159f6a2931/deploys",
      () => ({ status: 200, json: async () => readyDeploy({ state: "building", created_at: new Date(Date.now() - 60 * 1000).toISOString() }) }),
    ],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "ok");
});

test("CRM: deploy bloccato in 'building' da oltre la soglia -> crm_deploy_non_pronto", async () => {
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-di-prova";
  const mod0 = freshModule();
  const stuckSince = new Date(Date.now() - (mod0.DEPLOY_STUCK_THRESHOLD_MS + 60 * 1000)).toISOString();
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    [
      "api.netlify.com/api/v1/sites/81ef474e-77e4-4852-bfae-0e159f6a2931/deploys",
      () => ({ status: 200, json: async () => readyDeploy({ state: "building", created_at: stuckSince }) }),
    ],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_deploy_non_pronto");
});

test("CRM: risposta 200 ma corpo non è un array (contratto API violato) -> errore esplicito, non un crash", async () => {
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-di-prova";
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    ["api.netlify.com/api/v1/sites/81ef474e-77e4-4852-bfae-0e159f6a2931/deploys", () => ({ status: 200, json: async () => ({ unexpected: true }) })],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_api_risposta_inattesa");
});

test("CRM: risposta 200 ma array vuoto (nessun deploy mai avvenuto) -> errore esplicito", async () => {
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-di-prova";
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    ["api.netlify.com/api/v1/sites/81ef474e-77e4-4852-bfae-0e159f6a2931/deploys", () => ({ status: 200, json: async () => [] })],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_api_risposta_inattesa");
});

test("CRM: errore di rete verso api.netlify.com -> unreachable, MAI confuso con un errore applicativo", async () => {
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-di-prova";
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    [
      "api.netlify.com/api/v1/sites/81ef474e-77e4-4852-bfae-0e159f6a2931/deploys",
      () => {
        throw new Error("ECONNREFUSED");
      },
    ],
  ]);
  const mod = freshModule();
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "ECONNREFUSED");
  assert.notEqual(report.devices.crm.error, "crm_deploy_in_errore");
  assert.notEqual(report.devices.crm.error, "crm_healthcheck_token_invalido");
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
  process.env.NETLIFY_HEALTHCHECK_TOKEN = "token-di-prova";
  global.fetch = fetchRouter([...ALL_OK_RESPONSES_BASE, crmOkEntry()]);
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
