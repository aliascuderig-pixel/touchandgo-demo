// Verifica airline-baggage-fees.js: espone il dataset statico di
// ../lib/airline-baggage-fees invariato, calcola verifiedAt come la data
// più recente tra le voci, rispetta lo stesso rate limiting (store
// "rate-limits", stesso fake minimale di @netlify/blobs già usato altrove
// in questa cartella) e rifiuta un metodo diverso da GET. Esecuzione:
// node --test

const { test, beforeEach } = require("node:test");
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

const handlerPath = path.join(__dirname, "..", "airline-baggage-fees.js");
function freshHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath).handler;
}

const { AIRLINE_BAGGAGE_FEES } = require("../../lib/airline-baggage-fees");

function makeEvent(overrides) {
  return Object.assign({ httpMethod: "GET", headers: { "x-nf-client-connection-ip": "127.0.0.1" } }, overrides);
}

beforeEach(() => {
  resetStores();
});

test("metodo diverso da GET: rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent({ httpMethod: "POST" }));
  assert.equal(res.statusCode, 405);
});

test("GET: restituisce il dataset invariato di ../lib/airline-baggage-fees", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.fees, AIRLINE_BAGGAGE_FEES);
});

test("GET: verifiedAt è la data più recente tra tutte le voci del dataset", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent());
  const body = JSON.parse(res.body);
  const expectedLatest = AIRLINE_BAGGAGE_FEES.reduce((l, f) => (f.verifiedAt > l ? f.verifiedAt : l), AIRLINE_BAGGAGE_FEES[0].verifiedAt);
  assert.equal(body.verifiedAt, expectedLatest);
});

test("ogni voce del dataset ha i campi richiesti nella forma attesa (amountMin/amountMax, mai un 'amount' singolo)", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent());
  const body = JSON.parse(res.body);
  for (const f of body.fees) {
    assert.equal(typeof f.airline, "string");
    assert.ok(["per_kg_overweight", "per_extra_piece", "variable_by_fare"].includes(f.feeType));
    assert.ok("amountMin" in f && "amountMax" in f);
    assert.ok(!("amount" in f), "mai un campo 'amount' singolo — vedi commento nel file dati");
    assert.ok(["EUR", "USD"].includes(f.currency));
    assert.equal(typeof f.sourceUrl, "string");
    assert.match(f.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("Lufthansa Group: feeType variable_by_fare, nessun importo numerico, nota presente", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent());
  const body = JSON.parse(res.body);
  const lufthansa = body.fees.find((f) => f.airline === "Lufthansa Group");
  assert.ok(lufthansa, "Lufthansa Group deve essere presente nel dataset");
  assert.equal(lufthansa.feeType, "variable_by_fare");
  assert.equal(lufthansa.amountMin, null);
  assert.equal(lufthansa.amountMax, null);
  assert.ok(lufthansa.note && lufthansa.note.length > 0);
});

test("compagnie senza fonte ufficiale pulita (Wizz Air, Vueling, Volotea, Transavia) non compaiono nel dataset", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent());
  const body = JSON.parse(res.body);
  const names = body.fees.map((f) => f.airline);
  for (const excluded of ["Wizz Air", "Vueling", "Volotea", "Transavia"]) {
    assert.ok(!names.includes(excluded), `${excluded} non deve comparire nel dataset`);
  }
});

test("rate limiting: oltre RATE_LIMIT_MAX richieste nella finestra, 429 senza interrompere le precedenti", async () => {
  const handler = freshHandler();
  let lastStatus;
  for (let i = 0; i < 21; i++) {
    const res = await handler(makeEvent());
    lastStatus = res.statusCode;
  }
  assert.equal(lastStatus, 429);
});
