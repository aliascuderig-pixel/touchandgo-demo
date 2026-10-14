// save-purchase.js stampa schemaVersion: 1 sui nuovi acquisti (contratto con
// CRM, e-shop e gestionale sullo store condiviso "purchases"). La versione la
// decide il server: un valore mandato dal client viene sovrascritto.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

let stores = {};
const fakeBlobsModule = {
  getStore(opts) {
    const name = typeof opts === "string" ? opts : opts.name;
    if (!stores[name]) stores[name] = new Map();
    const store = stores[name];
    return {
      async get(key, { type } = {}) { const v = store.get(key); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
      async setJSON(key, value) { store.set(key, JSON.stringify(value)); },
      async list() { return { blobs: Array.from(store.keys()).map((key) => ({ key })) }; },
    };
  },
};
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@netlify/blobs") return fakeBlobsModule;
  return originalLoad.call(this, request, ...args);
};
const handlerPath = path.join(__dirname, "..", "save-purchase.js");
const freshHandler = () => { delete require.cache[require.resolve(handlerPath)]; return require(handlerPath).handler; };
const ev = (body) => ({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": "127.0.0.1" }, body: JSON.stringify(body) });
const base = (o) => Object.assign({ id: "t-" + Math.random().toString(36).slice(2), objectName: "Vaso", hsCode: "1234.56", weightKg: 1.2, dims: { l: 10, w: 10, h: 10 }, itemValue: 50, pricingTier: "pieno", addressLabel: "Casa", price: 25, touristName: "Mario", touristEmail: "m@test.it", status: "in sospeso" }, o);
beforeEach(() => { stores = {}; });

test("un nuovo acquisto salvato ha schemaVersion 1", async () => {
  const item = base();
  assert.equal((await freshHandler()(ev(item))).statusCode, 200);
  const saved = await fakeBlobsModule.getStore("purchases").get(item.id, { type: "json" });
  assert.equal(saved.schemaVersion, 1);
});

test("la versione la decide il server: un valore del client viene sovrascritto", async () => {
  const item = base({ schemaVersion: 99 });
  await freshHandler()(ev(item));
  const saved = await fakeBlobsModule.getStore("purchases").get(item.id, { type: "json" });
  assert.equal(saved.schemaVersion, 1);
});
