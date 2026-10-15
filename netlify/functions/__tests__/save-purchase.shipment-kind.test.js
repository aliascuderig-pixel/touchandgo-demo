// Verifica il tipo di spedizione (acquisto | bagaglio) in save-purchase.js:
// bagaglio con direzione andata/ritorno salvato; incoerenze rifiutate o
// ripulite; gli acquisti esistenti (senza il campo) restano "acquisto".

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


async function save(item) {
  const res = await freshHandler()(makeEvent(item));
  const saved = await fakeBlobsModule.getStore("purchases").get(item.id, { type: "json" });
  return { res, saved };
}

test("acquisto senza il campo (record come prima): salvato come 'acquisto', nessun campo bagaglio", async () => {
  const { res, saved } = await save(basePurchase());
  assert.equal(res.statusCode, 200);
  assert.equal(saved.shipmentKind, "acquisto");
  assert.equal(saved.luggageDirection, undefined);
});

test("bagaglio di ritorno: salvato con direzione, senza stayLabel", async () => {
  const { res, saved } = await save(basePurchase({ shipmentKind: "bagaglio", luggageDirection: "ritorno", stayLabel: "Hotel X" }));
  assert.equal(res.statusCode, 200);
  assert.equal(saved.shipmentKind, "bagaglio");
  assert.equal(saved.luggageDirection, "ritorno");
  assert.equal(saved.stayLabel, undefined, "per il ritorno il luogo di soggiorno non serve");
});

test("bagaglio di andata: salvato con direzione e luogo di soggiorno ripulito e limitato", async () => {
  const { res, saved } = await save(basePurchase({ shipmentKind: "bagaglio", luggageDirection: "andata", stayLabel: "  " + "H".repeat(300) + " " }));
  assert.equal(res.statusCode, 200);
  assert.equal(saved.luggageDirection, "andata");
  assert.equal(saved.stayLabel.length, 120);
});

test("bagaglio senza direzione o con direzione non valida: 400, nulla salvato", async () => {
  for (const luggageDirection of [undefined, "", "boh", 1]) {
    const item = basePurchase({ shipmentKind: "bagaglio", luggageDirection });
    const { res, saved } = await save(item);
    assert.equal(res.statusCode, 400);
    assert.equal(saved, null);
  }
});

test("tipo non ammesso: 400", async () => {
  const { res } = await save(basePurchase({ shipmentKind: "pacco-regalo" }));
  assert.equal(res.statusCode, 400);
});

test("acquisto con campi bagaglio incoerenti: i campi bagaglio vengono tolti", async () => {
  const { res, saved } = await save(basePurchase({ shipmentKind: "acquisto", luggageDirection: "andata", stayLabel: "Hotel" }));
  assert.equal(res.statusCode, 200);
  assert.equal(saved.luggageDirection, undefined);
  assert.equal(saved.stayLabel, undefined);
});

test("stayLabel non stringa per un bagaglio di andata: 400", async () => {
  const { res } = await save(basePurchase({ shipmentKind: "bagaglio", luggageDirection: "andata", stayLabel: { a: 1 } }));
  assert.equal(res.statusCode, 400);
});
