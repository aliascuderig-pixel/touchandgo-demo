// Verifica sanitizeStructuredDestination() in save-purchase.js: i nuovi
// campi item.country/item.city (paese/città reali, vedi app.js
// ISO_COUNTRIES) sono accettati quando validi e sempre e comunque MAI
// bloccanti — un valore malformato azzera solo il campo, non fa mai
// rifiutare l'intero acquisto (stesso principio di recordCustomsReference,
// vedi save-purchase.js). Vedi MANUALE.md, sezione "Paese e città reali
// della spedizione".
//
// Stessa tecnica di save-purchase.price-limit.test.js: store Netlify Blobs
// finto in memoria, nessuna rete/credenziale reale necessaria.

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
      pickupPoint: "Roma",
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

test("country/city validi (stringhe non vuote, entro il limite): salvati esattamente come inviati", async () => {
  const handler = freshHandler();
  const item = basePurchase({ country: "Francia", city: "Parigi" });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.country, "Francia");
  assert.equal(saved.city, "Parigi");
});

test("country/city con spazi ai lati: vengono normalizzati (trim), non rifiutati", async () => {
  const handler = freshHandler();
  const item = basePurchase({ country: "  Francia  ", city: "  Parigi  " });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.country, "Francia");
  assert.equal(saved.city, "Parigi");
});

test("country/city assenti (acquisto storico, addressLabel-only): restano null, l'acquisto non viene rifiutato", async () => {
  const handler = freshHandler();
  const item = basePurchase();
  delete item.country;
  delete item.city;
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200, "un acquisto senza i nuovi campi strutturati deve restare valido");

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.country, null);
  assert.equal(saved.city, null);
});

test("country/city di tipo non-stringa (payload malformato o manomesso): azzerati, MAI un motivo di rifiuto dell'acquisto", async () => {
  const handler = freshHandler();
  const item = basePurchase({ country: { evil: true }, city: 12345 });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200, "un campo malformato non deve mai far rifiutare l'intero acquisto");

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.country, null);
  assert.equal(saved.city, null);
});

test("country/city stringa vuota o solo spazi: azzerati come se assenti", async () => {
  const handler = freshHandler();
  const item = basePurchase({ country: "", city: "   " });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.country, null);
  assert.equal(saved.city, null);
});

test("country/city eccessivamente lunghi (oltre 100 caratteri, palesemente non un nome reale): azzerati, mai rifiutati", async () => {
  const handler = freshHandler();
  const tooLong = "X".repeat(101);
  const item = basePurchase({ country: tooLong, city: tooLong });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.country, null);
  assert.equal(saved.city, null);
});

test("country/city esattamente a 100 caratteri: accettati (il confronto è > 100, non >=)", async () => {
  const handler = freshHandler();
  const exactly100 = "X".repeat(100);
  const item = basePurchase({ country: exactly100, city: exactly100 });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.country, exactly100);
  assert.equal(saved.city, exactly100);
});
