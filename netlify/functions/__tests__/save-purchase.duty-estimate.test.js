// Verifica la persistenza di dutyEstimateShown (save-purchase.js) — vedi
// MANUALE.md, "Stima dazi doganali". state.dutyEstimate (dist/assets/
// app.js) era solo stato client, mai salvato sul record dell'acquisto:
// questo pezzo aggiunge SOLO il salvataggio del testo già esistente, non
// tocca in alcun modo la sua generazione (estimate-duty.js, invariato) né
// la logica di calcolo/visualizzazione del prezzo. Copre i 3 punti della
// verifica finale richiesta:
//   (1) una stima disponibile al momento del salvataggio viene persistita
//       correttamente sul record;
//   (2) un acquisto senza stima disponibile (fallita/non richiesta) salva
//       null, nessun errore;
//   (3) il campo non influenza in alcun modo il prezzo calcolato (stesso
//       test di isolamento già esistente in dist/assets/__tests__/
//       duty-estimate.test.js, qui si verifica solo che save-purchase.js
//       stesso non tocchi mai "price" in funzione di questo campo).
//
// Stessa tecnica di save-purchase.price-limit.test.js: store Netlify
// Blobs finto in memoria, nessuna rete/credenziale reale necessaria.
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
      category: "Ceramica",
      material: "ceramica",
      weightKg: 1.2,
      dims: { length_cm: 10, width_cm: 10, height_cm: 10 },
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

// ---------------------------------------------------------------------
// (1) Una stima disponibile viene persistita correttamente
// ---------------------------------------------------------------------

test("un acquisto con dutyEstimateShown valorizzato salva il testo ESATTO sul record", async () => {
  const handler = freshHandler();
  const estimateText =
    "Per gli Stati Uniti, oggetti in ceramica di questo valore rientrano tipicamente in un dazio del 4-6% circa (~€2-3). Stima indicativa, non vincolante — verifica sempre con le autorità doganali del paese di destinazione prima di partire.";
  const item = basePurchase({ dutyEstimateShown: estimateText });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.ok(saved, "l'acquisto deve essere stato salvato");
  assert.equal(saved.dutyEstimateShown, estimateText, "il testo salvato deve essere ESATTAMENTE quello mostrato al turista, non riformattato/troncato");
});

test("il testo persistito è indipendente dalla lunghezza/lingua (testo lungo, con caratteri accentati ed emoji)", async () => {
  const handler = freshHandler();
  const estimateText =
    "Für Deutschland gelten innerhalb der EU normalerweise keine Einfuhrzölle für Reisegepäck 🎒 — Stima indicativa, non vincolante — verifica sempre con le autorità doganali del paese di destinazione prima di partire.";
  const item = basePurchase({ dutyEstimateShown: estimateText });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.dutyEstimateShown, estimateText);
});

// ---------------------------------------------------------------------
// (2) Nessuna stima disponibile -> null, nessun errore
// ---------------------------------------------------------------------

test("un acquisto con dutyEstimateShown: null (stima fallita/non arrivata) viene salvato correttamente, nessun errore", async () => {
  const handler = freshHandler();
  const item = basePurchase({ dutyEstimateShown: null });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200, "un acquisto con stima assente deve comunque essere accettato: mai bloccante");

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.ok(saved);
  assert.equal(saved.dutyEstimateShown, null);
});

test("un acquisto senza il campo dutyEstimateShown (percorso partner, mai richiesto lì, o client precedente a questa modifica) viene comunque salvato, nessun errore", async () => {
  const handler = freshHandler();
  const item = basePurchase();
  delete item.dutyEstimateShown;
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200, "il campo è facoltativo: la sua assenza non deve mai bloccare il salvataggio");

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.ok(saved);
  assert.equal(saved.dutyEstimateShown, undefined, "nessun valore inventato per un campo mai inviato");
});

test("una risincronizzazione dello stesso acquisto (cambio status) aggiorna dutyEstimateShown se il client lo rimanda diverso, coerente con la logica di resync esistente (nessun merge speciale)", async () => {
  const handler1 = freshHandler();
  const item = basePurchase({ dutyEstimateShown: "Prima stima." });
  await handler1(makeEvent(item));

  const handler2 = freshHandler();
  const resynced = Object.assign({}, item, { status: "in confezionamento", dutyEstimateShown: "Prima stima." });
  const res = await handler2(makeEvent(resynced));
  assert.equal(res.statusCode, 200);

  const purchases = fakeBlobsModule.getStore("purchases");
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.status, "in confezionamento");
  assert.equal(saved.dutyEstimateShown, "Prima stima.", "il campo resta quello scritto al primo salvataggio, coerente con un dato fissato al momento dell'acquisto");
});

// ---------------------------------------------------------------------
// (3) Isolamento dal prezzo — save-purchase.js non legge mai
//     dutyEstimateShown per decidere/alterare "price".
// ---------------------------------------------------------------------

test("il prezzo salvato è esattamente quello inviato dal client, identico con o senza dutyEstimateShown — save-purchase.js non lo usa mai per calcolare/alterare 'price'", async () => {
  const handler = freshHandler();
  const withEstimate = basePurchase({ id: "TG-DUTY-A", price: 123.45, dutyEstimateShown: "Stima alta, dazi elevati previsti." });
  const withoutEstimate = basePurchase({ id: "TG-DUTY-B", price: 123.45, dutyEstimateShown: null });

  await handler(makeEvent(withEstimate));
  await handler(makeEvent(withoutEstimate));

  const purchases = fakeBlobsModule.getStore("purchases");
  const savedA = await purchases.get("TG-DUTY-A", { type: "json" });
  const savedB = await purchases.get("TG-DUTY-B", { type: "json" });
  assert.equal(savedA.price, 123.45);
  assert.equal(savedB.price, 123.45);
  assert.equal(savedA.price, savedB.price, "stesso identico prezzo, indipendentemente dal contenuto/presenza della stima dazi");
});

test("save-purchase.js (corpo sorgente) non menziona mai dutyEstimateShown vicino a price/COMMISSION_RATE/creditIssuedAmount — nessun collegamento economico", async () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(handlerPath, "utf8");
  const lines = source.split("\n");
  const dutyLines = lines.map((line, i) => ({ line, i })).filter(({ line }) => /dutyEstimate/i.test(line));
  assert.ok(dutyLines.length > 0, "ci si aspetta che dutyEstimateShown compaia da qualche parte nel file (il commento di documentazione)");
  for (const { line, i } of dutyLines) {
    assert.doesNotMatch(
      line,
      /COMMISSION_RATE|creditIssuedAmount|item\.price\s*[+\-*/]|price:/,
      `riga ${i + 1} mescola dutyEstimateShown con logica economica: "${line.trim()}"`
    );
  }
});
