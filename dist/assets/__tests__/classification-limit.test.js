// Verifica il limite di classificazioni gratuite nell'app turista (8
// ottobre 2026, vedi MANUALE.md, "Limite di classificazioni gratuite"):
// 5 in totale per dispositivo, poi banner "abbonati a Touchandgo-app o a
// Touchandgo-api" con percorso manuale. Stessa tecnica di
// offline-classify.test.js (app.js REALE in jsdom via vm.runInContext).
//
// Copre: il conteggio avanza solo con una classificazione riuscita; sotto la
// soglia tutto invariato; alla soglia compare il banner e NESSUNA chiamata AI
// parte; i tre percorsi del banner (abbonamento app, link api, manuale); un
// abbonato non ha limite; il percorso manuale usa i testi "limite" e segna
// provisionalReason "quota"; la riclassificazione in background non aggira
// il limite e riprende dopo l'abbonamento; localStorage guasto = nessun limite.
//
// Esecuzione: node --test (dalla root del repository)
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

const REAL_RESULT = {
  object_it: "Vaso",
  object_en: "Vase",
  hs_code: "691390",
  category: "Ceramica",
  weight_kg: 2,
  length_cm: 30,
  width_cm: 30,
  height_cm: 30,
  value_eur: 50,
  confidence: "alta",
};

function bootApp(t, { fetchMock, used } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  window.fetch =
    fetchMock ||
    ((url) => {
      calls.push(String(url));
      if (String(url).includes("/classify")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: [{ text: JSON.stringify(REAL_RESULT) }] }) });
      }
      return Promise.reject(new Error("not mocked: " + url));
    });
  window.localStorage.setItem("tg_lang", "it");
  window.localStorage.setItem("tg_onboarded", "1");
  if (used !== undefined) window.localStorage.setItem("tg_free_classifications", String(used));
  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });
  return { window, document: window.document, context, calls };
}

const setState = (context, patch) => vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context);
const getState = (context, expr) => vm.runInContext(`state.${expr}`, context);
const findButton = (document, text) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes(text));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const goToDestination = (context, window) => {
  setState(context, { pendingInput: { type: "text", label: "un vaso" }, isOffline: false, screen: "destination" });
  window.render();
};
const used = (window) => window.localStorage.getItem("tg_free_classifications");

test("una classificazione riuscita aumenta il contatore; l'errore no", async (t) => {
  const { window } = bootApp(t);
  await window.runClassification(Promise.resolve(REAL_RESULT));
  assert.equal(used(window), "1");
  await window.runClassification(Promise.reject(new Error("Request failed: 500")));
  assert.equal(used(window), "1", "un fallimento non consuma una classificazione gratuita");
});

test("sotto la soglia (4 usate): la classificazione parte normalmente, nessun banner", async (t) => {
  const { window, document, context, calls } = bootApp(t, { used: 4 });
  goToDestination(context, window);
  findButton(document, "Analizza e calcola il prezzo").click();
  await wait(30);
  assert.ok(calls.some((u) => u.includes("/classify")), "la chiamata AI deve partire");
  assert.equal(getState(context, "screen"), "result");
  assert.equal(used(window), "5");
});

test("alla soglia (5 usate): banner del limite, NESSUNA chiamata AI", async (t) => {
  const { window, document, context, calls } = bootApp(t, { used: 5 });
  goToDestination(context, window);
  findButton(document, "Analizza e calcola il prezzo").click();
  await wait(30);
  assert.equal(getState(context, "screen"), "classify-limit");
  assert.equal(calls.filter((u) => u.includes("/classify")).length, 0, "nessuna chiamata AI dopo il limite");
  const text = document.querySelector(".classify-limit-banner").textContent;
  assert.match(text, /5 classificazioni gratuite/);
  assert.match(text, /Touchandgo-app/);
  assert.match(text, /Touchandgo-api/);
});

test("banner: link a Touchandgo-api in nuova scheda e senza opener", async (t) => {
  const { window, document, context } = bootApp(t, { used: 5 });
  setState(context, { screen: "classify-limit" });
  window.render();
  const link = document.querySelector(".classify-limit-actions a");
  assert.equal(link.getAttribute("href"), "https://touchandgo-api.netlify.app");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(link.getAttribute("rel"), /noopener/);
});

test("banner: 'Abbonati a Touchandgo-app' imposta l'abbonamento e riporta alla destinazione; poi la classificazione parte", async (t) => {
  const { window, document, context, calls } = bootApp(t, { used: 5 });
  setState(context, { pendingInput: { type: "text", label: "un vaso" }, screen: "classify-limit" });
  window.render();
  findButton(document, "Abbonati a Touchandgo-app").click();
  assert.equal(getState(context, "isSubscribed"), true);
  assert.equal(getState(context, "screen"), "destination");
  findButton(document, "Analizza e calcola il prezzo").click();
  await wait(30);
  assert.ok(calls.some((u) => u.includes("/classify")), "da abbonato la classificazione non ha limite");
  assert.equal(used(window), "5", "l'abbonato non consuma il contatore gratuito");
});

test("un abbonato non incontra mai il banner, anche con contatore oltre la soglia", async (t) => {
  const { window, document, context } = bootApp(t, { used: 99 });
  setState(context, { isSubscribed: true });
  goToDestination(context, window);
  findButton(document, "Analizza e calcola il prezzo").click();
  await wait(30);
  assert.notEqual(getState(context, "screen"), "classify-limit");
});

test("percorso manuale dopo il limite: testi dedicati, risultato provvisorio, provisionalReason 'quota'", async (t) => {
  const { window, document, context } = bootApp(t, { used: 5 });
  setState(context, { pendingInput: { type: "text", label: "un vaso" }, screen: "classify-limit" });
  window.render();
  findButton(document, "Continua scegliendo la categoria a mano").click();
  assert.equal(getState(context, "screen"), "offline-classify");
  assert.equal(getState(context, "limitManualPath"), true);
  assert.match(document.querySelector(".offline-classify-banner").textContent, /classificazioni gratuite/);
  assert.doesNotMatch(document.querySelector(".offline-classify-banner").textContent, /offline/i);

  findButton(document, "Altro").click();
  assert.equal(getState(context, "screen"), "result");
  assert.equal(getState(context, "resultIsProvisional"), true);
  assert.match(document.querySelector(".offline-provisional-banner").textContent, /dopo l'abbonamento/);

  setState(context, {
    touristName: "Test",
    addresses: [{ id: "a1", label: "Casa", street: "Via Test 1", cap: "00100", city: "Roma", country: "Italia" }],
    selectedAddressId: "a1",
    screen: "choose-address",
  });
  window.render();
  findButton(document, "Conferma e genera QR").click();
  await wait(800);
  const items = getState(context, "pendingItems");
  assert.equal(items[0].pendingRealClassification, true);
  assert.equal(items[0].provisionalReason, "quota");
  assert.equal(getState(context, "limitManualPath"), false, "il flag si azzera dopo l'uso");
});

test("percorso offline normale: provisionalReason 'offline', testi invariati", async (t) => {
  const { window, document, context } = bootApp(t, { used: 0 });
  setState(context, { pendingInput: { type: "text", label: "x" }, isOffline: true, screen: "destination" });
  window.render();
  findButton(document, "Analizza e calcola il prezzo").click();
  assert.equal(getState(context, "screen"), "offline-classify");
  assert.equal(getState(context, "limitManualPath"), false);
  assert.match(document.querySelector(".offline-classify-banner").textContent, /Sei offline/);
});

test("riclassificazione in background: dopo il limite NON parte; da abbonato riprende e non consuma il contatore", async (t) => {
  const { window, context, calls } = bootApp(t, { used: 5 });
  const item = {
    id: "TG-Q1",
    objectName: "Altro",
    category: "Altro",
    provisionalCategory: "Altro",
    provisionalReason: "quota",
    pendingRealClassification: true,
    textDescription: "un vaso",
    pricingTier: "pieno",
    destinationZone: "Italia",
    price: 48,
    weightKg: 2,
    dims: { length_cm: 30, width_cm: 30, height_cm: 30 },
    itemValue: 0,
    status: "in sospeso",
    addressLabel: "Via Test 1, Roma, Italia",
    date: new Date().toISOString(),
  };
  setState(context, { pendingItems: [item], purchaseHistory: [Object.assign({}, item)] });
  await window.processPendingReclassifications();
  assert.equal(calls.filter((u) => u.includes("/classify")).length, 0, "nessuna classificazione AI di nascosto dopo il limite");
  assert.equal(getState(context, "pendingItems")[0].pendingRealClassification, true);

  setState(context, { isSubscribed: true });
  await window.processPendingReclassifications();
  assert.equal(calls.filter((u) => u.includes("/classify")).length, 1);
  assert.equal(getState(context, "pendingItems")[0].pendingRealClassification, false);
  assert.equal(used(window), "5");
});

test("riclassificazione di un item offline sotto la soglia: riuscita -> conta come uso gratuito", async (t) => {
  const { window, context } = bootApp(t, { used: 2 });
  const item = {
    id: "TG-O1", objectName: "Ceramica", category: "Ceramica", provisionalCategory: "Ceramica", provisionalReason: "offline",
    pendingRealClassification: true, textDescription: "un vaso", pricingTier: "pieno", destinationZone: "Italia", price: 48,
    weightKg: 2, dims: { length_cm: 30, width_cm: 30, height_cm: 30 }, itemValue: 0, status: "in sospeso",
    addressLabel: "Via Test 1, Roma, Italia", date: new Date().toISOString(),
  };
  setState(context, { pendingItems: [item], purchaseHistory: [Object.assign({}, item)] });
  await window.processPendingReclassifications();
  assert.equal(used(window), "3");
});

test("localStorage guasto: il limite non scatta e l'app non va in errore", async (t) => {
  const { window, context } = bootApp(t);
  vm.runInContext(
    `Object.defineProperty(window.localStorage.__proto__, "getItem", { value: function () { throw new Error("blocked"); }, configurable: true });`,
    context
  );
  assert.equal(vm.runInContext("classificationQuotaExhausted()", context), false);
  assert.equal(vm.runInContext("freeClassificationsUsed()", context), 0);
  await window.runClassification(Promise.resolve(REAL_RESULT));
  assert.equal(getState(context, "screen"), "result");
});

test("inglese: titolo e pulsanti del banner tradotti", async (t) => {
  const { window, document, context } = bootApp(t, { used: 5 });
  window.localStorage.setItem("tg_lang", "en");
  vm.runInContext(`state.lang = "en";`, context);
  setState(context, { screen: "classify-limit" });
  window.render();
  assert.match(document.querySelector(".classify-limit-banner").textContent, /free classifications/);
  assert.ok(findButton(document, "Subscribe to Touchandgo-app"));
});
