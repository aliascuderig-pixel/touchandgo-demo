// Verifica il limite di prezzo in isValidPurchase() (save-purchase.js) —
// alzato da 500 a 5000 il 3 settembre 2026 dopo un bug reale trovato dal
// vivo: "price" include anche il costo di spedizione oltre alla fee di
// servizio, quindi per un oggetto pesante o una destinazione lontana
// superava facilmente €500 in modo del tutto legittimo. Vedi MANUALE.md,
// "Limite di prezzo per acquisto", per la storia completa (perché il
// rifiuto era permanente, non transitorio — la coda di ritentativo non
// poteva mai riuscire da sola).
//
// Stessa tecnica di save-purchase.commission.test.js: store Netlify Blobs
// finto in memoria, nessuna rete/credenziale reale necessaria.
//
// Esecuzione: node --test  (o direttamente questo file)

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

test("price tra il vecchio limite (500) e il nuovo (5000): ora accettato, prima veniva rifiutato", async () => {
  const handler = freshHandler();
  const item = basePurchase({ price: 750, weightKg: 12 });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200, "un acquisto con price 750 deve essere accettato col nuovo limite di 5000");

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.ok(saved, "l'acquisto deve essere stato salvato nello store");
  assert.equal(saved.price, 750);
});

test("price esattamente al nuovo limite (5000): accettato (il confronto è > 5000, non >=)", async () => {
  const handler = freshHandler();
  const item = basePurchase({ price: 5000, weightKg: 45 });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);
});

test("price oltre il nuovo limite (5000.01): continua a essere rifiutato", async () => {
  const handler = freshHandler();
  const item = basePurchase({ price: 5000.01, weightKg: 45 });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "Dati spedizione non validi");

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved, null, "un acquisto rifiutato non deve essere salvato nello store");
});

test("price molto oltre il limite (es. 50000, palesemente inventato): rifiutato", async () => {
  const handler = freshHandler();
  const item = basePurchase({ price: 50000, weightKg: 20 });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 400);
});

// Caso reale che ha fatto scoprire il bug (vedi MANUALE.md): sedia a
// dondolo, 15kg, verso il Giappone (Tokyo), €1078,50 — con il vecchio
// limite di 500 questo acquisto sarebbe stato rifiutato permanentemente e
// sarebbe rimasto bloccato per sempre nella coda di ritentativo lato
// client. Dato di prova, non un cliente reale.
test("caso reale (sedia a dondolo, 15kg, Giappone, €1078,50): accettato col nuovo limite", async () => {
  const handler = freshHandler();
  const item = basePurchase({
    id: "TG-JP-TEST",
    objectName: "Sedia a dondolo",
    weightKg: 15,
    price: 1078.5,
    pickupPoint: "Roma",
    addressLabel: "Tokyo, Giappone",
    touristName: "Test Giappone",
    touristEmail: "test.giappone@esempio.com",
  });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200, "il caso reale che ha fatto scoprire il bug deve ora essere accettato");

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.ok(saved, "l'acquisto deve essere salvato, non più bloccato in coda per sempre");
  assert.equal(saved.price, 1078.5);
  assert.equal(saved.weightKg, 15);
});
