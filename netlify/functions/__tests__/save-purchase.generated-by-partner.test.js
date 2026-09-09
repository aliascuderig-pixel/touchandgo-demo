// Verifica che save-purchase.js — INVARIATO nella sua logica, come da
// vincolo esplicito — persista senza alcuna modifica il nuovo campo
// generatedByPartnerCode (spedizioni generate da un partner per conto di
// un cliente finale, vedi PartnerGenerateShipmentScreen() in
// dist/assets/app.js) e che un acquisto turista self-service ordinario
// non lo abbia mai. Verifica anche che questo campo NON attivi in alcun
// modo il meccanismo di commissione/credito partner esistente (riservato
// al campo distinto item.partnerCode, mai scritto da questa feature).
//
// Stesso fake minimale di @netlify/blobs già usato negli altri test di
// save-purchase.js in questo repository (nessuna rete/credenziale reale).
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

const handlerPath = path.join(__dirname, "..", "save-purchase.js");
function freshHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath).handler;
}

function makeEvent(body) {
  return {
    httpMethod: "POST",
    headers: { "x-nf-client-connection-ip": "127.0.0.1" },
    body: JSON.stringify(body),
  };
}

function basePurchase(overrides) {
  return Object.assign(
    {
      id: "test-" + Math.random().toString(36).slice(2),
      objectName: "Vaso",
      hsCode: "1234.56",
      weightKg: 1.2,
      dims: { l: 10, w: 10, h: 10 },
      itemValue: 50,
      pricingTier: "pieno",
      addressLabel: "Casa",
      price: 25,
      touristName: "Mario",
      touristEmail: "mario+" + Math.random().toString(36).slice(2) + "@test.it",
      status: "in sospeso",
    },
    overrides
  );
}

beforeEach(() => {
  resetStores();
});

test("una spedizione generata da un partner ha generatedByPartnerCode valorizzato con quel codice, salvato senza modifiche", async () => {
  const handler = freshHandler();
  const item = basePurchase({ generatedByPartnerCode: "BOUTIQUE1", pricingTier: "pieno" });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.generatedByPartnerCode, "BOUTIQUE1", "il campo deve essere salvato esattamente com'è arrivato");
});

test("un acquisto turista self-service normale non ha mai generatedByPartnerCode", async () => {
  const handler = freshHandler();
  const item = basePurchase(); // nessun generatedByPartnerCode nel payload
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.generatedByPartnerCode, undefined, "un acquisto turista ordinario non deve avere questo campo, nemmeno null impostato esplicitamente da save-purchase.js");
});

test("il pricingTier di una spedizione generata da partner è esattamente quello inviato (pieno/abbonato/breakeven restano gli unici tre valori validi, invariato)", async () => {
  const handler = freshHandler();
  for (const tier of ["pieno", "abbonato", "breakeven"]) {
    const item = basePurchase({ generatedByPartnerCode: "P1", pricingTier: tier });
    const res = await handler(makeEvent(item));
    assert.equal(res.statusCode, 200, `tier ${tier} deve essere accettato, invariato`);
    const purchases = fakeBlobsModule.getStore("purchases");
    const saved = await purchases.get(item.id, { type: "json" });
    assert.equal(saved.pricingTier, tier);
  }
});

test("generatedByPartnerCode su un item NON attiva il meccanismo di commissione/credito partner (riservato a item.partnerCode, mai scritto da questa feature)", async () => {
  const handler = freshHandler();
  const partners = fakeBlobsModule.getStore("partners");
  await partners.setJSON("BOUTIQUE1", { code: "BOUTIQUE1", plan: "boutique", creditBalance: 0 });

  // Anche con status "ritirato" (il trigger della commissione, vedi
  // save-purchase.js) — ma SENZA item.partnerCode, solo generatedByPartnerCode.
  const item = basePurchase({ generatedByPartnerCode: "BOUTIQUE1", status: "ritirato" });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const savedPartner = await partners.get("BOUTIQUE1", { type: "json" });
  assert.equal(savedPartner.creditBalance, 0, "nessuna commissione deve maturare: generatedByPartnerCode non è item.partnerCode");

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.creditIssued, undefined, "il flag di accredito non deve mai essere impostato per questo campo");
});
