// Verifica netlify/functions/weekly-e2e-test.js: logica di orchestrazione
// e controlli di business, con fetch e store Netlify Blobs finti — nessuna
// chiamata di rete reale, nessuna chiamata AI reale, nessuna credenziale.
//
// Copre in particolare, come richiesto:
//   - il caso "tutto ok" (pipeline completa: 2 classificazioni, 2 acquisti,
//     1 gruppo, verifica di lettura, controllo prezzo consolidato <= somma);
//   - che OGNI URL chiamato dalla pipeline punti allo spazio ospite, mai a
//     produzione (verifica diretta, non solo lettura del codice);
//   - lo spazio ospite (GUEST_MODE=true) che si ferma subito, zero fetch;
//   - il controllo di business "prezzo consolidato > somma individuali":
//     dimostrato che viene rilevato e segnalato (status "problem", non
//     ignorato), con un test diretto sulla funzione pura che lo implementa
//     (checkConsolidatedNotGreaterThanSum) — lo stesso identico controllo
//     che runWeeklyE2ETest() richiama nel passo "priceSanityCheck" (vedi
//     anche il test "tutto ok", che verifica che quel passo sia davvero
//     presente con status "ok" nella pipeline reale).

const { test, beforeEach, afterEach } = require("node:test");
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
      async delete(key) {
        store.delete(key);
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

const modulePath = path.join(__dirname, "..", "weekly-e2e-test.js");
function freshModule() {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  resetStores();
  process.env.NETLIFY_BLOBS_SITE_ID = "test-site";
  process.env.NETLIFY_BLOBS_TOKEN = "test-token";
  delete process.env.GUEST_MODE;
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

function classifyResponse(obj) {
  return { status: 200, json: async () => ({ content: [{ text: JSON.stringify(obj) }] }) };
}
function okJsonResponse(body) {
  return { status: 200, json: async () => body || { ok: true } };
}

const CLASSIFICATION_1 = {
  object_it: "Statuetta in legno intagliato",
  hs_code: "442090",
  category: "Artigianato",
  material: "legno",
  weight_kg: 0.6,
  length_cm: 15,
  width_cm: 12,
  height_cm: 10,
  value_eur: 25,
};
const CLASSIFICATION_2 = {
  object_it: "Sciarpa di seta dipinta a mano",
  hs_code: "621420",
  category: "Accessori Moda",
  material: "seta",
  weight_kg: 0.2,
  length_cm: 30,
  width_cm: 20,
  height_cm: 3,
  value_eur: 40,
};

// Simula, quando il test lo richiede, che i tre salvataggi (2 acquisti + 1
// gruppo) siano davvero avvenuti sul lato ospite: scrive direttamente negli
// store finti "purchases-guest"/"shipment-groups-guest" — la stessa cosa
// che, in produzione, farebbero save-purchase.js/save-shipment-group.js
// reali eseguiti sul deploy ospite (qui sostituiti dal fetch finto sotto,
// che restituisce solo {ok:true} senza toccare alcuno store).
function seedGuestStoresFromSavedRequests(calls) {
  const purchases = fakeBlobsModule.getStore("purchases-guest");
  const shipmentGroups = fakeBlobsModule.getStore("shipment-groups-guest");
  calls.forEach(({ url, body }) => {
    if (url.includes("save-purchase")) purchases.setJSON(body.id, body);
    if (url.includes("save-shipment-group")) shipmentGroups.setJSON(body.code, body);
  });
}

test("caso tutto ok: pipeline completa, overallStatus ok, priceSanityCheck ok, verifica di lettura ok", async () => {
  const callLog = [];
  const mod = freshModule();

  // Esegue la pipeline UNA VOLTA, cattura le richieste di salvataggio, poi
  // "materializza" quei salvataggi negli store finti prima che la funzione
  // arrivi al passo 5 (verifica di lettura) — non possiamo farlo prima di
  // conoscere gli id generati a runtime (randomSuffix()), quindi il fetch
  // finto per save-purchase/save-shipment-group scrive negli store finti
  // nello stesso momento in cui "risponde" 200, esattamente come farebbe
  // la function reale sul lato ospite.
  global.fetch = async (url, options) => {
    callLog.push({ url });
    const body = options && options.body ? JSON.parse(options.body) : {};
    if (url.includes(".netlify/functions/classify")) {
      // "sciarpa" è univoco per LABEL_2: "legno" invece compare SEMPRE
      // (anche per LABEL_1) perché è uno degli esempi elencati dentro
      // CLASSIFY_SCHEMA stesso, appeso in fondo a ogni prompt — non un
      // discriminante valido.
      const label = body.messages[0].content;
      return classifyResponse(label.includes("sciarpa") ? CLASSIFICATION_2 : CLASSIFICATION_1);
    }
    if (url.includes(".netlify/functions/save-purchase")) {
      fakeBlobsModule.getStore("purchases-guest").setJSON(body.id, body);
      return okJsonResponse({ ok: true });
    }
    if (url.includes(".netlify/functions/save-shipment-group")) {
      fakeBlobsModule.getStore("shipment-groups-guest").setJSON(body.code, body);
      return okJsonResponse({ ok: true });
    }
    throw new Error(`URL non atteso nel test: ${url}`);
  };

  const report = await mod.runWeeklyE2ETest();

  assert.equal(report.overallStatus, "ok");
  assert.equal(report.steps.classifyItem1.status, "ok");
  assert.equal(report.steps.classifyItem2.status, "ok");
  assert.equal(report.steps.savePurchase1.status, "ok");
  assert.equal(report.steps.savePurchase2.status, "ok");
  assert.equal(report.steps.saveShipmentGroup.status, "ok");
  assert.equal(report.steps.verifyPurchasesSaved.status, "ok");
  assert.equal(report.steps.verifyPurchasesSaved.item1Found, true);
  assert.equal(report.steps.verifyPurchasesSaved.item2Found, true);
  assert.equal(report.steps.verifyShipmentGroupSaved.status, "ok");
  assert.equal(report.steps.verifyShipmentGroupSaved.found, true);
  assert.equal(report.steps.priceSanityCheck.status, "ok");
  assert.ok(
    report.steps.priceSanityCheck.consolidatedTotal <= report.steps.priceSanityCheck.individualSum,
    "il prezzo consolidato deve essere <= alla somma dei due prezzi individuali"
  );
  assert.ok(report.generatedIds.purchase1Id && report.generatedIds.purchase2Id && report.generatedIds.groupCode);
  assert.equal(report.withinTimeBudget, true);

  // Vincolo critico: OGNI URL chiamato deve puntare allo spazio ospite.
  assert.ok(callLog.length >= 5, "ci si aspettano almeno 5 chiamate (2 classify, 2 save-purchase, 1 save-shipment-group)");
  for (const { url } of callLog) {
    assert.ok(url.startsWith(mod.GUEST_BASE_URL), `URL fuori dallo spazio ospite: ${url}`);
    assert.ok(!url.startsWith(mod.KNOWN_PRODUCTION_URL), `URL punta a produzione: ${url}`);
  }

  // Il report deve essere stato salvato nello store "weekly-e2e-reports"
  // (non guest-scoped: questa esecuzione gira su produzione).
  const savedReport = await fakeBlobsModule.getStore("weekly-e2e-reports").get(report.date, { type: "json" });
  assert.ok(savedReport, "il report deve essere stato salvato nello store");
  assert.equal(JSON.parse(await fakeBlobsModule.getStore("weekly-e2e-reports").get(report.date)).overallStatus, "ok");
});

test("spazio ospite (GUEST_MODE=true): si ferma subito, zero chiamate di rete", async () => {
  process.env.GUEST_MODE = "true";
  global.fetch = async () => {
    throw new Error("fetch non doveva essere chiamato in guest mode");
  };
  const mod = freshModule();
  const result = await mod.runWeeklyE2ETest();
  assert.deepEqual(result, { skipped: true, reason: "guest_mode" });
});

test("un fallimento nella prima classificazione interrompe i passi dipendenti, ma il report viene comunque salvato (parziale)", async () => {
  global.fetch = async (url, options) => {
    if (url.includes(".netlify/functions/classify")) {
      const body = JSON.parse(options.body);
      // "sciarpa" è univoco per LABEL_2 (vedi commento nel test "tutto
      // ok" sopra: "legno" compare sempre, anche per LABEL_1, perché è un
      // esempio dentro CLASSIFY_SCHEMA). Qui si fa fallire deliberatamente
      // solo la chiamata per LABEL_1 (quella NON di "sciarpa").
      if (!body.messages[0].content.includes("sciarpa")) {
        throw new Error("rete giù per il primo oggetto");
      }
      return classifyResponse(CLASSIFICATION_2);
    }
    throw new Error(`URL non atteso: ${url} (non si dovrebbe arrivare a salvare nulla)`);
  };
  const mod = freshModule();
  const report = await mod.runWeeklyE2ETest();

  assert.equal(report.overallStatus, "problem");
  assert.equal(report.steps.classifyItem1.status, "problem");
  assert.match(report.steps.classifyItem1.error, /rete giù/);
  assert.equal(report.steps.classifyItem2.status, "ok");
  assert.equal(report.steps.savePurchase1.status, "skipped");
  assert.equal(report.steps.saveShipmentGroup.status, "skipped");

  const savedReport = await fakeBlobsModule.getStore("weekly-e2e-reports").get(report.date, { type: "json" });
  assert.ok(savedReport, "anche un esito parziale deve essere salvato, non perso");
});

test("verifica di lettura fallisce se l'acquisto non risulta davvero nello store dopo il salvataggio (200 non basta)", async () => {
  // save-purchase risponde sempre 200, ma NON scrive nulla nello store
  // finto — simula un bug ipotetico in cui la function ospite conferma il
  // salvataggio senza che il dato sia davvero recuperabile.
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes(".netlify/functions/classify")) {
      return classifyResponse(body.messages[0].content.includes("sciarpa") ? CLASSIFICATION_2 : CLASSIFICATION_1);
    }
    if (url.includes(".netlify/functions/save-purchase")) return okJsonResponse({ ok: true });
    if (url.includes(".netlify/functions/save-shipment-group")) return okJsonResponse({ ok: true });
    throw new Error(`URL non atteso: ${url}`);
  };
  const mod = freshModule();
  const report = await mod.runWeeklyE2ETest();

  assert.equal(report.overallStatus, "problem");
  assert.equal(report.steps.savePurchase1.status, "ok", "il salvataggio HTTP risulta comunque riuscito (200)");
  assert.equal(report.steps.verifyPurchasesSaved.status, "problem", "ma la verifica di lettura deve rilevare che il dato non c'è");
  assert.equal(report.steps.verifyPurchasesSaved.item1Found, false);
  assert.equal(report.steps.verifyPurchasesSaved.item2Found, false);
});

test("checkConsolidatedNotGreaterThanSum: caso normale (consolidato <= somma) -> ok", () => {
  const mod = freshModule();
  const result = mod.checkConsolidatedNotGreaterThanSum([50, 45], 70);
  assert.equal(result.status, "ok");
  assert.equal(result.individualSum, 95);
  assert.equal(result.consolidatedTotal, 70);
});

test("checkConsolidatedNotGreaterThanSum: prezzo consolidato MAGGIORE della somma -> rilevato e segnalato, non ignorato", () => {
  const mod = freshModule();
  const result = mod.checkConsolidatedNotGreaterThanSum([10, 10], 25);
  assert.equal(result.status, "problem", "un consolidato (25) maggiore della somma (20) deve essere segnalato come problema");
  assert.equal(result.individualSum, 20);
  assert.equal(result.consolidatedTotal, 25);
  assert.match(result.error, /MAGGIORE della somma/);
});

test("checkConsolidatedNotGreaterThanSum: tolleranza di 1 centesimo per arrotondamenti, non oltre", () => {
  const mod = freshModule();
  const okCase = mod.checkConsolidatedNotGreaterThanSum([10, 10], 20.01);
  assert.equal(okCase.status, "ok", "1 centesimo di scarto è tollerato (arrotondamento)");
  const badCase = mod.checkConsolidatedNotGreaterThanSum([10, 10], 20.02);
  assert.equal(badCase.status, "problem", "2 centesimi di scarto non sono più tollerati");
});

test("computeConsolidatedPrice di un gruppo di un solo oggetto coincide con computeIndividualPrice dello stesso oggetto", () => {
  // Stessa proprietà richiamata nel commento di consolidatedGroupPrice() in
  // app.js: nessuna regressione sul caso più comune (un solo acquisto).
  const mod = freshModule();
  const item = { weightKg: 1.4, dims: { length_cm: 20, width_cm: 15, height_cm: 10 } };
  const individual = mod.computeIndividualPrice(item.weightKg, item.dims);
  const consolidated = mod.computeConsolidatedPrice([item]);
  assert.equal(consolidated.total, individual);
});

test("GUEST_BASE_URL punta davvero allo spazio ospite e mai al dominio di produzione", () => {
  const mod = freshModule();
  assert.ok(mod.GUEST_BASE_URL.includes("touchandgo-guest.netlify.app"));
  assert.notEqual(mod.GUEST_BASE_URL, mod.KNOWN_PRODUCTION_URL);
});
