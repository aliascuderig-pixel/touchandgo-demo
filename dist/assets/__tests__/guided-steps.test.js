// Flusso a step guidati: interruttore spento di default, «Da sapere», piano, riepilogo con Modifica.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function boot(t, { guided, patch = "" } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  dom.window.localStorage.setItem("tg_onboarded", "1");
  if (guided) dom.window.localStorage.setItem("tg_guided_flow", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, {mode:"turista", screen:"result", pickupPoint:"Catania", guestDestinationCountry:"Francia",
    result:{object_it:"Vaso", weight_kg:1.2, length_cm:20, width_cm:10, height_cm:10, hs_code:"6913.10", confidence:"alta", value_eur:50},
    purchaseHistory:[{}], isSubscribed:false,
    price:{grandTotal:20, eta:"3-5 giorni", quotes:{full:20, breakeven:10, subscribed:15, shipping:15, eta:"3-5 giorni"}}}); ${patch}`, ctx);
  const call = (e) => vm.runInContext(e, ctx);
  call("render()");
  return { d: dom.window.document, call, window: dom.window };
}

test("interruttore spento: il Risultato resta quello di sempre (prezzo dentro, nessun «Da sapere»)", (t) => {
  const { d } = boot(t);
  assert.ok(d.querySelector(".price-dual"), "scelta del piano ancora nel Risultato");
  assert.equal(d.querySelector(".step-more"), null);
});

test("interruttore acceso: Risultato pulito, avvisi in «Da sapere» chiuso, nessun prezzo", (t) => {
  const { d } = boot(t, { guided: true });
  assert.ok(d.querySelector(".result-card"));
  const more = d.querySelector("details.step-more");
  assert.ok(more && !more.open);
  assert.equal(d.querySelector(".price-dual"), null);
  assert.equal(d.querySelector(".price-card"), null);
});

test("Continua porta a Prezzo e piano, che mostra la scelta del piano", (t) => {
  const { d, call } = boot(t, { guided: true });
  d.querySelector(".result-actions .btn-primary").click();
  assert.equal(call("state.screen"), "plan");
  assert.ok(d.querySelector(".price-dual"));
  assert.equal(d.querySelector(".result-actions .btn-primary"), null, "niente «avanti» finché il piano non è scelto");
});

test("scelto il piano compare «Vai al riepilogo» e il riepilogo elenca le scelte", (t) => {
  const { d, call } = boot(t, { guided: true, patch: `state.screen="plan";` });
  d.querySelector(".price-option .btn-secondary").click(); // tariffa piena
  assert.equal(call("state.priceConfirmedForThisResult"), true);
  d.querySelector(".result-actions .btn-primary").click();
  assert.equal(call("state.screen"), "step-summary");
  const rows = [...d.querySelectorAll(".step-row")].map((r) => r.dataset.row);
  assert.deepEqual(rows, ["obj", "pickup", "dest", "plan", "discount", "total"]);
  assert.match(d.querySelector('[data-row="plan"]').textContent, /Tariffa piena/);
  assert.match(d.querySelector('[data-row="pickup"]').textContent, /Catania/);
});

test("Modifica del piano riapre la scelta e dopo la conferma si torna al riepilogo", (t) => {
  const { d, call } = boot(t, { guided: true, patch: `state.screen="step-summary"; state.priceConfirmedForThisResult=true;` });
  d.querySelector('[data-row="plan"] .step-row-edit').click();
  assert.equal(call("state.screen"), "plan");
  assert.equal(call("state.priceConfirmedForThisResult"), false);
  d.querySelector(".price-option.highlight .btn-primary").click(); // abbonato
  d.querySelector(".result-actions .btn-primary").click();
  assert.equal(call("state.screen"), "step-summary");
  assert.match(d.querySelector('[data-row="plan"]').textContent, /Abbonato/);
});

test("Modifica della destinazione non rilancia la classificazione e azzera il piano", (t) => {
  const { d, call } = boot(t, { guided: true, patch: `state.screen="step-summary"; state.priceConfirmedForThisResult=true;` });
  d.querySelector('[data-row="dest"] .step-row-edit').click();
  assert.equal(call("state.screen"), "edit-dest");
  d.querySelector(".section .btn-primary").click();
  assert.equal(call("state.screen"), "plan");
  assert.equal(call("state.priceConfirmedForThisResult"), false);
  assert.equal(call("state.result.hs_code"), "6913.10");
});

test("il riepilogo esegue l'escape dei dati scritti dal turista", (t) => {
  const { d } = boot(t, { guided: true, patch: `state.screen="step-summary"; state.pickupPoint="<img src=x onerror=alert(1)>";` });
  assert.equal(d.querySelector(".step-summary img"), null);
});

test("da Riepilogo si va alla scelta dell'indirizzo e «indietro» torna al riepilogo", (t) => {
  const { d, call } = boot(t, { guided: true, patch: `state.screen="step-summary";` });
  d.querySelector(".result-actions .btn-primary").click();
  assert.equal(call("state.screen"), "choose-address");
  d.querySelector(".back").click();
  assert.equal(call("state.screen"), "step-summary");
});
