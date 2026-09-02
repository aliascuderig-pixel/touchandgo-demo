// Il blocco automatico "secondo acquisto senza abbonamento" bloccava
// permanentemente anche clienti con due acquisti del tutto legittimi
// (verificato dal vivo il 1° settembre 2026). Sostituito con una
// segnalazione sul record (flaggedReason/flaggedAt) letta dal CRM, senza
// più alcun blocco automatico — il blocco MANUALE (store "blocklist",
// attivato dallo staff via "Blocca cliente") resta invariato.
//
// Stesso pattern/fake Blobs di save-purchase.commission.test.js.
// Esecuzione: node --test

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
      status: "in sospeso",
    },
    overrides
  );
}

beforeEach(() => {
  resetStores();
});

test("secondo acquisto non abbonato: procede normalmente (200), nessun 403, nessuna scrittura in blocklist", async () => {
  const handler = freshHandler();
  const email = "cliente@test.it";

  const first = basePurchase({ touristEmail: email, pricingTier: "pieno" });
  const res1 = await handler(makeEvent(first));
  assert.equal(res1.statusCode, 200);

  const second = basePurchase({ touristEmail: email, pricingTier: "pieno" });
  const res2 = await handler(makeEvent(second));
  assert.equal(res2.statusCode, 200, "il secondo acquisto non abbonato non deve più essere rifiutato con 403");

  const blocklist = fakeBlobsModule.getStore("blocklist");
  const blockRecord = await blocklist.get(email, { type: "json" });
  assert.equal(blockRecord, null, "nessun record automatico deve finire nello store blocklist");
});

test("il flag viene scritto correttamente sul record del secondo acquisto (flaggedReason/flaggedAt)", async () => {
  const handler = freshHandler();
  const email = "cliente2@test.it";
  const purchases = fakeBlobsModule.getStore("purchases");

  const first = basePurchase({ touristEmail: email, pricingTier: "pieno" });
  await handler(makeEvent(first));
  const savedFirst = await purchases.get(first.id, { type: "json" });
  assert.equal(savedFirst.flaggedReason, undefined, "il primo acquisto non deve mai essere flaggato");

  const second = basePurchase({ touristEmail: email, pricingTier: "pieno" });
  await handler(makeEvent(second));
  const savedSecond = await purchases.get(second.id, { type: "json" });
  assert.equal(savedSecond.flaggedReason, "Secondo acquisto senza abbonamento");
  assert.ok(savedSecond.flaggedAt, "flaggedAt deve essere valorizzato");
  assert.ok(!isNaN(new Date(savedSecond.flaggedAt).getTime()), "flaggedAt deve essere un timestamp valido");
});

test("cliente già stato abbonato in passato: nessun flag su un acquisto successivo non abbonato", async () => {
  const handler = freshHandler();
  const email = "abbonato@test.it";
  const purchases = fakeBlobsModule.getStore("purchases");

  const subscribed = basePurchase({ touristEmail: email, pricingTier: "abbonato" });
  await handler(makeEvent(subscribed));

  const second = basePurchase({ touristEmail: email, pricingTier: "pieno" });
  await handler(makeEvent(second));
  const savedSecond = await purchases.get(second.id, { type: "json" });
  assert.equal(savedSecond.flaggedReason, undefined, "un cliente già stato abbonato non va mai flaggato");
});

test("risincronizzazione dello stesso acquisto (stesso id): non conta come 'secondo acquisto'", async () => {
  const handler = freshHandler();
  const email = "resync@test.it";
  const purchases = fakeBlobsModule.getStore("purchases");

  const item = basePurchase({ touristEmail: email, pricingTier: "pieno" });
  await handler(makeEvent(item));
  await handler(makeEvent(Object.assign({}, item, { status: "in confezionamento" })));

  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.flaggedReason, undefined, "un resync dello stesso id non deve auto-flaggarsi come 'secondo acquisto'");
  assert.equal(saved.status, "in confezionamento");
});

test("blocco MANUALE esistente (email già in blocklist): continua a bloccare correttamente, nessuna regressione", async () => {
  const handler = freshHandler();
  const email = "bloccato-a-mano@test.it";
  const blocklist = fakeBlobsModule.getStore("blocklist");
  await blocklist.setJSON(email, {
    email,
    reason: "Sospetto di frode segnalato dallo staff",
    auto: false,
    blockedAt: new Date().toISOString(),
  });

  const item = basePurchase({ touristEmail: email, pricingTier: "pieno" });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 403, "un cliente bloccato manualmente deve continuare a essere rifiutato");

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved, null, "l'acquisto di un cliente bloccato manualmente non deve essere salvato");
});
