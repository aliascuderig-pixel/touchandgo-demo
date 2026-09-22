// Verifica consolidatedGroupPrice()/computeConcludeGroups() (dist/assets/
// app.js) — il calcolo del prezzo per una spedizione con PIÙ colli, prima
// di questa modifica privo di qualunque test dedicato (né qui né lato
// server, vedi netlify/functions/__tests__/create-checkout-session.test.js
// e netlify/lib/pricing.js — la stessa formula, duplicata lì, era coperta
// solo con dims:null, che rende il peso volumetrico sempre 0 e non
// esercita mai davvero il ramo Math.max(reale, volumetrico)).
//
// Regola verificata (già presente in consolidatedGroupPrice() prima di
// questa modifica — vedi MANUALE.md, sezione "Multicollo: peso tassabile
// per una spedizione con più colli"): peso reale combinato = somma dei
// pesi reali dei singoli colli (ciascuno mai sotto 0.3kg); peso
// volumetrico combinato = somma dei pesi volumetrici individuali (L×W×H
// in cm / 5000, stesso divisore standard corrieri già in uso per il
// singolo collo in volumetricWeight()); il peso fatturabile finale è il
// PIÙ ALTO tra i due totali — mai la somma, mai il minore.
//
// Stessa tecnica già usata in questo repository (vedi city-photo.test.js,
// status-timeline.test.js): app.js REALE caricato in una finestra jsdom
// isolata via vm.runInContext.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function bootApp(t) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error("network disabled in test"));
  window.localStorage.setItem("tg_lang", "it");

  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });

  return { window, context };
}

function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}
function callGlobal(context, expr) {
  return vm.runInContext(expr, context, { filename: "call-global.js" });
}

// Indirizzo di consegna (destinazione) — Italia, quindi zona "domestico"
// (brackets [[1,9],[2,11],[5,14],[10,18],[20,25],[30,33]], perKgOver 1.1,
// margine 25%, FULL_FEE 39€ per pricingTier "pieno"). Stesso identico
// oggetto usato dal codice reale in state.addresses — vedi
// destinationCountryForItem() in app.js, che consolidatedGroupPrice()
// chiama su items[0] per risolvere la zona tariffaria.
const ADDRESS = { id: "addr-1", label: "Casa — Via Roma 1, Milano 20100, Italia", street: "Via Roma 1", city: "Milano", cap: "20100", country: "Italia" };

function item(overrides) {
  return Object.assign(
    {
      id: "TG-000001",
      objectName: "Souvenir",
      pickupPoint: "Firenze centro",
      addressId: ADDRESS.id,
      addressLabel: ADDRESS.label,
      pricingTier: "pieno",
      weightKg: 1,
      dims: null,
    },
    overrides
  );
}

function seedAddress(context) {
  setState(context, { addresses: [ADDRESS] });
}

// ---------------------------------------------------------------------
// 1) Le tre casistiche esplicitamente richieste, con numeri ricalcolabili
//    a mano.
// ---------------------------------------------------------------------

test("consolidatedGroupPrice(): 2 colli, vince il peso REALE (nessun volume dichiarato) — 3kg + 4kg = 7kg fatturabili", (t) => {
  const { context } = bootApp(t);
  seedAddress(context);
  setState(context, {
    __t_items: [item({ id: "a", weightKg: 3, dims: null }), item({ id: "b", weightKg: 4, dims: null })],
  });
  const result = callGlobal(context, "consolidatedGroupPrice(state.__t_items)");

  // combinedReal = 3+4 = 7, combinedVolumetric = 0 -> billable = 7.
  // bracket domestico: 7 <= 10 -> 18€ grezzo; shipping = 18*1.25 = 22.5€;
  // fee piena 39€ -> totale 61.5€.
  assert.equal(result.weightKg, 7);
  assert.equal(result.shipping, 22.5);
  assert.equal(result.fee, 39);
  assert.equal(result.total, 61.5);
});

test("consolidatedGroupPrice(): 2 colli, vince il peso VOLUMETRICO (poco peso reale, molto volume) — 12.8kg + 5.4kg = 18.2kg fatturabili", (t) => {
  const { context } = bootApp(t);
  seedAddress(context);
  setState(context, {
    __t_items: [
      item({ id: "a", weightKg: 0.5, dims: { length_cm: 40, width_cm: 40, height_cm: 40 } }), // 64000/5000 = 12.8kg
      item({ id: "b", weightKg: 0.5, dims: { length_cm: 30, width_cm: 30, height_cm: 30 } }), // 27000/5000 = 5.4kg
    ],
  });
  const result = callGlobal(context, "consolidatedGroupPrice(state.__t_items)");

  // combinedReal = 0.5+0.5 = 1, combinedVolumetric = 12.8+5.4 = 18.2 ->
  // billable = 18.2 (il volumetrico vince nettamente). bracket domestico:
  // 18.2 <= 20 -> 25€ grezzo; shipping = 25*1.25 = 31.25€; fee 39€ ->
  // totale 70.25€.
  assert.equal(result.weightKg, 18.2);
  assert.equal(result.shipping, 31.25);
  assert.equal(result.fee, 39);
  assert.equal(result.total, 70.25);
});

test("consolidatedGroupPrice(): 2 colli, peso reale e volumetrico ESATTAMENTE uguali (5kg vs 5kg, al limite esatto di una fascia) — mai la somma (10kg), mai un valore diverso da 5", (t) => {
  const { context } = bootApp(t);
  seedAddress(context);
  setState(context, {
    __t_items: [
      item({ id: "a", weightKg: 2, dims: { length_cm: 25, width_cm: 20, height_cm: 20 } }), // 10000/5000 = 2kg volumetrico, reale 2kg
      item({ id: "b", weightKg: 3, dims: { length_cm: 25, width_cm: 30, height_cm: 20 } }), // 15000/5000 = 3kg volumetrico, reale 3kg
    ],
  });
  const result = callGlobal(context, "consolidatedGroupPrice(state.__t_items)");

  // combinedReal = 2+3 = 5, combinedVolumetric = 2+3 = 5 -> pareggio
  // esatto. billable DEVE restare 5 (il maggiore dei due, che qui
  // coincidono) — se il codice sommasse per errore i due totali invece di
  // prendere il maggiore, verrebbe 10 (fascia successiva, prezzo diverso):
  // questo test lo intercetterebbe. bracket domestico: 5 <= 5 -> 14€
  // grezzo (non la fascia successiva); shipping = 14*1.25 = 17.5€; fee
  // 39€ -> totale 56.5€.
  assert.equal(result.weightKg, 5);
  assert.equal(result.shipping, 17.5);
  assert.equal(result.fee, 39);
  assert.equal(result.total, 56.5);
});

// ---------------------------------------------------------------------
// 2) Nessuna regressione sul caso a collo singolo.
// ---------------------------------------------------------------------

test("consolidatedGroupPrice(): un gruppo di UN SOLO oggetto produce esattamente lo stesso prezzo di priceFor() per quell'oggetto — nessuna regressione sul caso più comune", (t) => {
  const { context } = bootApp(t);
  seedAddress(context);
  const solo = item({ id: "solo", weightKg: 1, dims: null });
  setState(context, { __t_items: [solo] });

  const group = callGlobal(context, "consolidatedGroupPrice(state.__t_items)");
  const solitary = callGlobal(context, `priceFor(${solo.weightKg}, "Italia", null)`);

  assert.equal(group.total, solitary.grandTotal);
  // 1kg reale, nessun volume: bracket domestico 1<=1 -> 9€ grezzo;
  // shipping 9*1.25 = 11.25€; fee piena 39€ -> 50.25€.
  assert.equal(group.total, 50.25);
});

test("shippingCost()/priceFor() per il caso a collo singolo restano invariati (nessuna modifica alla loro formula)", (t) => {
  const { context } = bootApp(t);
  const { shipping, eta } = callGlobal(context, `shippingCost(1, "Italia", null)`);
  assert.equal(shipping, 11.25);
  assert.equal(eta, "24–48 ore");
});

// ---------------------------------------------------------------------
// 3) I due casi di consolidamento multicollo esplicitamente richiesti.
// ---------------------------------------------------------------------

test("computeConcludeGroups(): CASO 1 — più colli dallo STESSO punto di ritiro, stessa destinazione -> UN solo gruppo consolidato", (t) => {
  const { context } = bootApp(t);
  seedAddress(context);
  setState(context, {
    pendingItems: [
      item({ id: "a", pickupPoint: "Firenze centro", weightKg: 3, dims: null }),
      item({ id: "b", pickupPoint: "Firenze centro", weightKg: 4, dims: null }),
    ],
  });
  const { itemsByDest, groups, groupPricing } = callGlobal(context, "computeConcludeGroups()");

  assert.equal(groups, 1, "stesso punto di ritiro e stessa destinazione -> un solo gruppo, non due");
  const [dest, items] = Object.entries(itemsByDest)[0];
  assert.equal(items.length, 2);
  // Stesso risultato del test "vince il peso reale" sopra (3kg+4kg=7kg).
  assert.equal(groupPricing[dest].total, 61.5);
});

test("computeConcludeGroups(): CASO 2 — più colli da punti di ritiro DIVERSI ma verso la stessa destinazione -> comunque UN solo gruppo consolidato (già solido, nessuna modifica necessaria)", (t) => {
  const { context } = bootApp(t);
  seedAddress(context);
  setState(context, {
    pendingItems: [
      item({ id: "a", pickupPoint: "Firenze centro", weightKg: 3, dims: null }),
      item({ id: "b", pickupPoint: "Roma nord", weightKg: 4, dims: null }),
    ],
  });
  const { itemsByDest, groups, groupPricing } = callGlobal(context, "computeConcludeGroups()");

  assert.equal(groups, 1, "punti di ritiro diversi ma stessa destinazione -> il consolidamento è comunque UN solo gruppo");
  const [dest, items] = Object.entries(itemsByDest)[0];
  // Array.from() qui riporta l'array del contesto vm isolato (realm
  // diverso da questo file) in un array nativo di questo realm — altrimenti
  // assert.deepEqual confronta anche i prototipi (Array.prototype dei due
  // realm, sempre diversi per costruzione) e fallisce anche a contenuto
  // identico, stesso quirk noto di vm.runInContext già documentato altrove
  // nei test di questo repository.
  assert.deepEqual(
    Array.from(items, (it) => it.pickupPoint).sort(),
    ["Firenze centro", "Roma nord"],
    "il gruppo include davvero colli da negozi diversi"
  );
  assert.equal(groupPricing[dest].total, 61.5);
});

test("computeConcludeGroups(): destinazioni diverse restano SEMPRE gruppi separati, anche con lo stesso punto di ritiro", (t) => {
  const { context } = bootApp(t);
  const OTHER_ADDRESS = { id: "addr-2", label: "Ufficio — Via Milano 5, Torino 10100, Italia", street: "Via Milano 5", city: "Torino", cap: "10100", country: "Italia" };
  setState(context, { addresses: [ADDRESS, OTHER_ADDRESS] });
  setState(context, {
    pendingItems: [
      item({ id: "a", pickupPoint: "Firenze centro", addressId: ADDRESS.id, addressLabel: ADDRESS.label, weightKg: 1, dims: null }),
      item({ id: "b", pickupPoint: "Firenze centro", addressId: OTHER_ADDRESS.id, addressLabel: OTHER_ADDRESS.label, weightKg: 1, dims: null }),
    ],
  });
  const { groups } = callGlobal(context, "computeConcludeGroups()");
  assert.equal(groups, 2, "destinazioni diverse non vengono mai consolidate insieme, indipendentemente dal punto di ritiro");
});
