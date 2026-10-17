// Funzioni fisse: il cliente sceglie con 📌 quali funzioni tenere sempre sullo schermo.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function boot(t, patch, pins) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  dom.window.localStorage.setItem("tg_onboarded", "1");
  if (pins !== undefined) dom.window.localStorage.setItem("tg_pins", JSON.stringify(pins));
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, ctx);
  dom.window.render();
  return dom.window;
}
const pins = (w) => JSON.parse(w.localStorage.getItem("tg_pins") || "[]");

test("senza scelte: nessuna barra fissa, ogni voce del menu ha il suo 📌", (t) => {
  const w = boot(t, { mode: "turista", screen: "home" }), d = w.document;
  assert.equal(d.querySelector(".pin-bar"), null);
  assert.equal(d.querySelectorAll("#header-menu .menu-pin").length, 6);
  assert.ok(!d.getElementById("app").classList.contains("has-pinbar"));
});

test("fissare una funzione: compare nella barra, il menu resta aperto, la scelta è salvata", (t) => {
  const w = boot(t, { mode: "turista", screen: "home" }), d = w.document;
  d.getElementById("header-menu-btn").click();
  d.querySelector('.menu-pin[data-pin="documents"]').click();
  assert.ok(d.getElementById("header-menu").classList.contains("open"), "il menu resta aperto");
  assert.deepEqual(pins(w), ["documents"]);
  assert.equal(d.querySelectorAll(".pin-bar .pin-btn").length, 1);
  assert.ok(d.getElementById("app").classList.contains("has-pinbar"));
  assert.equal(d.querySelector('.menu-pin[data-pin="documents"]').getAttribute("aria-pressed"), "true");
  d.querySelector('.menu-pin[data-pin="documents"]').click();   // toglierla
  assert.deepEqual(pins(w), []);
  assert.equal(d.querySelector(".pin-bar"), null);
});

test("il pulsante della barra porta alla funzione", (t) => {
  const w = boot(t, { mode: "turista", screen: "home" }, ["documents"]), d = w.document;
  d.querySelector('.pin-bar [data-fn="documents"]').click();
  assert.equal(w.eval("state.screen"), "documents");
  assert.ok(d.querySelector(".pin-bar"), "la barra resta anche nella nuova schermata");
});

test("massimo 4 funzioni: la quinta è rifiutata con un messaggio", (t) => {
  const w = boot(t, { mode: "turista", screen: "home" }, ["home", "history", "dashboard", "documents"]), d = w.document;
  d.getElementById("header-menu-btn").click();
  d.querySelector('.menu-pin[data-pin="assistant"]').click();
  assert.equal(pins(w).length, 4);
  assert.match(d.querySelector(".menu-hint").textContent, /al massimo 4/);
});

test("scelte salvate non valide o doppie vengono ignorate", (t) => {
  const w = boot(t, { mode: "turista", screen: "home" }, ["home", "home", "inesistente", "support"]);
  assert.equal(w.document.querySelectorAll(".pin-bar .pin-btn").length, 2);
});

test("barra nascosta su cover, onboarding e in modalità partner", (t) => {
  assert.equal(boot(t, { mode: "turista", screen: "cover" }, ["home"]).document.querySelector(".pin-bar"), null);
  assert.equal(boot(t, { mode: "partner", screen: "home" }, ["home"]).document.querySelector(".pin-bar"), null);
});

test("localStorage corrotto: nessun errore, nessuna barra", (t) => {
  const w = boot(t, { mode: "turista", screen: "home" }); w.localStorage.setItem("tg_pins", "{non json");
  w.render();
  assert.equal(w.document.querySelector(".pin-bar"), null);
});
