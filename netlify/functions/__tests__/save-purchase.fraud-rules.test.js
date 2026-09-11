// Verifica le sei nuove regole anti-frode (2-7) aggiunte in save-purchase.js
// accanto alla regola 1 preesistente ("Secondo acquisto senza abbonamento",
// vedi save-purchase.block-flag.test.js) — tutte scrivono su
// item.flaggedReasons (array), MAI un blocco: ogni test verifica anche che
// la risposta resti 200. Stesso fake minimale di @netlify/blobs già usato
// negli altri test di questa cartella (nessuna rete/credenziale reale
// necessaria). Esecuzione: node --test

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

let idCounter = 0;
function basePurchase(overrides) {
  idCounter += 1;
  return Object.assign(
    {
      id: "test-" + idCounter + "-" + Math.random().toString(36).slice(2),
      objectName: "Vaso",
      hsCode: "1234.56",
      weightKg: 1.2,
      dims: { l: 10, w: 10, h: 10 },
      itemValue: 50,
      pricingTier: "pieno",
      pickupPoint: "Roma",
      addressLabel: "Via Roma 1, Roma",
      price: 25,
      touristName: "Mario Rossi",
      touristEmail: "cliente@test.it",
      status: "in sospeso",
    },
    overrides
  );
}

beforeEach(() => {
  resetStores();
  idCounter = 0;
});

// ---------------------------------------------------------------------
// Regola 2: acquisti ravvicinati (entro un'ora, stessa email)
// ---------------------------------------------------------------------

test("regola 2: due acquisti della stessa email a pochi millisecondi di distanza -> flag su entrambi (200)", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const email = "ravvicinato@test.it";

  const first = basePurchase({ touristEmail: email });
  const res1 = await handler(makeEvent(first));
  assert.equal(res1.statusCode, 200);

  const second = basePurchase({ touristEmail: email });
  const res2 = await handler(makeEvent(second));
  assert.equal(res2.statusCode, 200, "mai un blocco, solo segnalazione");

  const savedSecond = await purchases.get(second.id, { type: "json" });
  assert.ok(savedSecond.flaggedReasons.includes("Più acquisti in meno di un'ora"));
});

test("regola 2: acquisti della stessa email ma con più di un'ora di distanza -> nessun flag", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const email = "distanziato@test.it";

  const first = basePurchase({ touristEmail: email });
  await handler(makeEvent(first));
  // Retrodata manualmente il purchasedAt del primo acquisto nello store
  // (già scritto dal server): simula che sia avvenuto più di un'ora fa,
  // senza dover far dormire il test per un'ora reale.
  const savedFirst = await purchases.get(first.id, { type: "json" });
  savedFirst.purchasedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await purchases.setJSON(first.id, savedFirst);

  const second = basePurchase({ touristEmail: email });
  await handler(makeEvent(second));
  const savedSecond = await purchases.get(second.id, { type: "json" });
  assert.ok(
    !savedSecond.flaggedReasons || !savedSecond.flaggedReasons.includes("Più acquisti in meno di un'ora"),
    "a più di un'ora di distanza non deve scattare"
  );
});

test("regola 2: acquisti ravvicinati ma di email diverse -> nessun flag", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");

  const first = basePurchase({ touristEmail: "a@test.it" });
  await handler(makeEvent(first));
  const second = basePurchase({ touristEmail: "b@test.it" });
  await handler(makeEvent(second));

  const savedSecond = await purchases.get(second.id, { type: "json" });
  assert.ok(!savedSecond.flaggedReasons || !savedSecond.flaggedReasons.includes("Più acquisti in meno di un'ora"));
});

// ---------------------------------------------------------------------
// Regole 3/6: valore/peso dichiarato anomalo per la categoria
// ---------------------------------------------------------------------

test("regola 3: valore >3x la media della categoria con campione sufficiente -> flag", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");

  // 5 acquisti "normali" nella categoria, media itemValue = 50.
  for (let i = 0; i < 5; i++) {
    await handler(makeEvent(basePurchase({ touristEmail: `base${i}@test.it`, category: "Elettronica", itemValue: 50 })));
  }

  const outlier = basePurchase({ touristEmail: "outlier@test.it", category: "Elettronica", itemValue: 500 });
  const res = await handler(makeEvent(outlier));
  assert.equal(res.statusCode, 200);

  const saved = await purchases.get(outlier.id, { type: "json" });
  assert.ok(saved.flaggedReasons.includes("Valore dichiarato anomalo per la categoria"));
});

test("regola 3: valore alto ma campione della categoria insufficiente (<5) -> nessun flag", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");

  // Solo 3 acquisti precedenti nella categoria: sotto la soglia minima.
  for (let i = 0; i < 3; i++) {
    await handler(makeEvent(basePurchase({ touristEmail: `base${i}@test.it`, category: "Arte", itemValue: 50 })));
  }

  const outlier = basePurchase({ touristEmail: "outlier2@test.it", category: "Arte", itemValue: 500 });
  await handler(makeEvent(outlier));
  const saved = await purchases.get(outlier.id, { type: "json" });
  assert.ok(
    !saved.flaggedReasons || !saved.flaggedReasons.includes("Valore dichiarato anomalo per la categoria"),
    "campione troppo piccolo: non deve mai scattare"
  );
});

test("regola 3: valore nella norma (entro 3x la media) -> nessun flag", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");

  for (let i = 0; i < 5; i++) {
    await handler(makeEvent(basePurchase({ touristEmail: `base${i}@test.it`, category: "Moda", itemValue: 50 })));
  }

  const normal = basePurchase({ touristEmail: "normale@test.it", category: "Moda", itemValue: 120 }); // 2.4x, sotto soglia
  await handler(makeEvent(normal));
  const saved = await purchases.get(normal.id, { type: "json" });
  assert.ok(!saved.flaggedReasons || !saved.flaggedReasons.includes("Valore dichiarato anomalo per la categoria"));
});

test("regola 6: peso >3x la media della categoria con campione sufficiente -> flag", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");

  for (let i = 0; i < 5; i++) {
    await handler(makeEvent(basePurchase({ touristEmail: `pesobase${i}@test.it`, category: "Ceramica", weightKg: 1 })));
  }

  const outlier = basePurchase({ touristEmail: "pesoutlier@test.it", category: "Ceramica", weightKg: 4.5 });
  const res = await handler(makeEvent(outlier));
  assert.equal(res.statusCode, 200);
  const saved = await purchases.get(outlier.id, { type: "json" });
  assert.ok(saved.flaggedReasons.includes("Peso dichiarato anomalo per la categoria"));
});

test("regola 6: campione della categoria insufficiente -> nessun flag anche con peso alto", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");

  for (let i = 0; i < 4; i++) {
    await handler(makeEvent(basePurchase({ touristEmail: `pesobase2${i}@test.it`, category: "Tessuti", weightKg: 1 })));
  }

  const outlier = basePurchase({ touristEmail: "pesoutlier2@test.it", category: "Tessuti", weightKg: 4.5 });
  await handler(makeEvent(outlier));
  const saved = await purchases.get(outlier.id, { type: "json" });
  assert.ok(!saved.flaggedReasons || !saved.flaggedReasons.includes("Peso dichiarato anomalo per la categoria"));
});

// ---------------------------------------------------------------------
// Regole 4/7: stesso indirizzo / stesso nome usato da email diverse
// ---------------------------------------------------------------------

test("regola 4: stesso addressLabel (match esatto) usato da un'altra email -> flag", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const address = "Via Condotti 5, Roma";

  const first = basePurchase({ touristEmail: "primo@test.it", addressLabel: address, touristName: "Anna" });
  await handler(makeEvent(first));

  const second = basePurchase({ touristEmail: "secondo@test.it", addressLabel: address, touristName: "Luca" });
  const res = await handler(makeEvent(second));
  assert.equal(res.statusCode, 200);
  const saved = await purchases.get(second.id, { type: "json" });
  assert.ok(saved.flaggedReasons.includes("Stesso indirizzo usato da più account"));
});

test("regola 4: stesso addressLabel ma stessa email (proprio storico) -> nessun flag da questa regola", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const address = "Via Condotti 5, Roma";
  const email = "stessocliente@test.it";

  await handler(makeEvent(basePurchase({ touristEmail: email, addressLabel: address, pricingTier: "abbonato" })));
  const second = basePurchase({ touristEmail: email, addressLabel: address, pricingTier: "abbonato" });
  await handler(makeEvent(second));
  const saved = await purchases.get(second.id, { type: "json" });
  assert.ok(!saved.flaggedReasons || !saved.flaggedReasons.includes("Stesso indirizzo usato da più account"));
});

test("regola 4: indirizzo simile ma non identico -> nessun flag (match esatto)", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");

  await handler(makeEvent(basePurchase({ touristEmail: "x@test.it", addressLabel: "Via Condotti 5, Roma" })));
  const second = basePurchase({ touristEmail: "y@test.it", addressLabel: "Via Condotti 5 , Roma" });
  await handler(makeEvent(second));
  const saved = await purchases.get(second.id, { type: "json" });
  assert.ok(!saved.flaggedReasons || !saved.flaggedReasons.includes("Stesso indirizzo usato da più account"));
});

test("regola 7: stesso touristName usato da un'altra email -> flag", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const name = "Giulia Bianchi";

  await handler(makeEvent(basePurchase({ touristEmail: "uno@test.it", touristName: name, addressLabel: "Indirizzo A" })));
  const second = basePurchase({ touristEmail: "due@test.it", touristName: name, addressLabel: "Indirizzo B" });
  const res = await handler(makeEvent(second));
  assert.equal(res.statusCode, 200);
  const saved = await purchases.get(second.id, { type: "json" });
  assert.ok(saved.flaggedReasons.includes("Stesso nome usato da più account"));
});

// ---------------------------------------------------------------------
// Regola 5: uso ripetuto di "breakeven"
// ---------------------------------------------------------------------

test("regola 5: seconda spedizione breakeven della stessa email -> flag", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const email = "breakeven@test.it";

  await handler(makeEvent(basePurchase({ touristEmail: email, pricingTier: "breakeven" })));
  const second = basePurchase({ touristEmail: email, pricingTier: "breakeven" });
  const res = await handler(makeEvent(second));
  assert.equal(res.statusCode, 200);
  const saved = await purchases.get(second.id, { type: "json" });
  assert.ok(saved.flaggedReasons.includes("Uso ripetuto di prezzo breakeven"));
});

test("regola 5: prima (e unica) spedizione breakeven -> nessun flag da questa regola", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const item = basePurchase({ touristEmail: "primavolta@test.it", pricingTier: "breakeven" });
  await handler(makeEvent(item));
  const saved = await purchases.get(item.id, { type: "json" });
  assert.ok(!saved.flaggedReasons || !saved.flaggedReasons.includes("Uso ripetuto di prezzo breakeven"));
});

test("regola 5: due acquisti pieno/abbonato (mai breakeven) -> nessun flag da questa regola", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const email = "maibreakeven@test.it";
  await handler(makeEvent(basePurchase({ touristEmail: email, pricingTier: "abbonato" })));
  const second = basePurchase({ touristEmail: email, pricingTier: "abbonato" });
  await handler(makeEvent(second));
  const saved = await purchases.get(second.id, { type: "json" });
  assert.ok(!saved.flaggedReasons || !saved.flaggedReasons.includes("Uso ripetuto di prezzo breakeven"));
});

// ---------------------------------------------------------------------
// Combinazione di più regole contemporaneamente, e mai un blocco
// ---------------------------------------------------------------------

test("un acquisto può attivare più regole insieme, tutte presenti nell'elenco, sempre 200", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const address = "Piazza Duomo 1, Milano";
  const name = "Sospetto Multiplo";
  const email = "multiplo@test.it";

  // Popola la categoria con un campione sufficiente per le regole statistiche.
  for (let i = 0; i < 5; i++) {
    await handler(
      makeEvent(basePurchase({ touristEmail: `pop${i}@test.it`, category: "Gioielli", itemValue: 40, weightKg: 0.5 }))
    );
  }
  // Un altro account usa già lo stesso indirizzo e lo stesso nome.
  await handler(
    makeEvent(basePurchase({ touristEmail: "altro@test.it", addressLabel: address, touristName: name, category: "Gioielli" }))
  );
  // Il cliente ha già un acquisto non abbonato in precedenza (regola 1) e sta
  // per farne un secondo, ravvicinato (regola 2), con valore/peso anomali
  // (regole 3/6) e stesso indirizzo/nome dell'altro account (regole 4/7).
  await handler(makeEvent(basePurchase({ touristEmail: email, pricingTier: "pieno", category: "Gioielli" })));

  const suspicious = basePurchase({
    touristEmail: email,
    pricingTier: "pieno",
    category: "Gioielli",
    itemValue: 500,
    weightKg: 5,
    addressLabel: address,
    touristName: name,
  });
  const res = await handler(makeEvent(suspicious));
  assert.equal(res.statusCode, 200, "nessuna regola deve mai bloccare il salvataggio, per quante se ne attivino");

  const saved = await purchases.get(suspicious.id, { type: "json" });
  const expected = [
    "Secondo acquisto senza abbonamento",
    "Più acquisti in meno di un'ora",
    "Valore dichiarato anomalo per la categoria",
    "Peso dichiarato anomalo per la categoria",
    "Stesso indirizzo usato da più account",
    "Stesso nome usato da più account",
  ];
  for (const reason of expected) {
    assert.ok(saved.flaggedReasons.includes(reason), `deve contenere: ${reason}`);
  }
  assert.equal(saved.flaggedReasons.length, expected.length, "nessuna regola in più/meno di quelle attese");
});

test("nessuna regola attivata -> flaggedReasons resta assente (comportamento invariato)", async () => {
  const handler = freshHandler();
  const purchases = fakeBlobsModule.getStore("purchases");
  const item = basePurchase({ touristEmail: "pulito@test.it" });
  const res = await handler(makeEvent(item));
  assert.equal(res.statusCode, 200);
  const saved = await purchases.get(item.id, { type: "json" });
  assert.equal(saved.flaggedReasons, undefined);
  assert.equal(saved.flaggedAt, undefined);
});

// ---------------------------------------------------------------------
// Retrocompatibilità: un record vecchio (flaggedReason stringa singola,
// mai risincronizzato dopo la modifica) non viene mai toccato.
// ---------------------------------------------------------------------

test("un record vecchio col vecchio formato (flaggedReason stringa) non viene mai riscritto se non risincronizzato", async () => {
  const purchases = fakeBlobsModule.getStore("purchases");
  const oldRecord = {
    id: "old-record-1",
    touristEmail: "vecchio@test.it",
    flaggedReason: "Secondo acquisto senza abbonamento",
    flaggedAt: "2026-01-01T00:00:00.000Z",
    status: "ritirato",
  };
  await purchases.setJSON(oldRecord.id, oldRecord);

  // Nessuna chiamata all'handler per questo id: il record resta esattamente
  // com'era, nel vecchio formato, leggibile senza errori.
  const stillThere = await purchases.get(oldRecord.id, { type: "json" });
  assert.deepEqual(stillThere, oldRecord);
});
