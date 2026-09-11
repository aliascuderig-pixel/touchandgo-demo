// Verifica la regola anti-frode 8 ("Numero insolito di oggetti in una
// spedizione") in save-shipment-group.js — vedi save-purchase.js per le
// regole 1-7 sul singolo acquisto. Stesso fake minimale di @netlify/blobs
// già usato in save-shipment-group.test.js. Esecuzione: node --test

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

const handlerPath = path.join(__dirname, "..", "save-shipment-group.js");
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

function baseGroup(overrides) {
  return Object.assign(
    {
      code: "TG-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      dest: "Casa — Via Roma 1, 00100 Roma, Italia",
      destinationCountry: "Italia",
      itemIds: ["item-1", "item-2"],
      itemCount: 2,
      weightKg: 2.5,
      shipping: 32.5,
      fee: 39,
      total: 71.5,
      eta: "24–48 ore",
      touristEmail: "mario@test.it",
      createdAt: new Date().toISOString(),
    },
    overrides
  );
}

beforeEach(() => {
  resetStores();
});

test("gruppo con 7 oggetti (sopra soglia) -> flaggedReasons, ma 200 e comunque salvato", async () => {
  const handler = freshHandler();
  const shipmentGroups = fakeBlobsModule.getStore("shipment-groups");
  const itemIds = Array.from({ length: 7 }, (_, i) => `item-${i}`);
  const group = baseGroup({ itemIds, itemCount: 7 });

  const res = await handler(makeEvent(group));
  assert.equal(res.statusCode, 200, "mai un blocco, solo segnalazione");

  const saved = await shipmentGroups.get(group.code, { type: "json" });
  assert.ok(saved, "il gruppo deve comunque essere salvato");
  assert.deepEqual(saved.flaggedReasons, ["Numero insolito di oggetti in una spedizione"]);
  assert.ok(saved.flaggedAt);
  assert.ok(!isNaN(new Date(saved.flaggedAt).getTime()));
});

test("gruppo con esattamente 6 oggetti (soglia, non superata) -> nessun flag", async () => {
  const handler = freshHandler();
  const shipmentGroups = fakeBlobsModule.getStore("shipment-groups");
  const itemIds = Array.from({ length: 6 }, (_, i) => `item-${i}`);
  const group = baseGroup({ itemIds, itemCount: 6 });

  await handler(makeEvent(group));
  const saved = await shipmentGroups.get(group.code, { type: "json" });
  assert.equal(saved.flaggedReasons, undefined);
});

test("gruppo con pochi oggetti (caso comune) -> nessun flag, comportamento invariato", async () => {
  const handler = freshHandler();
  const shipmentGroups = fakeBlobsModule.getStore("shipment-groups");
  const group = baseGroup(); // 2 oggetti, default

  const res = await handler(makeEvent(group));
  assert.equal(res.statusCode, 200);
  const saved = await shipmentGroups.get(group.code, { type: "json" });
  assert.equal(saved.flaggedReasons, undefined);
  assert.equal(saved.total, 71.5, "nessuna regola anti-frode deve mai toccare il prezzo");
});

test("itemCount mandato dal client viene ignorato: il conteggio reale è sempre itemIds.length", async () => {
  const handler = freshHandler();
  const shipmentGroups = fakeBlobsModule.getStore("shipment-groups");
  // Client mente su itemCount (2) ma manda 8 itemIds reali: deve comunque
  // scattare, perché il conteggio autoritativo è itemIds.length.
  const itemIds = Array.from({ length: 8 }, (_, i) => `item-${i}`);
  const group = baseGroup({ itemIds, itemCount: 2 });

  await handler(makeEvent(group));
  const saved = await shipmentGroups.get(group.code, { type: "json" });
  assert.deepEqual(saved.flaggedReasons, ["Numero insolito di oggetti in una spedizione"]);
});
