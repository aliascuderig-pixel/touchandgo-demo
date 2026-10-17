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
  assert.deepEqual(rows, ["obj", "pickup", "dest", "plan", "discount"]);
  assert.match(d.querySelector('[data-row="plan"]').textContent, /Senza abbonamento/);
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

// Prezzo chiaro: la somma delle voci mostrate è SEMPRE il totale mostrato.
const eur = (txt) => parseFloat(txt.replace(/[^0-9.,−-]/g, "").replace("−", "-").replace(",", "."));
function sumMatches(pb) {
  const rows = [...pb.querySelectorAll(".pb-row b")].map((b) => {
    const neg = b.textContent.includes("−");
    const parts = b.textContent.replace("−", "").trim().split(/\s+/);
    const val = eur(parts[parts.length - 1]);
    return neg ? -val : val;
  });
  const total = eur(pb.querySelector(".pb-total b").textContent);
  return { sum: Math.round(rows.reduce((a, b) => a + b, 0) * 100) / 100, total };
}

test("Prezzo e piano: in ogni riquadro Spedizione + Commissione = Totale", (t) => {
  const { d } = boot(t, { guided: true, patch: `state.screen="plan";` });
  const boxes = [...d.querySelectorAll(".price-option .pb")];
  assert.equal(boxes.length, 2);
  for (const b of boxes) {
    const { sum, total } = sumMatches(b);
    assert.equal(sum, total);
  }
  // Riquadro abbonati: tariffa scontata (piena barrata) + abbonamento una tantum.
  assert.ok(boxes[1].querySelector(".pb-row s"), "la tariffa piena compare barrata accanto a quella scontata");
  assert.ok(boxes[1].querySelector(".pb-row.subscription"));
});

test("Riepilogo: il dettaglio prezzo somma al totale e c'è la spiegazione «Come si calcola»", (t) => {
  const { d } = boot(t, { guided: true, patch: `state.screen="plan";` });
  assert.ok(d.querySelector(".pb-explain"));
  d.querySelector(".price-option .btn-secondary").click();
  d.querySelector(".result-actions .btn-primary").click();
  const { sum, total } = sumMatches(d.querySelector(".step-pb .pb"));
  assert.equal(sum, total);
  assert.ok(total > 0);
});

test("Conclusione con più oggetti: totale = somma voci e spiega perché differisce dalla somma delle stime", (t) => {
  const { d, call } = boot(t, {
    guided: true,
    patch: `state.addresses=[{id:"a1",label:"Casa",country:"Unione Europea",street:"Rue 1",city:"Parigi",zip:"75001"}];
      state.pendingItems=[1,2].map(i=>({id:"i"+i,objectName:"Oggetto "+i,pickupPoint:"Catania",hsCode:"6913",addressId:"a1",addressLabel:"Casa",price:45,weightKg:1,pricingTier:"pieno",dims:{length_cm:10,width_cm:10,height_cm:10}}));
      state.screen="conclude";`,
  });
  const pb = d.querySelector(".pay-summary .pay-group .pb");
  assert.ok(pb);
  const { sum, total } = sumMatches(pb);
  assert.equal(sum, total);
  assert.match(d.querySelector(".pay-why").textContent, /Perché non/);
  assert.match(d.querySelector(".btn-primary").textContent, new RegExp(String(total).replace(".", "\\.")));
});
