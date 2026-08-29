// Verifica i 5 scenari del failover automatico del router (vedi
// MANUALE.md, "Router di continuità") più la regressione sul bypass
// ACTIVE_TARGET esistente. Stessa tecnica di
// netlify/functions/__tests__/save-purchase.commission.test.js nel sito
// principale: store Blobs finto in memoria via intercettazione di
// require("@netlify/blobs"), nessuna rete/credenziale reale. In più qui
// serve anche un fetch finto (per simulare health.js del sito principale).
//
// Esecuzione: node --test  (dalla root del repository)

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

// ---- Fake minimale di @netlify/blobs, in memoria, azzerabile tra i test ----
let stores = {};
let forceStoreError = null; // se impostato, get/setJSON lanciano questo errore
function resetStores() {
  stores = {};
  forceStoreError = null;
}
const fakeBlobsModule = {
  getStore(opts) {
    const name = typeof opts === "string" ? opts : opts.name;
    if (!stores[name]) stores[name] = new Map();
    const store = stores[name];
    return {
      async get(key, { type } = {}) {
        if (forceStoreError) throw forceStoreError;
        const v = store.get(key);
        if (v === undefined) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      async setJSON(key, value) {
        if (forceStoreError) throw forceStoreError;
        store.set(key, JSON.stringify(value));
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@netlify/blobs") return fakeBlobsModule;
  return originalLoad.call(this, request, ...args);
};

const goPath = path.join(__dirname, "..", "go.js");
const stateLibPath = path.join(__dirname, "..", "..", "lib", "router-state.js");

function freshHandler() {
  delete require.cache[require.resolve(goPath)];
  delete require.cache[require.resolve(stateLibPath)];
  return require(goPath).handler;
}

function readRawState() {
  const store = stores["router-state"];
  const raw = store && store.get("state");
  return raw ? JSON.parse(raw) : null;
}

// ---- Fake fetch verso health.js del sito principale ----
const originalFetch = global.fetch;
let fetchImpl;
let fetchCallCount;

function healthyFetch() {
  fetchCallCount++;
  return Promise.resolve({ status: 200, json: async () => ({ ok: true }) });
}
function unhealthyFetch(reason) {
  return function () {
    fetchCallCount++;
    return Promise.resolve({ status: 503, json: async () => ({ ok: false, reason: reason || "anthropic_unreachable" }) });
  };
}
function throwingFetch() {
  fetchCallCount++;
  return Promise.reject(new Error("network down"));
}

beforeEach(() => {
  resetStores();
  fetchCallCount = 0;
  fetchImpl = healthyFetch;
  global.fetch = (...args) => fetchImpl(...args);
  delete process.env.ACTIVE_TARGET;
});

afterEach(() => {
  global.fetch = originalFetch;
});

test("ACTIVE_TARGET esplicita bypassa sempre la logica automatica (comportamento più forte, invariato)", async () => {
  process.env.ACTIVE_TARGET = "guest";
  fetchImpl = throwingFetch; // anche se health.js sarebbe irraggiungibile, non conta
  const handler = freshHandler();
  const res = await handler();
  assert.equal(res.headers.Location, "https://touchandgo-guest.netlify.app/");
  assert.equal(fetchCallCount, 0, "con ACTIVE_TARGET impostata non deve nemmeno provare a controllare la salute");
});

test("scenario 1 — sito principale sano: resta su main, nessun failover scritto", async () => {
  fetchImpl = healthyFetch;
  const handler = freshHandler();
  const res = await handler();

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, "https://benevolent-longma-57c78a.netlify.app/");
  assert.equal(fetchCallCount, 1, "un controllo di salute reale deve essere avvenuto (stato freddo)");

  const state = readRawState();
  assert.equal(state.failoverActive, false, "il flag di failover non deve mai attivarsi su un sito sano");
  // Nota: viene comunque scritto un piccolo timestamp/esito per il
  // debounce del punto 4 — senza quello il debounce non potrebbe
  // funzionare tra richieste diverse (funzioni serverless, nessuna
  // memoria condivisa). L'invariante che conta davvero è quella sopra:
  // nessun failover viene mai registrato quando il sito è sano.
  assert.equal(state.lastCheckOk, true);
});

test("scenario 2 — health.js fallisce: passa a guest e registra il failover", async () => {
  fetchImpl = unhealthyFetch("anthropic_auth_failed");
  const handler = freshHandler();
  const res = await handler();

  assert.equal(res.headers.Location, "https://touchandgo-guest.netlify.app/");

  const state = readRawState();
  assert.equal(state.failoverActive, true);
  assert.equal(state.reason, "anthropic_auth_failed");
  assert.ok(state.since, "deve registrare quando è scattato il failover");
});

test("scenario 2b — health.js irraggiungibile (fetch che lancia) è trattato come fallimento, non come errore del meccanismo", async () => {
  fetchImpl = throwingFetch;
  const handler = freshHandler();
  const res = await handler();

  assert.equal(res.headers.Location, "https://touchandgo-guest.netlify.app/");
  const state = readRawState();
  assert.equal(state.failoverActive, true);
  assert.equal(state.reason, "health_check_unreachable");
});

test("scenario 3 — secondo giro dopo il blocco: resta su guest SENZA richiamare health.js", async () => {
  // Primo giro: fa scattare il failover.
  fetchImpl = unhealthyFetch();
  let handler = freshHandler();
  await handler();
  assert.equal(fetchCallCount, 1);

  // Secondo giro, stato persistito da "prima": anche se ora il sito
  // sarebbe di nuovo sano, non deve ricontrollare finché non c'è un reset
  // manuale.
  fetchImpl = healthyFetch;
  handler = freshHandler();
  const res = await handler();

  assert.equal(res.headers.Location, "https://touchandgo-guest.netlify.app/");
  assert.equal(fetchCallCount, 1, "non deve richiamare health.js mentre il failover è già attivo");
});

test("scenario 3b — entro la finestra di debounce (sito sano), un secondo giro non richiama health.js", async () => {
  fetchImpl = healthyFetch;
  let handler = freshHandler();
  await handler();
  assert.equal(fetchCallCount, 1);

  handler = freshHandler();
  const res = await handler();
  assert.equal(res.headers.Location, "https://benevolent-longma-57c78a.netlify.app/");
  assert.equal(fetchCallCount, 1, "entro la finestra di debounce si fida dell'ultimo esito riuscito, senza richiamare health.js");
});

test("scenario 4 — reset manuale: alla richiesta successiva torna a controllare la salute", async () => {
  // Failover attivo da un giro precedente.
  fetchImpl = unhealthyFetch();
  let handler = freshHandler();
  await handler();
  assert.equal(readRawState().failoverActive, true);

  // Reset manuale (stesso store "router-state", stessa chiave "state").
  const { writeState } = require(stateLibPath);
  await writeState({ failoverActive: false, since: null, reason: null, lastCheckAt: null, lastCheckOk: null });

  // Giro successivo: deve ricontrollare davvero (non fidarsi di nulla di
  // vecchio) e, sito di nuovo sano, tornare su main.
  fetchImpl = healthyFetch;
  const countBefore = fetchCallCount;
  handler = freshHandler();
  const res = await handler();

  assert.equal(res.headers.Location, "https://benevolent-longma-57c78a.netlify.app/");
  assert.equal(fetchCallCount, countBefore + 1, "dopo il reset deve rifare un controllo di salute reale");
});

test("scenario 5 — store del router irraggiungibile: fallback sempre a main, mai a guest", async () => {
  forceStoreError = new Error("Netlify Blobs non raggiungibile");
  fetchImpl = healthyFetch; // irrilevante: non si arriva mai a chiamare health.js
  const handler = freshHandler();
  const res = await handler();

  assert.equal(res.headers.Location, "https://benevolent-longma-57c78a.netlify.app/", "qualunque errore imprevisto nel meccanismo deve risolvere verso main");
});

test("scenario 5b — store irraggiungibile SOLO in scrittura dopo un controllo fallito: fallback comunque a main, non a guest", async () => {
  fetchImpl = unhealthyFetch();

  // Lettura iniziale ok (stato vuoto), ma la SCRITTURA (registrare il
  // failover) fallisce — va patchato PRIMA di richiedere go.js: router-state.js
  // fa `const { getStore } = require("@netlify/blobs")` al momento del
  // require, quindi cattura il riferimento alla funzione allora — patchare
  // fakeBlobsModule.getStore dopo non avrebbe alcun effetto sul modulo già
  // caricato.
  const storeGetter = fakeBlobsModule.getStore;
  fakeBlobsModule.getStore = function (opts) {
    const s = storeGetter(opts);
    const name = typeof opts === "string" ? opts : opts.name;
    if (name === "router-state") {
      return {
        get: s.get,
        async setJSON() {
          throw new Error("scrittura non riuscita");
        },
      };
    }
    return s;
  };

  const handler = freshHandler();
  const res = await handler();
  fakeBlobsModule.getStore = storeGetter;

  assert.equal(res.headers.Location, "https://benevolent-longma-57c78a.netlify.app/", "un fallimento nel PERSISTERE il failover non deve mai mandare a guest");
});
