// Verifica il percorso offline — classificazione provvisoria (settembre
// 2026, vedi MANUALE.md, sezione "Percorso offline"). Stessa tecnica di
// support-trail.test.js/real-country-city.test.js: app.js REALE caricato
// in una finestra jsdom isolata via vm.runInContext.
//
// Copre, in quest'ordine:
//   1. Offline: selezione categoria/sottocategoria -> arriva fino al QR.
//   2. Il prezzo provvisorio usa la cache locale, MAI una chiamata a
//      classify.js.
//   3. Senza cache mai scaricata: fallback ragionevole, nessun errore.
//   4. Riconciliazione al ritorno della connessione: classificazione
//      reale + prezzo ricalcolato, sincronizzato anche in purchaseHistory.
//   5. Una differenza di prezzo significativa genera una notifica
//      visibile; una differenza trascurabile no.
//   6. Il percorso online esistente resta invariato.
//
// Esecuzione: node --test (dalla root del repository)

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, "utf8");

function bootApp(t, { fetchMock } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = fetchMock || (() => Promise.reject(new Error("network disabled in test")));
  window.localStorage.setItem("tg_lang", "it");
  window.localStorage.setItem("tg_onboarded", "1");

  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });

  return { window, document: window.document, context };
}

function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}
function getState(context, expr) {
  return vm.runInContext(`state.${expr}`, context, { filename: "get-state.js" });
}
function evalInContext(context, expr) {
  return vm.runInContext(expr, context, { filename: "eval-expr.js" });
}

function findButtonByText(document, text) {
  return Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === text);
}
function findButtonContaining(document, partialText) {
  return Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes(partialText));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Traccia ogni chiamata fetch (url) e risponde in base al tipo di
// richiesta — classify() si aspetta {content:[{text:"<json>"}]},
// category-averages.js si aspetta {categories, computedAt}. Qualunque
// altra chiamata (sync queue, guest-status, ecc., innescate a ogni avvio
// dell'app) fallisce silenziosamente, comportamento già gestito dal
// codice reale ovunque.
function makeFetchMock({ classifyResult, categoryAverages } = {}) {
  const calls = [];
  const fetchMock = (url) => {
    calls.push(url);
    if (String(url).includes("/classify")) {
      if (!classifyResult) return Promise.reject(new Error("classify.js non mockato in questo test"));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: [{ text: JSON.stringify(classifyResult) }] }) });
    }
    if (String(url).includes("category-averages")) {
      if (!categoryAverages) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories: categoryAverages, computedAt: new Date().toISOString() }) });
    }
    return Promise.reject(new Error("not mocked: " + url));
  };
  return { calls, fetchMock };
}

const CACHED_CERAMICA = { weightKg: 2, dims: { length_cm: 30, width_cm: 30, height_cm: 30 } };

// ---------------------------------------------------------------------
// 1./2. Offline: categoria -> sottocategoria -> QR, usando la cache locale,
// mai una chiamata a classify.js.
// ---------------------------------------------------------------------

test("offline: selezione categoria/sottocategoria arriva fino al QR usando la cache locale, mai classify.js", async (t) => {
  const { calls, fetchMock } = makeFetchMock();
  const { window, document, context } = bootApp(t, { fetchMock });
  window.localStorage.setItem(
    "tg_category_averages_cache",
    JSON.stringify({ categories: { Ceramica: CACHED_CERAMICA }, cachedAt: Date.now() })
  );

  setState(context, {
    pendingInput: { type: "text", label: "un vaso" },
    isOffline: true,
    screen: "destination",
  });
  window.render();

  findButtonContaining(document, "Analizza e calcola il prezzo").click();
  assert.equal(getState(context, "screen"), "offline-classify");

  const categoryBtn = findButtonByText(document, "Ceramica");
  assert.ok(categoryBtn, "il bottone categoria 'Ceramica' deve esistere");
  categoryBtn.click();
  assert.equal(getState(context, "screen"), "offline-classify", "resta sulla stessa schermata per il passo sottocategoria");
  assert.equal(getState(context, "offlineClassifySelectedCategory"), "Ceramica");

  const subBtn = findButtonByText(document.querySelector("#app") ? document : document, "Ceramica da tavola");
  assert.ok(subBtn, "il bottone sottocategoria deve esistere");
  subBtn.click();

  assert.equal(getState(context, "screen"), "result");
  assert.equal(getState(context, "resultIsProvisional"), true);
  assert.equal(getState(context, "result.category"), "Ceramica");
  assert.equal(getState(context, "result.weight_kg"), 2, "deve usare il peso dalla cache, non un valore inventato");
  assert.equal(getState(context, "provisionalCategory"), "Ceramica");
  assert.equal(getState(context, "provisionalSubcategory"), "Ceramica da tavola");
  assert.ok(getState(context, "price.grandTotal") > 0);

  // Prosegue come il percorso normale fino al QR — stesso punto minimo di
  // stato già usato in support-trail.test.js per raggiungere "queued".
  setState(context, {
    touristName: "Turista Offline",
    addresses: [{ id: "addr-1", label: "Casa", street: "Via Test 1", cap: "00100", city: "Roma", country: "Italia" }],
    selectedAddressId: "addr-1",
    screen: "choose-address",
  });
  window.render();
  const confirmBtn = findButtonContaining(document, "Conferma e genera QR");
  assert.ok(confirmBtn, "deve arrivare fino al bottone di conferma QR");
  confirmBtn.click();
  await wait(800);

  assert.equal(getState(context, "screen"), "queued");
  const items = getState(context, "pendingItems");
  assert.equal(items.length, 1);
  assert.equal(items[0].pendingRealClassification, true);
  assert.equal(items[0].provisionalCategory, "Ceramica");
  assert.equal(items[0].provisionalSubcategory, "Ceramica da tavola");
  assert.equal(items[0].category, "Ceramica");
  assert.equal(items[0].weightKg, 2);

  // Punto 2: MAI una chiamata a classify.js in tutto questo percorso.
  assert.ok(!calls.some((u) => String(u).includes("/classify")), "nessuna chiamata a classify.js: il prezzo provvisorio viene solo dalla cache");
});

test("offline: categoria 'Altro' (senza sottocategorie) conferma subito, senza un passo intermedio", async (t) => {
  const { fetchMock } = makeFetchMock();
  const { window, document, context } = bootApp(t, { fetchMock });
  setState(context, { pendingInput: { type: "text", label: "boh" }, isOffline: true, screen: "offline-classify" });
  window.render();

  const altroBtn = findButtonByText(document, "Altro");
  assert.ok(altroBtn);
  altroBtn.click();

  assert.equal(getState(context, "screen"), "result", "'Altro' non ha sottocategorie: conferma subito");
  assert.equal(getState(context, "provisionalCategory"), "Altro");
  assert.equal(getState(context, "provisionalSubcategory"), null);
});

// ---------------------------------------------------------------------
// 3. Senza cache mai scaricata: fallback ragionevole, nessun errore.
// ---------------------------------------------------------------------

test("offline senza cache mai scaricata (localStorage vuoto): usa il fallback dichiarato, nessun errore che blocca il percorso", async (t) => {
  const { window, document, context } = bootApp(t); // nessun fetchMock: ogni fetch rifiutata, come sempre offline
  assert.equal(window.localStorage.getItem("tg_category_averages_cache"), null, "precondizione: nessuna cache mai salvata");

  setState(context, { pendingInput: { type: "image" }, isOffline: true, screen: "offline-classify" });
  window.render();

  const categoryBtn = findButtonByText(document, "Attrezzatura sportiva");
  assert.ok(categoryBtn);
  categoryBtn.click();
  const subBtn = findButtonByText(document, "Accessori fitness");
  assert.ok(subBtn);
  subBtn.click();

  assert.equal(getState(context, "screen"), "result", "nessun errore: il percorso prosegue comunque");
  assert.equal(getState(context, "error"), null);
  assert.equal(getState(context, "result.weight_kg"), 2.5, "deve usare esattamente il default dichiarato per 'Attrezzatura sportiva'");
  assert.ok(getState(context, "price.grandTotal") > 0, "un prezzo provvisorio plausibile deve comunque essere calcolato");
});

// ---------------------------------------------------------------------
// 4./5. Riconciliazione al ritorno della connessione.
// ---------------------------------------------------------------------

function provisionalItem(overrides) {
  return Object.assign(
    {
      id: "TG-OFF01",
      objectName: "Ceramica",
      category: "Ceramica",
      provisionalCategory: "Ceramica",
      provisionalSubcategory: null,
      pendingRealClassification: true,
      textDescription: "un vaso di ceramica",
      pricingTier: "pieno",
      destinationZone: "Italia",
      price: 48,
      weightKg: 2,
      dims: { length_cm: 30, width_cm: 30, height_cm: 30 },
      itemValue: 0,
      status: "in sospeso",
      addressLabel: "Via Test 1, Roma, Italia",
      touristEmail: null,
      date: new Date().toISOString(),
    },
    overrides
  );
}

test("riconciliazione: un item pendingRealClassification viene classificato e il prezzo ricalcolato, sincronizzato anche in purchaseHistory", async (t) => {
  const classifyResult = {
    object_it: "Vaso in ceramica dipinta",
    object_en: "Painted ceramic vase",
    hs_code: "691390",
    hs_description_it: "Vasellame ceramico",
    hs_description_en: "Ceramic ware",
    category: "Ceramica",
    material: "ceramica",
    weight_kg: 9,
    length_cm: 45,
    width_cm: 45,
    height_cm: 45,
    value_eur: 120,
    fragile: true,
    made_in_italy: true,
    confidence: "alta",
    shipping_note_it: "",
    shipping_note_en: "",
  };
  const { calls, fetchMock } = makeFetchMock({ classifyResult });
  const { window, context } = bootApp(t, { fetchMock });

  const pending = provisionalItem();
  // Copia INDIPENDENTE in purchaseHistory (stesso scenario reale dopo un
  // giro di save/load da localStorage — vedi finalizeShippedGroups() per
  // lo stesso pattern già in uso altrove in questo file).
  const historyCopy = Object.assign({}, pending);
  setState(context, { pendingItems: [pending], purchaseHistory: [historyCopy] });

  await window.processPendingReclassifications();
  await wait(20);

  const items = getState(context, "pendingItems");
  const history = getState(context, "purchaseHistory");
  assert.equal(items[0].pendingRealClassification, false);
  assert.equal(items[0].weightKg, 9, "il peso reale deve sostituire quello provvisorio");
  assert.equal(items[0].itemValue, 120);
  assert.ok(items[0].reclassifiedAt);
  assert.notEqual(items[0].price, 48, "il prezzo deve essere ricalcolato sul peso reale");

  assert.equal(history[0].pendingRealClassification, false, "la voce indipendente in purchaseHistory deve essere aggiornata anch'essa");
  assert.equal(history[0].weightKg, 9);
  assert.equal(history[0].price, items[0].price);

  assert.ok(calls.some((u) => String(u).includes("/classify")), "deve aver chiamato classify.js per la classificazione reale");
  assert.ok(calls.some((u) => String(u).includes("save-purchase")), "deve risincronizzare il record aggiornato col CRM");
});

test("riconciliazione: differenza di prezzo significativa genera una notifica visibile (mai silenziosa)", async (t) => {
  const classifyResult = {
    object_it: "Statua in ceramica grande",
    object_en: "Large ceramic statue",
    hs_code: "691390",
    hs_description_it: "",
    hs_description_en: "",
    category: "Ceramica",
    material: "ceramica",
    weight_kg: 15, // molto più del provvisorio (2kg) -> prezzo molto più alto
    length_cm: 60,
    width_cm: 60,
    height_cm: 60,
    value_eur: 300,
    fragile: true,
    made_in_italy: true,
    confidence: "alta",
    shipping_note_it: "",
    shipping_note_en: "",
  };
  const { fetchMock } = makeFetchMock({ classifyResult });
  const { window, context } = bootApp(t, { fetchMock });
  setState(context, { pendingItems: [provisionalItem()], purchaseHistory: [] });

  await window.processPendingReclassifications();
  await wait(20);

  const item = getState(context, "pendingItems")[0];
  assert.ok(item.priceReconciliationNotice, "una differenza di prezzo così ampia deve generare una notifica");
  assert.equal(item.priceReconciliationNotice.oldPrice, 48);
  assert.equal(item.priceReconciliationNotice.newPrice, item.price);
});

test("riconciliazione: differenza di prezzo trascurabile NON genera notifica", async (t) => {
  // Stesso peso/dimensioni della cache già usata per costruire il
  // provvisorio: il prezzo reale deve risultare (quasi) identico.
  const classifyResult = {
    object_it: "Vaso",
    object_en: "Vase",
    hs_code: "691390",
    hs_description_it: "",
    hs_description_en: "",
    category: "Ceramica",
    material: "ceramica",
    weight_kg: 2,
    length_cm: 30,
    width_cm: 30,
    height_cm: 30,
    value_eur: 45,
    fragile: false,
    made_in_italy: true,
    confidence: "alta",
    shipping_note_it: "",
    shipping_note_en: "",
  };
  const { fetchMock } = makeFetchMock({ classifyResult });
  const { window, context } = bootApp(t, { fetchMock });
  // Prezzo iniziale calcolato con la STESSA formula del codice reale per
  // peso/dimensioni/destinazione/tier identici a classifyResult sopra —
  // non un valore a caso: qui si vuole isolare esplicitamente "peso/dims
  // invariati -> prezzo (quasi) invariato", non un caso in cui il prezzo
  // iniziale del test è semplicemente sbagliato rispetto alla formula.
  const samePrice = evalInContext(
    context,
    `priceQuotes(2, "Italia", { length_cm: 30, width_cm: 30, height_cm: 30 }).full`
  );
  setState(context, { pendingItems: [provisionalItem({ price: samePrice })], purchaseHistory: [] });

  await window.processPendingReclassifications();
  await wait(20);

  const item = getState(context, "pendingItems")[0];
  assert.equal(item.pendingRealClassification, false, "deve comunque considerarsi riconciliato");
  assert.ok(!item.priceReconciliationNotice, "nessuna notifica per uno scostamento trascurabile");
});

test("riconciliazione: nessun item pendingRealClassification -> nessuna chiamata, nessun crash", async (t) => {
  const { calls, fetchMock } = makeFetchMock();
  const { window, context } = bootApp(t, { fetchMock });
  setState(context, { pendingItems: [{ id: "TG-NORMAL", pendingRealClassification: false, price: 40 }], purchaseHistory: [] });

  await window.processPendingReclassifications();
  assert.ok(!calls.some((u) => String(u).includes("/classify")), "nessun item da riconciliare: nessuna chiamata a classify.js");
});

// ---------------------------------------------------------------------
// 6. Il percorso online esistente resta invariato.
// ---------------------------------------------------------------------

test("percorso online: una classificazione reale riuscita imposta resultIsProvisional a false, comportamento invariato", async (t) => {
  const { window, context } = bootApp(t);
  const realResult = {
    object_it: "Borsa",
    object_en: "Bag",
    hs_code: "420221",
    category: "Accessori Moda",
    weight_kg: 1.2,
    length_cm: 30,
    width_cm: 20,
    height_cm: 15,
    value_eur: 90,
    confidence: "alta",
  };
  await window.runClassification(Promise.resolve(realResult));

  assert.equal(getState(context, "screen"), "result");
  assert.equal(getState(context, "resultIsProvisional"), false);
  assert.equal(getState(context, "result.category"), "Accessori Moda");
});

test("percorso online: un errore non di rete (es. 401) resta un vero errore, non passa al percorso offline", async (t) => {
  const { window, context } = bootApp(t);
  await window.runClassification(Promise.reject(new Error("Request failed: 401 unauthorized")));

  assert.equal(getState(context, "screen"), "destination", "un vero errore riporta a destination, non al percorso offline");
  assert.ok(getState(context, "error"), "state.error deve essere valorizzato per un errore reale");
  assert.notEqual(getState(context, "screen"), "offline-classify");
});
