// Restyle A: nella home l'azione principale precede i banner informativi.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("home: la capture-card viene prima di fiducia, merci vietate e promemoria posizione", (t) => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  dom.window.localStorage.setItem("tg_onboarded", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, {mode:"turista", screen:"home", pickupSource:"manual", locationReminderDismissed:false});`, ctx);
  dom.window.render();
  const d = dom.window.document;
  const cap = d.querySelector(".capture-card");
  const info = d.querySelector(".home-info");
  assert.ok(cap && info);
  assert.ok(cap.compareDocumentPosition(info) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "i banner informativi stanno dopo la fotocamera");
  assert.ok(info.querySelector(".location-reminder"), "il promemoria posizione è nel blocco informativo");
});

test("home: il campo 'descrivilo' è vuoto, senza testo d'esempio, ma con aria-label", (t) => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  dom.window.localStorage.setItem("tg_onboarded", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, {mode:"turista", screen:"home"});`, ctx);
  dom.window.render();
  const input = dom.window.document.querySelector(".section .describe-box input");
  assert.equal(input.placeholder, "");
  assert.ok(input.getAttribute("aria-label"));
});

test("risultato: la scheda con peso e codice doganale viene prima di agente e banner merci vietate", (t) => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  dom.window.localStorage.setItem("tg_onboarded", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, {mode:"turista", screen:"result", pickupPoint:"Catania",
    result:{object_it:"Vaso", weight_kg:1.2, length_cm:20, width_cm:10, height_cm:10, hs_code:"6913.10", confidence:"alta", value_eur:50},
    price:{grandTotal:20, eta:"3-5 giorni", quotes:{full:20, breakeven:10, shipping:15, eta:"3-5 giorni"}}});`, ctx);
  dom.window.render();
  const d = dom.window.document;
  const card = d.querySelector(".result-card");
  const banner = d.querySelector(".prohibited-banner, .assistant-avatar, .avatar-row") ;
  assert.ok(card, "scheda risultato presente");
  const first = d.querySelector("#app").firstElementChild;
  assert.ok(d.querySelector(".topbar") && card.compareDocumentPosition(d.querySelector(".topbar")) & dom.window.Node.DOCUMENT_POSITION_PRECEDING, "la topbar precede la scheda");
  if (banner) assert.ok(card.compareDocumentPosition(banner) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "agente/banner dopo la scheda");
});
