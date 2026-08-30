// Verifica save-shipment-group.js: un gruppo valido viene salvato con la
// stessa chiave del bookingCode; dati palesemente inventati vengono
// rifiutati prima di toccare lo store. Stesso fake minimale di
// @netlify/blobs già usato in save-purchase.commission.test.js (nessuna
// rete/credenziale reale necessaria).

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

test("gruppo valido: salvato con chiave = bookingCode", async () => {
  const handler = freshHandler();
  const group = baseGroup();
  const res = await handler(makeEvent(group));
  assert.equal(res.statusCode, 200);

  const shipmentGroups = fakeBlobsModule.getStore("shipment-groups");
  const saved = await shipmentGroups.get(group.code, { type: "json" });
  assert.ok(saved, "il gruppo deve essere leggibile dal CRM tramite il bookingCode");
  assert.equal(saved.total, 71.5);
  assert.deepEqual(saved.itemIds, ["item-1", "item-2"]);
});

test("metodo diverso da POST: rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler({ httpMethod: "GET" });
  assert.equal(res.statusCode, 405);
});

test("senza itemIds: rifiutato, nessuna scrittura", async () => {
  const handler = freshHandler();
  const group = baseGroup({ itemIds: [] });
  const res = await handler(makeEvent(group));
  assert.equal(res.statusCode, 400);
  const shipmentGroups = fakeBlobsModule.getStore("shipment-groups");
  assert.equal((await shipmentGroups.list()).blobs.length, 0);
});

test("peso non plausibile (0 o negativo): rifiutato", async () => {
  const handler = freshHandler();
  const group = baseGroup({ weightKg: 0 });
  const res = await handler(makeEvent(group));
  assert.equal(res.statusCode, 400);
});

test("prezzo non plausibile (fuori range): rifiutato", async () => {
  const handler = freshHandler();
  const group = baseGroup({ total: 999999 });
  const res = await handler(makeEvent(group));
  assert.equal(res.statusCode, 400);
});

test("due gruppi diversi non si sovrascrivono a vicenda", async () => {
  const handler = freshHandler();
  const g1 = baseGroup({ code: "TG-AAA111" });
  const g2 = baseGroup({ code: "TG-BBB222", dest: "Ufficio — altrove" });
  await handler(makeEvent(g1));
  await handler(makeEvent(g2));

  const shipmentGroups = fakeBlobsModule.getStore("shipment-groups");
  assert.equal((await shipmentGroups.get("TG-AAA111", { type: "json" })).dest, g1.dest);
  assert.equal((await shipmentGroups.get("TG-BBB222", { type: "json" })).dest, g2.dest);
});
