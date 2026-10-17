// «Mettilo in vendita» dall'app turista (17/10/2026): un clic crea l'annuncio
// nell'Usato dell'E-shop; la proprietà si verifica con l'email dell'acquisto.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

let stores = {};
let writeLog = [];
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
      async setJSON(key, value) { writeLog.push({ store: name, key }); store.set(key, JSON.stringify(value)); },
      async list() { return { blobs: Array.from(store.keys()).map((key) => ({ key })) }; },
    };
  },
};
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@netlify/blobs") return fakeBlobsModule;
  return originalLoad.call(this, request, ...args);
};
const handlerPath = path.join(__dirname, "..", "list-used-item.js");
function freshHandler() {
  for (const k of Object.keys(require.cache)) if (k.includes(path.join("netlify", "lib")) || k === handlerPath) delete require.cache[k];
  return require(handlerPath).handler;
}
let n = 0;
async function call(h, body, ip) {
  const r = await h({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip || "1.1.1." + ++n }, body: JSON.stringify(body) });
  return { status: r.statusCode, data: JSON.parse(r.body) };
}
const PURCHASE = { id: "TG-ABC123", objectName: "Borsa in pelle", category: "Accessori Moda", itemValue: 120, touristName: "Maria Rossi", touristEmail: "maria@example.it", status: "ritirato", deliveryConfirmedAt: "2026-10-10T10:00:00Z", photo: "data:image/jpeg;base64,AAA" };
function seed(p) {
  stores["purchases"] = new Map([[(p || PURCHASE).id, JSON.stringify(p || PURCHASE)]]);
}
beforeEach(() => { stores = {}; writeLog = []; });

test("un clic: annuncio creato, con commissione e promozione nella risposta", async () => {
  seed();
  const r = await call(freshHandler(), { purchaseId: "tg-abc123", email: " Maria@Example.it " });
  assert.equal(r.status, 200);
  assert.equal(r.data.listed, true);
  assert.equal(r.data.created, true);
  assert.equal(r.data.price, 120);
  assert.equal(r.data.commissionRate, 0.2);
  assert.equal(r.data.promoActive, true, "promozione commissione gratuita attiva di default");
  assert.equal(r.data.effectiveRate, 0);
  const listing = JSON.parse([...stores["eshop-used"].values()][0]);
  assert.equal(listing.title, "Borsa in pelle");
  assert.equal(listing.status, "in vendita");
  assert.equal(listing.photo, "data:image/jpeg;base64,AAA");
  assert.ok(listing.description.includes("Categoria: Accessori Moda"));
});

test("secondo clic: nessun duplicato", async () => {
  seed();
  const h = freshHandler();
  await call(h, { purchaseId: "TG-ABC123", email: "maria@example.it" });
  const r = await call(h, { purchaseId: "TG-ABC123", email: "maria@example.it" });
  assert.equal(r.status, 200);
  assert.equal(r.data.created, false);
  assert.equal(stores["eshop-used"].size, 1);
});

test("email diversa o acquisto inesistente: stesso errore 404, nessun annuncio", async () => {
  seed();
  const h = freshHandler();
  const a = await call(h, { purchaseId: "TG-ABC123", email: "altra@example.it" });
  const b = await call(h, { purchaseId: "TG-ZZZ999", email: "maria@example.it" });
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.deepEqual(a.data, b.data);
  assert.ok(!stores["eshop-used"] || stores["eshop-used"].size === 0);
});

test("consegna non confermata, bagaglio o email mancante sul record: rifiutati", async () => {
  const h = freshHandler();
  seed(Object.assign({}, PURCHASE, { deliveryConfirmedAt: undefined }));
  assert.equal((await call(h, { purchaseId: "TG-ABC123", email: "maria@example.it" })).status, 409);
  seed(Object.assign({}, PURCHASE, { shipmentKind: "bagaglio" }));
  assert.equal((await call(h, { purchaseId: "TG-ABC123", email: "maria@example.it" })).status, 409);
  seed(Object.assign({}, PURCHASE, { touristEmail: null }));
  assert.equal((await call(h, { purchaseId: "TG-ABC123", email: "maria@example.it" })).status, 409);
});

test("input non valido e metodo diverso da POST", async () => {
  seed();
  const h = freshHandler();
  assert.equal((await call(h, { purchaseId: "../x", email: "a@b.it" })).status, 400);
  assert.equal((await call(h, { purchaseId: "TG-ABC123", email: "" })).status, 400);
  assert.equal((await h({ httpMethod: "GET", headers: {} })).statusCode, 405);
});

test("non scrive MAI su 'purchases' e non espone dati privati nella risposta", async () => {
  seed();
  const r = await call(freshHandler(), { purchaseId: "TG-ABC123", email: "maria@example.it" });
  assert.ok(!writeLog.some((w) => w.store === "purchases"));
  assert.ok(!JSON.stringify(r.data).includes("maria@example.it"));
});

test("rate limit: 10 richieste/ora per IP, poi 429", async () => {
  seed();
  const h = freshHandler();
  let last;
  for (let i = 0; i < 11; i++) last = await call(h, { purchaseId: "TG-ABC123", email: "x@y.it" }, "5.5.5.5");
  assert.equal(last.status, 429);
});

test("annuncio senza valore dichiarato = bozza (non pubblico), la risposta lo segnala", async () => {
  seed(Object.assign({}, PURCHASE, { itemValue: 0 }));
  const r = await call(freshHandler(), { purchaseId: "TG-ABC123", email: "maria@example.it" });
  assert.equal(r.data.status, "bozza");
  assert.equal(r.data.listed, false);
});
