// TOU-12: la commissione partner deve maturare solo sui piani a pagamento,
// mai sul piano gratuito — verifica diretta dell'handler save-purchase.js
// con uno store Netlify Blobs finto in memoria (nessuna rete/credenziale
// reale necessaria). Nessun framework esterno: usa il test runner
// integrato di Node (require("node:test")).
//
// Esecuzione: node --test  (o direttamente: node netlify/functions/__tests__/save-purchase.commission.test.js)

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

// ---- Fake minimale di @netlify/blobs, in memoria, azzerabile tra i test ----
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

// Intercetta require("@netlify/blobs") a livello di modulo Node — il
// pacchetto reale richiede credenziali Netlify e non è installato in questo
// repository (è fornito solo a runtime da Netlify Functions).
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

test("piano gratuito: un acquisto 'ritirato' non deve accreditare commissione al partner", async () => {
  const handler = freshHandler();
  const partners = fakeBlobsModule.getStore("partners");
  await partners.setJSON("FREE1", { code: "FREE1", plan: "free", creditBalance: 0 });

  const item = basePurchase({ status: "ritirato", partnerCode: "FREE1" });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const savedPartner = await partners.get("FREE1", { type: "json" });
  assert.equal(savedPartner.creditBalance, 0, "creditBalance non deve aumentare sul piano gratuito");

  const purchases = fakeBlobsModule.getStore("purchases");
  const savedItem = await purchases.get(item.id, { type: "json" });
  assert.equal(savedItem.status, "ritirato", "l'acquisto deve comunque passare correttamente a ritirato");
  assert.equal(savedItem.creditIssuedAmount, 0, "creditIssuedAmount deve essere esplicitamente 0, non 'non gestito'");
  assert.equal(savedItem.creditIssued, true);
});

test("piano a pagamento: un acquisto 'ritirato' accredita normalmente il 10% di commissione", async () => {
  const handler = freshHandler();
  const partners = fakeBlobsModule.getStore("partners");
  await partners.setJSON("PAID1", { code: "PAID1", plan: "boutique", creditBalance: 0 });

  const item = basePurchase({ status: "ritirato", partnerCode: "PAID1", price: 25 });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const savedPartner = await partners.get("PAID1", { type: "json" });
  assert.equal(savedPartner.creditBalance, 2.5, "10% di 25€ = 2.5€");

  const purchases = fakeBlobsModule.getStore("purchases");
  const savedItem = await purchases.get(item.id, { type: "json" });
  assert.equal(savedItem.creditIssuedAmount, 2.5);
});

test("piano gratuito: un doppio resync dello stesso ordine non altera il saldo (resta a 0)", async () => {
  const handler = freshHandler();
  const partners = fakeBlobsModule.getStore("partners");
  await partners.setJSON("FREE2", { code: "FREE2", plan: "free", creditBalance: 0 });

  const item = basePurchase({ status: "ritirato", partnerCode: "FREE2" });
  await handler(makeEvent(item));
  await handler(makeEvent(item)); // stesso id, ri-sincronizzato una seconda volta

  const savedPartner = await partners.get("FREE2", { type: "json" });
  assert.equal(savedPartner.creditBalance, 0);
});

test("partner senza campo 'plan' (record storico): trattato come a pagamento", async () => {
  const handler = freshHandler();
  const partners = fakeBlobsModule.getStore("partners");
  await partners.setJSON("LEGACY1", { code: "LEGACY1", creditBalance: 0 }); // nessun campo plan

  const item = basePurchase({ status: "ritirato", partnerCode: "LEGACY1", price: 25 });
  await handler(makeEvent(item));

  const savedPartner = await partners.get("LEGACY1", { type: "json" });
  assert.equal(savedPartner.creditBalance, 2.5, "partner storico senza plan continua a maturare commissione come prima di TOU-12");
});
