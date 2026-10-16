// Bagaglio nell'app del turista: andata/ritorno, tariffa degli acquisti, nessuna AI.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function boot(t) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  dom.window.localStorage.setItem("tg_onboarded", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, {mode:"turista", screen:"home", pickupPoint:"Catania"});`, ctx);
  dom.window.render();
  return { w: dom.window, d: dom.window.document, ctx };
}
const ev = (ctx, code) => vm.runInContext(code, ctx);

test("home: c'è il pulsante Bagaglio che apre la schermata dedicata", (t) => {
  const { d } = boot(t);
  d.getElementById("home-luggage-btn").click();
  assert.ok(d.getElementById("luggage-go-btn"));
  assert.ok(d.getElementById("luggage-stay"), "campo alloggio visibile per l'andata");
});

test("ritorno: il campo alloggio sparisce; dati non validi bloccano", (t) => {
  const { d, ctx } = boot(t);
  d.getElementById("home-luggage-btn").click();
  d.querySelector('[data-dir="ritorno"]').click();
  assert.equal(d.getElementById("luggage-stay-row").style.display, "none");
  d.getElementById("luggage-weight").value = "99";
  d.getElementById("luggage-go-btn").click();
  assert.equal(ev(ctx, "state.screen"), "luggage");
  assert.equal(ev(ctx, "state.luggageDraft"), null);
});

test("andata: bozza salvata, passa alla destinazione senza classificazione AI", (t) => {
  const { d, ctx } = boot(t);
  d.getElementById("home-luggage-btn").click();
  d.getElementById("luggage-stay").value = "Hotel Etna, Catania";
  d.getElementById("luggage-bags").value = "2";
  d.getElementById("luggage-weight").value = "25";
  d.getElementById("luggage-go-btn").click();
  assert.equal(ev(ctx, "state.screen"), "destination");
  assert.equal(ev(ctx, "state.luggageDraft.direction"), "andata");
  assert.equal(ev(ctx, "state.luggageDraft.stay"), "Hotel Etna, Catania");
  ev(ctx, "confirmLuggageResult()");
  assert.equal(ev(ctx, "state.screen"), "result");
  assert.equal(ev(ctx, "state.result.weight_kg"), 25);
  assert.equal(ev(ctx, "state.result.hs_code"), "—");
});

test("tariffa del bagaglio = tariffa acquisti per lo stesso peso e destinazione", (t) => {
  const { ctx } = boot(t);
  ev(ctx, `state.luggageDraft = {direction:"ritorno", stay:"", bags:1, weightKg:12};`);
  ev(ctx, "confirmLuggageResult()");
  const same = ev(ctx, `JSON.stringify(state.price) === JSON.stringify(priceFor(12, currentDestinationName(), state.result))`);
  assert.equal(same, true);
});

test("un normale acquisto azzera la bozza bagaglio", (t) => {
  const { ctx } = boot(t);
  ev(ctx, `state.luggageDraft = {direction:"andata", stay:"", bags:1, weightKg:10};`);
  ev(ctx, `handleDescribe("vaso di ceramica")`);
  assert.equal(ev(ctx, "state.luggageDraft"), null);
});
