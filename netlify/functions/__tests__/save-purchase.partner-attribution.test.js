// Verifica l'attribuzione partner persistente per touristEmail — vedi
// MANUALE.md, sezione "Attribuzione partner persistente per touristEmail".
//
// Regola: l'ultimo codice partner usato ESPLICITAMENTE per una spedizione
// di un dato touristEmail (via gestionale partner -> generatedByPartnerCode,
// via QR/link -> item.partnerCode, o inserito manualmente -> item.partnerCode)
// diventa il "partner di riferimento corrente" per quel cliente, salvato in
// un nuovo store dedicato ("partner-attribution", keyed per email
// normalizzata). Una spedizione self-service successiva SENZA alcun codice
// esplicito riceve automaticamente quell'attribuzione (item.partnerCode
// impostato da resolvePartnerAttribution() in save-purchase.js) — finché un
// nuovo codice esplicito non la sovrascrive.
//
// Vincolo verificato esplicitamente: questo meccanismo NON tocca la logica
// di calcolo della commissione stessa (COMMISSION_RATE, il blocco "ritirato"
// + partnerCode) — solo QUALE partnerCode viene applicato all'item prima che
// quel blocco, invariato, lo legga.
//
// Stesso fake minimale di @netlify/blobs già usato negli altri test di
// save-purchase.js in questo repository (nessuna rete/credenziale reale).
//
// Esecuzione: node --test  (dalla root del repository)

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
      status: "in sospeso",
    },
    overrides
  );
}

beforeEach(() => {
  resetStores();
});

test("(1) prima spedizione con codice esplicito (item.partnerCode) -> attribuzione salvata per quell'email", async () => {
  const handler = freshHandler();
  const email = "cliente1@example.it";
  const item = basePurchase({ touristEmail: email, partnerCode: "AGZ001" });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const attribution = fakeBlobsModule.getStore("partner-attribution");
  const saved = await attribution.get(email, { type: "json" });
  assert.ok(saved, "deve esistere un'attribuzione per questa email");
  assert.equal(saved.partnerCode, "AGZ001");
});

test("(1b) prima spedizione generata dal GESTIONALE (generatedByPartnerCode, mai partnerCode sull'item) -> attribuzione salvata comunque", async () => {
  const handler = freshHandler();
  const email = "cliente-gestionale@example.it";
  const item = basePurchase({ touristEmail: email, generatedByPartnerCode: "AGZ002" });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const attribution = fakeBlobsModule.getStore("partner-attribution");
  const saved = await attribution.get(email, { type: "json" });
  assert.equal(saved.partnerCode, "AGZ002", "l'uso esplicito via gestionale deve aggiornare l'attribuzione");

  const purchases = fakeBlobsModule.getStore("purchases");
  const savedItem = await purchases.get(item.id, { type: "json" });
  assert.equal(savedItem.partnerCode, undefined, "l'item generato dal gestionale non deve MAI ricevere lui stesso item.partnerCode (mai una commissione sulla propria vendita diretta)");
});

test("(2) spedizione successiva self-service SENZA codice -> applica automaticamente l'attribuzione salvata", async () => {
  const handler = freshHandler();
  const email = "cliente2@example.it";

  // Prima spedizione: codice esplicito, stabilisce l'attribuzione.
  await handler(makeEvent(basePurchase({ touristEmail: email, partnerCode: "AGZ010" })));

  // Seconda spedizione, self-service, nessun partnerCode nel payload.
  const secondItem = basePurchase({ touristEmail: email });
  assert.equal(secondItem.partnerCode, undefined);
  const res = await handler(makeEvent(secondItem));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(secondItem.id, { type: "json" });
  assert.equal(saved.partnerCode, "AGZ010", "il partner deve essere applicato automaticamente, senza che il turista faccia nulla");
});

test("(3) una spedizione successiva con un codice ESPLICITO DIVERSO sovrascrive l'attribuzione precedente", async () => {
  const handler = freshHandler();
  const email = "cliente3@example.it";

  await handler(makeEvent(basePurchase({ touristEmail: email, partnerCode: "AGZ_VECCHIO" })));

  const thirdItem = basePurchase({ touristEmail: email, partnerCode: "AGZ_NUOVO" });
  const res = await handler(makeEvent(thirdItem));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(thirdItem.id, { type: "json" });
  assert.equal(saved.partnerCode, "AGZ_NUOVO", "questa spedizione va al nuovo partner esplicito, non al vecchio");

  const attribution = fakeBlobsModule.getStore("partner-attribution");
  const record = await attribution.get(email, { type: "json" });
  assert.equal(record.partnerCode, "AGZ_NUOVO", "l'attribuzione salvata deve essere sovrascritta col nuovo codice");
});

test("(4) una successiva ancora senza codice applica il NUOVO partner, non più il primo", async () => {
  const handler = freshHandler();
  const email = "cliente4@example.it";

  await handler(makeEvent(basePurchase({ touristEmail: email, partnerCode: "AGZ_A" })));
  await handler(makeEvent(basePurchase({ touristEmail: email, partnerCode: "AGZ_B" }))); // sovrascrive con B

  const fourthItem = basePurchase({ touristEmail: email }); // self-service, nessun codice
  const res = await handler(makeEvent(fourthItem));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(fourthItem.id, { type: "json" });
  assert.equal(saved.partnerCode, "AGZ_B", "deve applicare l'ULTIMO codice noto (B), mai il primo (A)");
});

test("(5) un touristEmail mai visto prima: nessuna attribuzione, comportamento invariato rispetto a oggi", async () => {
  const handler = freshHandler();
  const item = basePurchase({ touristEmail: "mai-visto@example.it" }); // nessun codice, nessuna storia
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.partnerCode, undefined, "senza attribuzione precedente, l'item non deve avere alcun partnerCode, come oggi");

  const attribution = fakeBlobsModule.getStore("partner-attribution");
  assert.equal(await attribution.get("mai-visto@example.it", { type: "json" }), null, "non deve nemmeno essere stato creato un record vuoto");
});

// ---------------------------------------------------------------------
// Vincolo: non tocca la logica di calcolo della commissione — solo quale
// partnerCode viene applicato. Verificato end-to-end: un'attribuzione
// auto-applicata a un item self-service che arriva "ritirato" genera
// comunque la commissione con lo STESSO meccanismo/aliquota esistente.
// ---------------------------------------------------------------------

test("l'attribuzione automatica alimenta il meccanismo di commissione ESISTENTE, invariato (10% su piano a pagamento)", async () => {
  const handler = freshHandler();
  const partners = fakeBlobsModule.getStore("partners");
  await partners.setJSON("AGZ_COMM", { code: "AGZ_COMM", plan: "boutique", creditBalance: 0 });
  const email = "cliente-commissione@example.it";

  // Primo acquisto self-service con codice esplicito, status "in sospeso" (non ancora ritirato -> nessuna commissione ancora).
  await handler(makeEvent(basePurchase({ touristEmail: email, partnerCode: "AGZ_COMM", status: "in sospeso" })));
  let saved = await partners.get("AGZ_COMM", { type: "json" });
  assert.equal(saved.creditBalance, 0, "nessuna commissione finché lo stato non è 'ritirato'");

  // Secondo acquisto, self-service, SENZA codice, che arriva DIRETTAMENTE "ritirato":
  // l'attribuzione automatica applica AGZ_COMM, e il blocco commissione esistente (invariato) matura normalmente.
  const secondItem = basePurchase({ touristEmail: email, status: "ritirato", price: 40 });
  await handler(makeEvent(secondItem));

  saved = await partners.get("AGZ_COMM", { type: "json" });
  assert.equal(saved.creditBalance, 4, "10% di 40€ = 4€, stessa aliquota/meccanismo esistente, mai toccato");

  const purchases = fakeBlobsModule.getStore("purchases");
  const savedItem = await purchases.get(secondItem.id, { type: "json" });
  assert.equal(savedItem.partnerCode, "AGZ_COMM", "il partnerCode applicato automaticamente deve essere quello salvato in item, non solo usato internamente");
  assert.equal(savedItem.creditIssued, true);
  assert.equal(savedItem.creditIssuedAmount, 4);
});

test("un item che porta GIÀ un campo esplicito non viene mai toccato dall'auto-attribuzione, anche se un'attribuzione diversa esiste per quell'email", async () => {
  const handler = freshHandler();
  const email = "cliente-conflitto@example.it";
  await handler(makeEvent(basePurchase({ touristEmail: email, partnerCode: "AGZ_VECCHIO" })));

  // Questo item porta un generatedByPartnerCode diverso -> è "esplicito" lui stesso, l'auto-attribuzione non deve intervenire.
  const item = basePurchase({ touristEmail: email, generatedByPartnerCode: "AGZ_GESTIONALE" });
  await handler(makeEvent(item));

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.partnerCode, undefined, "un item col proprio campo esplicito (generatedByPartnerCode) non deve MAI ricevere anche item.partnerCode dall'auto-attribuzione");
  assert.equal(saved.generatedByPartnerCode, "AGZ_GESTIONALE");

  const attribution = fakeBlobsModule.getStore("partner-attribution");
  const record = await attribution.get(email, { type: "json" });
  assert.equal(record.partnerCode, "AGZ_GESTIONALE", "l'attribuzione deve comunque aggiornarsi al nuovo codice esplicito");
});

test("email assente sul payload: nessuna attribuzione letta né scritta, nessun errore", async () => {
  const handler = freshHandler();
  const item = basePurchase({ partnerCode: "AGZ_QUALSIASI" }); // nessun touristEmail, ma con un codice esplicito
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);
  const attribution = stores["partner-attribution"];
  assert.equal(attribution ? attribution.size : 0, 0, "senza email non deve essere scritto alcun record di attribuzione");
});
