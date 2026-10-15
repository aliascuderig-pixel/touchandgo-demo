// Bagaglio: nessuna esenzione IVA export sui documenti (DocumentsScreen,
// 15 ottobre 2026) — non è una vendita. Acquisto invariato.

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

  return { window, document: window.document, context };
}

function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}
function callGlobal(context, expr) {
  return vm.runInContext(expr, context, { filename: "call-global.js" });
}

const ADDRESS = { id: "addr-1", label: "Casa — Via Roma 1, Milano 20100, Italia", street: "Via Roma 1", city: "Milano", cap: "20100", country: "Italia" };

function item(overrides) {
  return Object.assign(
    {
      id: "TG-000001",
      objectName: "Souvenir",
      touristName: "Turista Test",
      pickupPoint: "Firenze centro",
      addressId: ADDRESS.id,
      addressLabel: ADDRESS.label,
      hsCode: "691200",
      weightKg: 1,
      price: 39,
      status: "ritirato",
      date: "2026-09-10T10:00:00.000Z",
    },
    overrides
  );
}

function docRowValue(document, label) {
  const row = Array.from(document.querySelectorAll(".doc-row")).find((r) => r.querySelector("span").textContent === label);
  return row ? row.querySelector("b").textContent : null;
}

function openDocs(context, itemId) {
  setState(context, { addresses: [ADDRESS], screen: "documents", viewingDocsItemId: itemId });
  callGlobal(context, "render()");
}

test("DocumentsScreen: bagaglio -> 'Non applicabile', mai Art. 8; acquisto e record senza shipmentKind -> Art. 8", (t) => {
  for (const [id, extra, art8] of [
    ["b1", { shipmentKind: "bagaglio", luggageDirection: "ritorno" }, false],
    ["b2", { shipmentKind: "bagaglio", luggageDirection: "andata" }, false],
    ["a1", { shipmentKind: "acquisto" }, true],
    ["o1", {}, true],
  ]) {
    const { document, context } = bootApp(t);
    setState(context, { purchaseHistory: [item(Object.assign({ id }, extra))] });
    openDocs(context, id);
    const v = docRowValue(document, "Esenzione IVA");
    assert.equal(/Art\. 8 DPR 633\/72/.test(v), art8, id);
    if (!art8) assert.match(v, /Non applicabile/);
  }
});
