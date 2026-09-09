// Verifica la nuova azione "list-generated-shipments" aggiunta a sync.js
// per lo spazio "Spedizioni generate" dell'area partner (spedizioni
// generate DA un partner per conto di clienti finali — vedi
// PartnerGenerateShipmentScreen()/PartnerGeneratedShipmentsScreen() in
// dist/assets/app.js e item.generatedByPartnerCode salvato da
// save-purchase.js, invariato).
//
// Il punto critico verificato qui è l'ISOLAMENTO tra partner (mai vedere
// le spedizioni generate da un altro partner) — con almeno due partner
// distinti nello stesso store "purchases", oltre ad acquisti turista
// self-service ordinari (senza generatedByPartnerCode) mischiati nello
// stesso store, per dimostrare che quelli non compaiono mai in nessuna
// delle due liste.
//
// Stesso fake minimale di @netlify/blobs già usato in
// sync.comunicati.test.js e negli altri test di questo repository (nessuna
// rete/credenziale reale).
//
// Esecuzione: node --test  (dalla root del repository)

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

const handlerPath = path.join(__dirname, "..", "sync.js");
function freshHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath).handler;
}

function makeEvent(body, ip) {
  return {
    httpMethod: "POST",
    headers: { "x-nf-client-connection-ip": ip || "127.0.0.1" },
    body: JSON.stringify(body || {}),
  };
}

function seedPartners(map) {
  stores["partners"] = new Map(Object.entries(map).map(([code, record]) => [code, JSON.stringify(record)]));
}

function seedPurchases(list) {
  stores["purchases"] = new Map(list.map((it) => [it.id, JSON.stringify(it)]));
}

beforeEach(() => {
  resetStores();
});

test("list-generated-shipments: un partner vede SOLO le spedizioni generate dal proprio codice, mai quelle di un altro partner né gli acquisti turista self-service", async () => {
  seedPartners({ P1: { code: "P1" }, P2: { code: "P2" } });
  seedPurchases([
    { id: "gen-p1-a", touristName: "Cliente A", price: 39, pricingTier: "pieno", generatedByPartnerCode: "P1", date: "2026-09-06T00:00:00.000Z" },
    { id: "gen-p1-b", touristName: "Cliente B", price: 39, pricingTier: "pieno", generatedByPartnerCode: "P1", date: "2026-09-06T01:00:00.000Z" },
    { id: "gen-p2-a", touristName: "Cliente C", price: 39, pricingTier: "pieno", generatedByPartnerCode: "P2", date: "2026-09-06T02:00:00.000Z" },
    // Acquisto turista self-service ordinario — nessun generatedByPartnerCode.
    { id: "turista-1", touristName: "Turista Normale", price: 39, pricingTier: "pieno", date: "2026-09-06T03:00:00.000Z" },
  ]);

  const handler = freshHandler();

  const resP1 = await handler(makeEvent({ action: "list-generated-shipments", code: "P1" }, "1.1.1.1"));
  assert.equal(resP1.statusCode, 200);
  const idsP1 = JSON.parse(resP1.body).items.map((it) => it.id).sort();
  assert.deepEqual(idsP1, ["gen-p1-a", "gen-p1-b"], "P1 deve vedere solo le proprie spedizioni generate");
  assert.ok(!resP1.body.includes("gen-p2-a"), "la risposta a P1 non deve contenere in alcuna forma una spedizione di P2");
  assert.ok(!resP1.body.includes("Cliente C"), "nemmeno i dati cliente dell'altra spedizione devono comparire");
  assert.ok(!resP1.body.includes("turista-1"), "un acquisto turista self-service (senza generatedByPartnerCode) non deve mai comparire");

  const resP2 = await handler(makeEvent({ action: "list-generated-shipments", code: "P2" }, "2.2.2.2"));
  assert.equal(resP2.statusCode, 200);
  const idsP2 = JSON.parse(resP2.body).items.map((it) => it.id).sort();
  assert.deepEqual(idsP2, ["gen-p2-a"], "P2 deve vedere solo la propria spedizione generata");
  assert.ok(!resP2.body.includes("gen-p1-a") && !resP2.body.includes("gen-p1-b"), "la risposta a P2 non deve contenere alcuna spedizione di P1");
});

test("list-generated-shipments: nessuna spedizione generata -> lista vuota, non un errore", async () => {
  seedPartners({ P1: { code: "P1" } });
  seedPurchases([{ id: "turista-1", touristName: "Turista Normale", price: 39, pricingTier: "pieno", date: new Date().toISOString() }]);
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "list-generated-shipments", code: "P1" }, "3.3.3.3"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).items, []);
});

test("list-generated-shipments: codice partner mancante -> 400", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "list-generated-shipments" }, "4.4.4.4"));
  assert.equal(res.statusCode, 400);
});

test("list-generated-shipments: codice partner inesistente -> 404 \"Partner non trovato\", nessun dato restituito", async () => {
  seedPurchases([{ id: "gen-x", touristName: "X", price: 39, pricingTier: "pieno", generatedByPartnerCode: "NON-ESISTE", date: new Date().toISOString() }]);
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "list-generated-shipments", code: "NON-ESISTE" }, "5.5.5.5"));
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "Partner non trovato");
});

test("list-generated-shipments: rate limit (20 richieste/60min per IP), stesso schema delle altre azioni pubbliche", async () => {
  seedPartners({ P1: { code: "P1" } });
  seedPurchases([]);
  const handler = freshHandler();
  let lastStatus = 200;
  for (let i = 0; i < 21; i++) {
    const res = await handler(makeEvent({ action: "list-generated-shipments", code: "P1" }, "9.9.9.9"));
    lastStatus = res.statusCode;
  }
  assert.equal(lastStatus, 429, "la 21esima richiesta dallo stesso IP nella stessa finestra deve essere rifiutata");
});
