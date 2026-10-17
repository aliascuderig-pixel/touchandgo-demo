// Modello di prezzo 17/10/2026: abbonamento una tantum (3 durate) + sola spedizione;
// non abbonato = spedizione + sovrapprezzo % che lo rende SEMPRE meno conveniente.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function boot(t, patch = "") {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  dom.window.localStorage.setItem("tg_onboarded", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, {mode:"turista", pickupPoint:"Catania", guestDestinationCountry:"Unione Europea", purchaseHistory:[{}], isSubscribed:false,
    result:{object_it:"Vaso", weight_kg:1.2, length_cm:20, width_cm:10, height_cm:10, hs_code:"6913.10", confidence:"alta", value_eur:50}}); state.price = priceFor(1.2,"Unione Europea",state.result); ${patch}`, ctx);
  const call = (e) => vm.runInContext(e, ctx);
  call("render()");
  return { d: dom.window.document, call, window: dom.window };
}

test("i tre abbonamenti: trimestrale €29, semestrale €49, annuale €79", (t) => {
  const { call } = boot(t);
  assert.deepEqual(JSON.parse(call("JSON.stringify(SUBSCRIPTION_PLANS.map(p=>[p.id,p.months,p.price]))")), [["trimestrale", 3, 29], ["semestrale", 6, 49], ["annuale", 12, 79]]);
});

test("sconto proporzionale alla durata: più lungo l'abbonamento, più alto lo sconto sulla tariffa piena", (t) => {
  const { call } = boot(t);
  const d = JSON.parse(call(`JSON.stringify(SUBSCRIPTION_PLANS.map(p => planDiscountFraction(p.id)))`));
  assert.deepEqual(d, [0.075, 0.15, 0.3]);
  const q = JSON.parse(call(`JSON.stringify(priceQuotes(1.2, "Unione Europea", null))`));
  assert.ok(q.full > q.plans.trimestrale.rate && q.plans.trimestrale.rate > q.plans.semestrale.rate && q.plans.semestrale.rate > q.plans.annuale.rate);
});

test("MAI una tariffa sotto costo corriere +30%: vale per ogni destinazione, peso, piano e per il codice invito", (t) => {
  const { call } = boot(t);
  const bad = JSON.parse(call(`JSON.stringify((() => { const out = [];
    for (const dest of DESTINATIONS) for (let kg = 0.3; kg <= 49; kg += 0.7) {
      const sc = shippingCost(kg, dest.name, null);
      const q = priceQuotes(kg, dest.name, null);
      const zone = SHIPPING_RATES[dest.zone || DESTINATIONS.find(d=>d.name===dest.name).zone];
      const raw = bracketPrice(zone, Math.max(0.3, kg));
      const floor = Math.round(raw * 1.3 * 100) / 100;
      const rates = [q.full, q.breakeven, ...Object.values(q.plans).map(p => p.rate)];
      if (rates.some(r => r + 0.011 < floor)) out.push([dest.name, kg, floor, rates]);
    } return out; })())`));
  assert.deepEqual(bad, []);
});

test("tariffa piena = pavimento +43%; l'annuale paga esattamente il pavimento", (t) => {
  const { call } = boot(t);
  const q = JSON.parse(call(`JSON.stringify(priceQuotes(1.2, "Italia", null))`));
  assert.equal(q.surchargePct, 43);
  assert.equal(q.plans.annuale.extra, 0);
  assert.equal(q.plans.annuale.rate, q.shipping);
});

test("Italia su Italia: la tariffa piena resta contenuta (+43% sul pavimento, non multipli)", (t) => {
  const { call } = boot(t);
  const q = JSON.parse(call(`JSON.stringify(priceQuotes(1, "Italia", null))`));
  assert.equal(q.shipping, 11.7);
  assert.ok(q.full <= 17);
});

test("l'abbonato annuale paga solo la tariffa al pavimento (nessun extra)", (t) => {
  const { call } = boot(t, "state.isSubscribed = true; state.subscriptionPlan = 'annuale';");
  assert.equal(call("priceFor(1.2,'Unione Europea',state.result).grandTotal"), call("priceQuotes(1.2,'Unione Europea',state.result).shipping"));
});

test("confronto prezzi: due scelte, tre durate, abbonarsi attiva il piano e porta l'abbonamento sul primo oggetto", (t) => {
  const { d, call } = boot(t, `state.screen="plan"; state.priceConfirmedForThisResult=false;`);
  assert.equal(d.querySelectorAll(".plan-chip").length, 3);
  d.querySelector('.plan-chip[data-plan="annuale"]').click();
  assert.equal(call("state.subscriptionChoice"), "annuale");
  assert.match(d.querySelector(".price-option.highlight .pb-row.subscription").textContent, /Abbonamento annuale/);
  d.querySelector(".price-option.highlight .btn-primary").click();
  assert.equal(call("state.isSubscribed"), true);
  assert.equal(call("state.subscriptionPlan"), "annuale");
  assert.equal(call("state.subscriptionToCharge"), "annuale");
  // il totale mostrato include l'abbonamento
  const q = JSON.parse(call("JSON.stringify(priceQuotes(1.2,'Unione Europea',state.result))"));
  assert.equal(call("state.price.grandTotal"), Math.round((q.shipping + 79) * 100) / 100);
});

test("tornare a cambiare piano prima del pagamento annulla l'abbonamento non addebitato", (t) => {
  const { d, call } = boot(t, `state.screen="plan"; state.priceConfirmedForThisResult=false;`);
  d.querySelector(".price-option.highlight .btn-primary").click();
  d.querySelector(".result-actions .btn-primary").click();
  assert.equal(call("state.screen"), "step-summary");
  d.querySelector('[data-row="plan"] .step-row-edit').click();
  assert.equal(call("state.isSubscribed"), false);
  assert.equal(call("state.subscriptionToCharge"), null);
});

test("la PRIMA spedizione (prova) è a tariffa piena come le altre: nessuna card promo al pavimento", (t) => {
  const { d } = boot(t, `state.purchaseHistory = []; state.screen = "plan"; state.priceConfirmedForThisResult = false;`);
  assert.equal(d.querySelector(".promo-card-inline"), null);
  assert.equal(d.querySelectorAll(".price-option").length, 2);
});
