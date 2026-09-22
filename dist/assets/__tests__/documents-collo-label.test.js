// Verifica "Collo N di M" sulla lettera di vettura (DocumentsScreen(),
// dist/assets/app.js, settembre 2026) — quando un oggetto fa parte di un
// gruppo di spedizione consolidato (item.shipmentGroupCode, già scritto da
// finalizeShippedGroups() al pagamento, vedi MANUALE.md "Prezzo
// consolidato per gruppo di spedizione"), la lettera di vettura per quel
// singolo oggetto deve mostrare la sua posizione nel gruppo. Nessun nuovo
// campo: colloLabelForItem() ricava N e M contando, in
// state.purchaseHistory già caricato in locale, gli acquisti che
// condividono lo stesso shipmentGroupCode.
//
// Stessa tecnica già usata in questo repository (vedi
// consolidated-group-price.test.js): app.js REALE caricato in una
// finestra jsdom isolata via vm.runInContext.

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

// ---------------------------------------------------------------------
// 1) Oggetto in un gruppo da 3 -> "Collo N di M" corretto per ciascuno.
// ---------------------------------------------------------------------

test('DocumentsScreen: oggetto in un gruppo di 3 -> mostra "Collo N di M" con la posizione corretta per ciascun collo', (t) => {
  const { document, context } = bootApp(t);
  const groupCode = "TG-GRUPPO1";
  setState(context, {
    purchaseHistory: [
      item({ id: "a", date: "2026-09-10T08:00:00.000Z", shipmentGroupCode: groupCode }),
      item({ id: "b", date: "2026-09-10T09:00:00.000Z", shipmentGroupCode: groupCode }),
      item({ id: "c", date: "2026-09-10T10:00:00.000Z", shipmentGroupCode: groupCode }),
    ],
  });

  openDocs(context, "a");
  assert.equal(docRowValue(document, "Collo"), "1 di 3");

  openDocs(context, "b");
  assert.equal(docRowValue(document, "Collo"), "2 di 3");

  openDocs(context, "c");
  assert.equal(docRowValue(document, "Collo"), "3 di 3");
});

test("DocumentsScreen: la posizione nel gruppo è ordinata per data di deposito, non per ordine di inserimento nell'array", (t) => {
  const { document, context } = bootApp(t);
  const groupCode = "TG-GRUPPO2";
  setState(context, {
    // Inserito volutamente FUORI ordine cronologico: "c" (il più vecchio)
    // è l'ultimo elemento dell'array, "a" (il più recente) il primo.
    purchaseHistory: [
      item({ id: "a", date: "2026-09-12T08:00:00.000Z", shipmentGroupCode: groupCode }),
      item({ id: "b", date: "2026-09-11T08:00:00.000Z", shipmentGroupCode: groupCode }),
      item({ id: "c", date: "2026-09-10T08:00:00.000Z", shipmentGroupCode: groupCode }),
    ],
  });

  openDocs(context, "c");
  assert.equal(docRowValue(document, "Collo"), "1 di 3", "il più vecchio per data è il collo 1, non l'ultimo dell'array");
  openDocs(context, "a");
  assert.equal(docRowValue(document, "Collo"), "3 di 3");
});

// ---------------------------------------------------------------------
// 2) Nessuna label per un oggetto singolo (non in un gruppo, o gruppo di
//    un solo oggetto).
// ---------------------------------------------------------------------

test("DocumentsScreen: oggetto SENZA shipmentGroupCode -> nessuna riga 'Collo', nessuna label superflua", (t) => {
  const { document, context } = bootApp(t);
  setState(context, {
    purchaseHistory: [item({ id: "solo", shipmentGroupCode: null })],
  });
  openDocs(context, "solo");

  assert.equal(docRowValue(document, "Collo"), null);
  // Il resto della lettera di vettura deve comunque comparire normalmente.
  assert.equal(docRowValue(document, "Riferimento"), "solo");
});

test("DocumentsScreen: shipmentGroupCode presente ma nessun altro acquisto locale lo condivide (gruppo di fatto singolo) -> nessuna 'Collo 1 di 1'", (t) => {
  const { document, context } = bootApp(t);
  setState(context, {
    purchaseHistory: [item({ id: "solo-group", shipmentGroupCode: "TG-GRUPPO-SOLO" })],
  });
  openDocs(context, "solo-group");

  assert.equal(docRowValue(document, "Collo"), null, 'un gruppo di un solo oggetto non deve mai mostrare "Collo 1 di 1"');
});

// ---------------------------------------------------------------------
// 3) colloLabelForItem() — unità pura, nessun campo nuovo inventato.
// ---------------------------------------------------------------------

test("colloLabelForItem(): null per un item null/undefined, nessuna eccezione", (t) => {
  const { context } = bootApp(t);
  setState(context, { purchaseHistory: [] });
  assert.equal(callGlobal(context, "colloLabelForItem(null)"), null);
});

test("colloLabelForItem(): due gruppi diversi non si mescolano mai (M conta solo i membri dello STESSO shipmentGroupCode)", (t) => {
  const { context } = bootApp(t);
  setState(context, {
    purchaseHistory: [
      item({ id: "a", date: "2026-09-10T08:00:00.000Z", shipmentGroupCode: "TG-GRUPPO-X" }),
      item({ id: "b", date: "2026-09-10T09:00:00.000Z", shipmentGroupCode: "TG-GRUPPO-X" }),
      item({ id: "c", date: "2026-09-10T08:00:00.000Z", shipmentGroupCode: "TG-GRUPPO-Y" }),
    ],
  });
  const label = callGlobal(context, `colloLabelForItem(state.purchaseHistory.find((h) => h.id === "a"))`);
  assert.equal(label, "1 di 2", "il gruppo Y (un solo membro qui) non deve contare nel totale del gruppo X");
});
