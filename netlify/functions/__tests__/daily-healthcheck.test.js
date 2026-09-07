// Verifica netlify/functions/daily-healthcheck.js: caso "tutto ok" (i
// quattro dispositivi rispondono correttamente -> overallStatus "ok",
// report salvato) e caso "un dispositivo irraggiungibile" (il report resta
// "problem" solo per quel dispositivo, gli altri tre restano "ok", e il
// report viene comunque salvato per intero — nessun abort al primo
// errore). Fetch e store Netlify Blobs finti, nessuna rete reale.
//
// Sezione CRM (login Visitor Access): copre il flusso reale a due passi
// (login con password -> cookie di sessione -> richiesta autenticata),
// introdotto al posto del precedente (sbagliato) tentativo di Basic Auth.
// IMPORTANTE — questi test provano che la LOGICA di parsing/gestione degli
// errori è corretta contro un insieme di risposte HTTP plausibili (con e
// senza campi nascosti nel form, con e senza più header Set-Cookie, con
// cookie assente per simulare una password sbagliata, ecc.) — NON possono
// provare che il formato assunto (URL della pagina di login, nome del
// campo "password", POST sulla stessa pagina) corrisponda esattamente al
// comportamento reale di Netlify per questo sito: quell'ambiente non è
// raggiungibile da questa sandbox (vedi commento in cima a checkCrm() nel
// file sorgente) e va verificato manualmente prima di fidarsene in
// produzione.

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
  delete process.env.CRM_VISITOR_PASSWORD;
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

// Mappa (url, method) -> risposta finta. Ogni entry è [urlSubstring, respond]
// (qualunque metodo, comportamento di prima) oppure [urlSubstring, method,
// respond] (solo per quel metodo — necessario per il CRM, dove GET e POST
// colpiscono la STESSA URL con esiti diversi: la pagina di login vs. l'invio
// della password).
function fetchRouter(responses) {
  return async (url, options) => {
    const method = (options && options.method) || "GET";
    for (const entry of responses) {
      if (entry.length === 2) {
        const [match, respond] = entry;
        if (url.includes(match)) return respond();
      } else {
        const [match, forMethod, respond] = entry;
        if (url.includes(match) && method === forMethod) return respond();
      }
    }
    throw new Error(`URL/metodo non atteso nel test: ${method} ${url}`);
  };
}

// ---- Helper per simulare Headers con supporto a getSetCookie() (Node 18.14+/20+) ----
function fakeHeaders(map) {
  const lower = {};
  for (const k of Object.keys(map)) lower[k.toLowerCase()] = map[k];
  return {
    get(name) {
      const v = lower[name.toLowerCase()];
      if (v === undefined) return null;
      return Array.isArray(v) ? v[0] : v;
    },
    getSetCookie() {
      const v = lower["set-cookie"];
      if (!v) return [];
      return Array.isArray(v) ? v : [v];
    },
  };
}

const FAKE_SESSION_JWT = "eyJFAKE.SESSIONE.DIPROVA";
const LOGIN_GATE_HTML_NO_HIDDEN = `<html><body><form method="POST"><input type="password" name="password"/><button>Entra</button></form></body></html>`;

// Le tre chiamate del flusso CRM riuscito: GET della pagina (gate di login),
// POST della password sulla stessa pagina (nessun action esplicito nel
// form -> stessa URL), POST autenticata alla function reale.
function crmLoginOkEntries(mod) {
  return [
    [mod.CRM_LOGIN_URL, "GET", () => ({ status: 200, headers: fakeHeaders({}), text: async () => LOGIN_GATE_HTML_NO_HIDDEN })],
    [
      mod.CRM_LOGIN_URL,
      "POST",
      () => ({ status: 200, headers: fakeHeaders({ "set-cookie": `${mod.CRM_SITE_ID}=${FAKE_SESSION_JWT}; Path=/; HttpOnly; Secure` }) }),
    ],
    [".netlify/functions/crm", "POST", () => ({ status: 400, headers: fakeHeaders({}), json: async () => ({ error: "Unknown action" }) })],
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

test("caso tutto ok: quattro dispositivi ok (CRM con login Visitor Access riuscito), overallStatus ok, report salvato", async () => {
  process.env.CRM_VISITOR_PASSWORD = "password-di-prova";
  const mod = freshModule();
  global.fetch = fetchRouter([...ALL_OK_RESPONSES_BASE, ...crmLoginOkEntries(mod)]);
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
  process.env.CRM_VISITOR_PASSWORD = "password-di-prova";
  const mod = freshModule();
  global.fetch = fetchRouter([
    ALL_OK_RESPONSES_BASE[0],
    ALL_OK_RESPONSES_BASE[1],
    [
      "touchandgo-router.netlify.app/.netlify/functions/status",
      () => {
        throw new Error("ECONNREFUSED");
      },
    ],
    ...crmLoginOkEntries(mod),
  ]);
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

test("CRM: CRM_VISITOR_PASSWORD non configurata -> errore esplicito, nessuna chiamata di rete tentata per il CRM", async () => {
  const mod = freshModule();
  // Nessuna entry CRM nel router: se checkCrm() tentasse comunque una
  // fetch (bug), il router lancerebbe "URL non atteso" — quell'eccezione
  // verrebbe intercettata da checkCrm() e trasformata in un errore di
  // tipo "unreachable", diverso da quello atteso qui sotto, quindi
  // l'assert fallirebbe comunque se il codice tentasse una chiamata.
  global.fetch = fetchRouter([...ALL_OK_RESPONSES_BASE]);
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_visitor_password_non_configurata");
  assert.equal(report.overallStatus, "problem");
});

test("CRM: password sbagliata (login non restituisce il cookie di sessione atteso) -> errore esplicito, MAI un falso ok", async () => {
  process.env.CRM_VISITOR_PASSWORD = "password-sbagliata";
  const mod = freshModule();
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    [mod.CRM_LOGIN_URL, "GET", () => ({ status: 200, headers: fakeHeaders({}), text: async () => LOGIN_GATE_HTML_NO_HIDDEN })],
    // Password sbagliata: Netlify ripresenta il gate (200, HTML), nessun Set-Cookie.
    [mod.CRM_LOGIN_URL, "POST", () => ({ status: 200, headers: fakeHeaders({}) })],
  ]);
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_visitor_login_fallito");
  assert.notEqual(report.devices.crm.error, "timeout");
  assert.notEqual(report.devices.crm.error, "unreachable");
});

test("CRM: errore di rete durante il login (sito irraggiungibile) -> unreachable, MAI 'crm_visitor_login_fallito'", async () => {
  process.env.CRM_VISITOR_PASSWORD = "password-di-prova";
  const mod = freshModule();
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    [
      mod.CRM_LOGIN_URL,
      "GET",
      () => {
        throw new Error("ECONNREFUSED");
      },
    ],
  ]);
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "ECONNREFUSED");
  assert.notEqual(report.devices.crm.error, "crm_visitor_login_fallito", "un vero errore di rete non deve mai essere confuso con un login fallito");
});

test("CRM: login riuscito ma la risposta autenticata è comunque 401/403 (cookie scaduto/rifiutato) -> errore esplicito", async () => {
  process.env.CRM_VISITOR_PASSWORD = "password-di-prova";
  const mod = freshModule();
  global.fetch = fetchRouter([
    ...ALL_OK_RESPONSES_BASE,
    [mod.CRM_LOGIN_URL, "GET", () => ({ status: 200, headers: fakeHeaders({}), text: async () => LOGIN_GATE_HTML_NO_HIDDEN })],
    [
      mod.CRM_LOGIN_URL,
      "POST",
      () => ({ status: 200, headers: fakeHeaders({ "set-cookie": `${mod.CRM_SITE_ID}=${FAKE_SESSION_JWT}; Path=/` }) }),
    ],
    [".netlify/functions/crm", "POST", () => ({ status: 403, headers: fakeHeaders({}) })],
  ]);
  const report = await mod.runDailyHealthcheck();

  assert.equal(report.devices.crm.status, "problem");
  assert.equal(report.devices.crm.error, "crm_visitor_login_fallito");
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
  process.env.CRM_VISITOR_PASSWORD = "password-di-prova";
  const mod = freshModule();
  global.fetch = fetchRouter([...ALL_OK_RESPONSES_BASE, ...crmLoginOkEntries(mod)]);

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

// ---------------------------------------------------------------------
// Unit test sulle singole funzioni di parsing del login — provano che la
// LOGICA regge un insieme di formati HTML/header plausibili, non che
// corrispondano esattamente al formato reale di Netlify (mai osservato
// direttamente, vedi nota in cima al file).
// ---------------------------------------------------------------------

test("extractHiddenFields: nessun campo nascosto -> array vuoto, nessun errore", () => {
  const mod = freshModule();
  assert.deepEqual(mod.extractHiddenFields(LOGIN_GATE_HTML_NO_HIDDEN), []);
  assert.deepEqual(mod.extractHiddenFields(""), []);
  assert.deepEqual(mod.extractHiddenFields(undefined), []);
});

test("extractHiddenFields: individua ogni <input type=hidden>, ignora gli altri input", () => {
  const mod = freshModule();
  const html = `<form>
    <input type="hidden" name="csrf_token" value="abc123">
    <input type="hidden" name="empty_field" value="">
    <input type="password" name="password">
    <input type="hidden" name='single_quoted' value='xyz'>
  </form>`;
  const fields = mod.extractHiddenFields(html);
  assert.deepEqual(fields, [
    { name: "csrf_token", value: "abc123" },
    { name: "empty_field", value: "" },
    { name: "single_quoted", value: "xyz" },
  ]);
});

test("extractFormAction: nessun action esplicito -> ricade sulla pagina corrente", () => {
  const mod = freshModule();
  const pageUrl = "https://cute-moxie-cd1e4b.netlify.app/site/admin.html";
  assert.equal(mod.extractFormAction(`<form method="POST"><input name="password"></form>`, pageUrl), pageUrl);
  assert.equal(mod.extractFormAction("", pageUrl), pageUrl);
});

test("extractFormAction: action relativo viene risolto rispetto alla pagina", () => {
  const mod = freshModule();
  const pageUrl = "https://cute-moxie-cd1e4b.netlify.app/site/admin.html";
  assert.equal(mod.extractFormAction(`<form action="/.netlify/login" method="POST">`, pageUrl), "https://cute-moxie-cd1e4b.netlify.app/.netlify/login");
});

test("extractFormAction: action assoluto viene usato così com'è", () => {
  const mod = freshModule();
  const pageUrl = "https://cute-moxie-cd1e4b.netlify.app/site/admin.html";
  assert.equal(mod.extractFormAction(`<form action="https://altro-dominio.example/login">`, pageUrl), "https://altro-dominio.example/login");
});

test("extractSessionCookie: trova il cookie tra più Set-Cookie (getSetCookie)", () => {
  const mod = freshModule();
  const res = {
    headers: fakeHeaders({
      "set-cookie": [`altro_cookie=xyz; Path=/`, `${mod.CRM_SITE_ID}=${FAKE_SESSION_JWT}; Path=/; HttpOnly`, `terzo=1`],
    }),
  };
  assert.equal(mod.extractSessionCookie(res), FAKE_SESSION_JWT);
});

test("extractSessionCookie: nessun Set-Cookie -> null", () => {
  const mod = freshModule();
  const res = { headers: fakeHeaders({}) };
  assert.equal(mod.extractSessionCookie(res), null);
});

test("extractSessionCookie: Set-Cookie presente ma nome diverso da CRM_SITE_ID -> null (non un falso positivo)", () => {
  const mod = freshModule();
  const res = { headers: fakeHeaders({ "set-cookie": "nome_diverso=qualcosa; Path=/" }) };
  assert.equal(mod.extractSessionCookie(res), null);
});

test("extractSessionCookie: fallback su un singolo header combinato quando getSetCookie() non è disponibile", () => {
  const mod = freshModule();
  const res = {
    headers: {
      get(name) {
        if (name.toLowerCase() === "set-cookie") return `${mod.CRM_SITE_ID}=${FAKE_SESSION_JWT}; Path=/`;
        return null;
      },
      // niente getSetCookie — simula un ambiente fetch più vecchio.
    },
  };
  assert.equal(mod.extractSessionCookie(res), FAKE_SESSION_JWT);
});

test("loginToVisitorProtectedSite: integrazione dei tre passaggi con un campo CSRF nascosto nel form", async () => {
  const mod = freshModule();
  const htmlWithCsrf = `<html><body><form method="POST"><input type="hidden" name="csrf_token" value="tok-123"><input type="password" name="password"></form></body></html>`;
  let capturedLoginBody = null;
  global.fetch = fetchRouter([
    [mod.CRM_LOGIN_URL, "GET", () => ({ status: 200, headers: fakeHeaders({}), text: async () => htmlWithCsrf })],
    [
      mod.CRM_LOGIN_URL,
      "POST",
      () => ({ status: 200, headers: fakeHeaders({ "set-cookie": `${mod.CRM_SITE_ID}=${FAKE_SESSION_JWT}; Path=/` }) }),
    ],
  ]);
  // Intercetta anche il body inviato, per verificare che il token CSRF
  // nascosto venga davvero incluso nella POST insieme alla password.
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (options && options.method === "POST" && url === mod.CRM_LOGIN_URL) capturedLoginBody = options.body;
    return realFetch(url, options);
  };

  const cookie = await mod.loginToVisitorProtectedSite("la-password");
  assert.equal(cookie, FAKE_SESSION_JWT);
  assert.ok(capturedLoginBody.includes("password=la-password"));
  assert.ok(capturedLoginBody.includes("csrf_token=tok-123"), "il campo nascosto CSRF deve essere rimandato indietro nella POST di login");
});
