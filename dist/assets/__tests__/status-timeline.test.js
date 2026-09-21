// Verifica la timeline visiva dello stato spedizione (StatusTimeline() in
// dist/assets/app.js, settembre 2026) — sostituisce il vecchio badge di
// solo testo su HistoryScreen()/PurchaseHistoryList() e su DashboardScreen().
// Copre:
//   1) I 4 stati reali (in sospeso/in confezionamento/ritiro richiesto/
//      ritirato) producono sempre lo step corrente corretto, con passato
//      (già avvenuto) e futuro (deve ancora avvenire) distinti solo dal
//      pallino pieno/vuoto, mai dal colore (vedi CSS, .status-step-past
//      non ha una classe colore diversa da .status-step-future).
//   2) Ogni label ha Touch&Go come soggetto attivo — MAI il corriere
//      partner (DHL/FedEx/GLS) come protagonista, vincolo di brand non
//      negoziabile.
//   3) Un dato legacy/sconosciuto ricade sul primo step corrente, stesso
//      comportamento di historyStatusClass().
//   4) Il vecchio badge .history-status non compare più nella vista del
//      turista (HistoryScreen/DashboardScreen) — resta solo nella vista
//      partner (fuori scope di questa modifica, invariata).
//
// Stessa tecnica già usata in questo repository (vedi city-photo.test.js):
// app.js REALE caricato in una finestra jsdom isolata via vm.runInContext.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

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
function callGlobal(context, expr) {
  return vm.runInContext(expr, context, { filename: "call-global.js" });
}

function historyItem(overrides) {
  return Object.assign(
    {
      id: "TG-TL001",
      objectName: "Vaso in ceramica",
      pickupPoint: "Firenze centro",
      addressLabel: "Casa — Via Test 1, Roma 00100, Italia",
      hsCode: "691200",
      touristName: "Turista Test",
      price: 20,
      itemValue: 40,
      status: "in sospeso",
      date: new Date().toISOString(),
    },
    overrides
  );
}

const STATUS_ORDER = ["in sospeso", "in confezionamento", "ritiro richiesto", "ritirato"];
const COURIER_WORDS = /\b(DHL|FedEx|GLS|corriere)\b/i;

// ---------------------------------------------------------------------
// 1) I 4 stati reali -> step corrente corretto, passato/futuro coerenti.
// ---------------------------------------------------------------------

for (let i = 0; i < STATUS_ORDER.length; i++) {
  const status = STATUS_ORDER[i];
  test(`StatusTimeline: stato "${status}" -> step corrente #${i}, ${i} passati, ${3 - i} futuri`, (t) => {
    const { document, context } = bootApp(t);
    setState(context, { purchaseHistory: [historyItem({ status })], screen: "history" });
    callGlobal(context, "render()");

    const timeline = document.querySelector(".status-timeline");
    assert.ok(timeline, "la timeline deve essere renderizzata");
    assert.equal(timeline.dataset.status, status);

    const steps = Array.from(timeline.querySelectorAll(".status-step"));
    assert.equal(steps.length, 4);

    const current = timeline.querySelectorAll(".status-step-current");
    assert.equal(current.length, 1, "esattamente uno step corrente");
    assert.equal(steps.indexOf(current[0]), i, "lo step corrente deve corrispondere all'indice dello stato reale");

    const past = timeline.querySelectorAll(".status-step-past");
    assert.equal(past.length, i);
    const future = timeline.querySelectorAll(".status-step-future");
    assert.equal(future.length, 3 - i);
  });
}

// ---------------------------------------------------------------------
// 2) Touch&Go come soggetto attivo, mai il corriere come protagonista.
// ---------------------------------------------------------------------

test("StatusTimeline: ogni label ha Touch&Go come soggetto, nessuna menziona il corriere partner", (t) => {
  const { document, context } = bootApp(t);
  setState(context, { purchaseHistory: [historyItem({ status: "in confezionamento" })], screen: "history" });
  callGlobal(context, "render()");

  const labels = Array.from(document.querySelectorAll(".status-step-label")).map((el) => el.textContent);
  assert.equal(labels.length, 4);
  labels.forEach((label) => {
    assert.match(label, /^Touch&Go /, `la label "${label}" deve iniziare con Touch&Go come soggetto attivo`);
    assert.doesNotMatch(label, COURIER_WORDS, `la label "${label}" non deve mai nominare il corriere come protagonista`);
  });
});

// ---------------------------------------------------------------------
// 3) Stato legacy/sconosciuto -> ricade sul primo step, come
//    historyStatusClass().
// ---------------------------------------------------------------------

test("StatusTimeline: uno stato sconosciuto/legacy ricade sul primo step come corrente (stesso fallback di historyStatusClass)", (t) => {
  const { document, context } = bootApp(t);
  setState(context, { purchaseHistory: [historyItem({ status: "stato-mai-esistito" })], screen: "history" });
  callGlobal(context, "render()");

  const timeline = document.querySelector(".status-timeline");
  const current = timeline.querySelectorAll(".status-step-current");
  assert.equal(current.length, 1);
  assert.equal(Array.from(timeline.querySelectorAll(".status-step")).indexOf(current[0]), 0);
});

// ---------------------------------------------------------------------
// 4) Il vecchio badge .history-status non compare più nella vista turista.
// ---------------------------------------------------------------------

test("HistoryScreen: il vecchio badge .history-status non compare più, sostituito dalla timeline", (t) => {
  const { document, context } = bootApp(t);
  setState(context, { purchaseHistory: [historyItem({ status: "ritirato" })], screen: "history" });
  callGlobal(context, "render()");

  assert.equal(document.querySelector(".history-status"), null);
  assert.ok(document.querySelector(".status-timeline"));
});

test("DashboardScreen: la timeline compare per ogni acquisto, il vecchio badge no", (t) => {
  const { document, context } = bootApp(t);
  setState(context, {
    purchaseHistory: [historyItem({ id: "a", status: "in sospeso" }), historyItem({ id: "b", status: "ritirato" })],
    screen: "dashboard",
  });
  callGlobal(context, "render()");

  assert.equal(document.querySelector(".history-status"), null);
  assert.equal(document.querySelectorAll(".status-timeline").length, 2);
});
