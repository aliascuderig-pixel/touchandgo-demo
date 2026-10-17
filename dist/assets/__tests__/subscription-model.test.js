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

test("senza abbonamento costa SEMPRE più che abbonandosi (spedizione + abbonamento trimestrale), per ogni spedizione realistica", (t) => {
  const { call } = boot(t);
  const bad = JSON.parse(call(`JSON.stringify((() => { const out = [];
    for (const dest of DESTINATIONS) for (let kg = 0.3; kg <= 49; kg += 0.7) {
      const q = priceQuotes(kg, dest.name, null);
      const subToday = q.shipping + SUBSCRIPTION_PLANS[0].price;
      if (!(q.full > subToday)) out.push([dest.name, kg, q.full, subToday]);
    } return out; })())`));
  assert.deepEqual(bad, [], "nessuna combinazione destinazione/peso in cui non abbonarsi conviene");
});

test("sovrapprezzo: mai sotto il 40%, mai sopra il 300%, più alto sulle spedizioni economiche", (t) => {
  const { call } = boot(t);
  const lo = JSON.parse(call("JSON.stringify(nonSubscriberSurcharge(11.25))"));
  const hi = JSON.parse(call("JSON.stringify(nonSubscriberSurcharge(300))"));
  assert.ok(lo.pct > hi.pct);
  assert.equal(hi.pct, 40);
  assert.ok(lo.pct <= 300);
  assert.equal(JSON.parse(call("JSON.stringify(nonSubscriberSurcharge(1))")).pct, 300);
});

test("l'abbonato paga solo la spedizione: nessuna commissione per spedizione", (t) => {
  const { call } = boot(t, "state.isSubscribed = true;");
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
