// Verifica il riordino dei bottoni dell'header sulla prima schermata
// (CoverScreen, state.screen === "cover") — richiesto da Giuseppe il 5/10:
// "Contatta assistenza" e il link al sito marketing vengono mostrati solo
// DOPO la primissima schermata (da "home" in poi), non sulla cover, per
// ridurre l'affollamento dove conta meno (il turista non ha ancora fatto
// nulla). L'agente ("Chiedi all'agente Touch&Go") resta visibile anche
// sulla cover: è l'unico CTA secondario che ha senso offrire subito.
// Stessa tecnica delle altre suite su app.js: vm.runInContext su una
// finestra jsdom isolata (vedi support-request.test.js per la nota tecnica
// su setState()/getState()).

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, "utf8");

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
  window.localStorage.setItem("tg_onboarded", "1");

  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });

  return { window, document: window.document, context };
}

function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}

test("Header su cover: 'Contatta assistenza' e 'Sito' sono nascosti, 'Chiedi all'agente' e Reset restano visibili", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, { mode: "turista", screen: "cover", pickupPoint: "Test" });
  window.render();

  assert.equal(document.getElementById("header-support-btn"), null, "'Contatta assistenza' non deve comparire sulla cover");
  assert.equal(document.querySelector(".header-site-link"), null, "il link 'Sito' non deve comparire sulla cover");
  assert.ok(document.getElementById("header-assistant-btn"), "'Chiedi all'agente' deve restare visibile anche sulla cover");
  assert.ok(document.getElementById("header-reset"), "Reset deve restare visibile anche sulla cover");
});

test("Header fuori dalla cover (home): tutti e quattro i controlli tornano visibili", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, { mode: "turista", screen: "home" });
  window.render();

  assert.ok(document.getElementById("header-support-btn"), "'Contatta assistenza' deve ricomparire fuori dalla cover");
  assert.ok(document.querySelector(".header-site-link"), "il link 'Sito' deve ricomparire fuori dalla cover");
  assert.ok(document.getElementById("header-assistant-btn"));
  assert.ok(document.getElementById("header-reset"));
});

test("Header su cover in modalità partner: nessun bottone turista-only, Reset sempre presente", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, { mode: "partner", screen: "cover" });
  window.render();

  assert.equal(document.getElementById("header-assistant-btn"), null);
  assert.equal(document.getElementById("header-support-btn"), null);
  assert.ok(document.getElementById("header-reset"));
});
