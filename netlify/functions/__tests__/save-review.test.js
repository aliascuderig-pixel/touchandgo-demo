// Verifica save-review.js: una recensione valida viene salvata con
// status "pending" e collegata al purchaseId/partnerCode giusti; rating
// fuori range (0, 6, decimali, non-interi) e testo troppo lungo vengono
// rifiutati prima di toccare lo store; il rate limiting per IP funziona.
// Stesso fake minimale di @netlify/blobs già usato in
// save-shipment-group.test.js (nessuna rete/credenziale reale necessaria).

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

const handlerPath = path.join(__dirname, "..", "save-review.js");
function freshHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath).handler;
}

function makeEvent(body, ip) {
  return {
    httpMethod: "POST",
    headers: { "x-nf-client-connection-ip": ip || "127.0.0.1" },
    body: JSON.stringify(body),
  };
}

function baseReview(overrides) {
  return Object.assign(
    {
      purchaseId: "item-123",
      shipmentGroupCode: "TG-AAA111",
      partnerCode: "BTQ123",
      rating: 5,
      text: "Servizio velocissimo, tutto perfetto!",
    },
    overrides
  );
}

beforeEach(() => {
  resetStores();
});

test("recensione valida: salvata come pending, collegata a purchaseId/partnerCode", async () => {
  const handler = freshHandler();
  const review = baseReview();
  const res = await handler(makeEvent(review));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.id, "deve restituire l'id della recensione creata");

  const reviews = fakeBlobsModule.getStore("reviews");
  const saved = await reviews.get(body.id, { type: "json" });
  assert.ok(saved, "la recensione deve essere leggibile dal CRM");
  assert.equal(saved.status, "pending");
  assert.equal(saved.purchaseId, "item-123");
  assert.equal(saved.partnerCode, "BTQ123");
  assert.equal(saved.shipmentGroupCode, "TG-AAA111");
  assert.equal(saved.rating, 5);
  assert.ok(saved.createdAt);
});

test("metodo diverso da POST: rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler({ httpMethod: "GET" });
  assert.equal(res.statusCode, 405);
});

test("rating 0: rifiutato, nessuna scrittura", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent(baseReview({ rating: 0 })));
  assert.equal(res.statusCode, 400);
  const reviews = fakeBlobsModule.getStore("reviews");
  assert.equal((await reviews.list()).blobs.length, 0);
});

test("rating 6: rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent(baseReview({ rating: 6 })));
  assert.equal(res.statusCode, 400);
});

test("rating decimale (3.5): rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent(baseReview({ rating: 3.5 })));
  assert.equal(res.statusCode, 400);
});

test("rating come stringa: rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent(baseReview({ rating: "5" })));
  assert.equal(res.statusCode, 400);
});

test("senza purchaseId: rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent(baseReview({ purchaseId: "" })));
  assert.equal(res.statusCode, 400);
});

test("testo eccessivamente lungo (oltre il cap plausibile): rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent(baseReview({ text: "x".repeat(601) })));
  assert.equal(res.statusCode, 400);
});

test("testo assente: accettato, salvato come stringa vuota", async () => {
  const handler = freshHandler();
  const review = baseReview();
  delete review.text;
  const res = await handler(makeEvent(review));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const reviews = fakeBlobsModule.getStore("reviews");
  const saved = await reviews.get(body.id, { type: "json" });
  assert.equal(saved.text, "");
});

test("senza partnerCode/shipmentGroupCode: accettato, campi salvati come null", async () => {
  const handler = freshHandler();
  const review = baseReview({ partnerCode: null, shipmentGroupCode: null });
  const res = await handler(makeEvent(review));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const reviews = fakeBlobsModule.getStore("reviews");
  const saved = await reviews.get(body.id, { type: "json" });
  assert.equal(saved.partnerCode, null);
  assert.equal(saved.shipmentGroupCode, null);
});

test("rate limiting: oltre 20 richieste dallo stesso IP in 60 minuti vengono rifiutate", async () => {
  const handler = freshHandler();
  let lastRes;
  for (let i = 0; i < 21; i++) {
    lastRes = await handler(makeEvent(baseReview({ purchaseId: `item-${i}` }), "9.9.9.9"));
  }
  assert.equal(lastRes.statusCode, 429);
});

test("due recensioni distinte non si sovrascrivono a vicenda", async () => {
  const handler = freshHandler();
  const res1 = await handler(makeEvent(baseReview({ purchaseId: "item-A" })));
  const res2 = await handler(makeEvent(baseReview({ purchaseId: "item-B", rating: 2 })));
  const id1 = JSON.parse(res1.body).id;
  const id2 = JSON.parse(res2.body).id;
  assert.notEqual(id1, id2);

  const reviews = fakeBlobsModule.getStore("reviews");
  assert.equal((await reviews.get(id1, { type: "json" })).purchaseId, "item-A");
  assert.equal((await reviews.get(id2, { type: "json" })).purchaseId, "item-B");
});
