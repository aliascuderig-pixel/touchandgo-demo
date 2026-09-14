// Verifica customerNotices — registrazione permanente, sul record stesso
// dell'acquisto, di ogni avviso importante mostrato al cliente (prova a
// tutela di Touch&Go in caso di lamentele). Diverso dal trail di supporto
// esistente (getRecentTrail): quello è locale/temporaneo (ultime 15 voci,
// pensato per assistenza); customerNotices è permanente sul record e
// viaggia con esso a syncPurchaseToCRM()/save-purchase.js. Vedi
// confirmPickupSchedule() in app.js e MANUALE.md.
//
// Punti richiesti, verificati end-to-end sul vero app.js caricato in una
// finestra jsdom isolata (stessa tecnica di pickup-scheduling.test.js):
// (1) un ritiro posticipato genera una voce customerNotices col testo
//     esatto mostrato.
// (2) un ritiro rispettato genera ANCHE una voce (conferma, non solo il
//     caso "problematico").
// (3) più avvisi nel tempo si accumulano, mai si sovrascrivono.
// (4) il campo non influenza mai il prezzo calcolato (priceFor/priceQuotes).

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, "utf8");

function bootApp(t, { fetchMock } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = fetchMock || (() => Promise.reject(new Error("network disabled in test")));
  window.localStorage.setItem("tg_lang", "it");
  window.localStorage.setItem("tg_onboarded", "1");
  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });
  return { window, document: window.document, context };
}

function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}
function getState(context, expr) {
  return vm.runInContext(`state.${expr}`, context, { filename: "get-state.js" });
}
// DESTINATIONS è "const" in app.js: non diventa window.DESTINATIONS, stesso
// motivo per cui state ha bisogno di setState/getState sopra.
function getGlobal(context, expr) {
  return vm.runInContext(expr, context, { filename: "get-global.js" });
}
function findButtonByText(document, text) {
  return Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === text);
}
function findButtonContaining(document, partialText) {
  return Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes(partialText));
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function norm(value) {
  return JSON.parse(JSON.stringify(value));
}

function requestPickup(window, document, dateValue) {
  findButtonByText(document, "📦 Richiedi ritiro").click();
  if (dateValue) {
    const dateInput = document.getElementById("pickup-date-input");
    dateInput.value = dateValue;
    dateInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  findButtonContaining(document, "Conferma ritiro").click();
}

test("(1) un ritiro posticipato genera una voce customerNotices con il testo esatto mostrato", async (t) => {
  const { window, document, context } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
  });
  setState(context, {
    idDocument: "data:image/jpeg;base64,ZmFrZQ==",
    signatureDetected: true,
    purchaseHistory: [{ id: "TG-900001", objectName: "Anello", pickupPoint: "Negozio Test", hsCode: "7113.19", addressLabel: "Via Test 1, Napoli, Italia", price: 90, status: "in confezionamento", date: new Date().toISOString() }],
    screen: "history",
  });
  window.render();

  const today = window.todayDateString();
  requestPickup(window, document, today); // oggi -> nessun margine -> posticipata
  await wait(20);

  const item = getState(context, "purchaseHistory").find((it) => it.id === "TG-900001");
  const tomorrow = window.addDaysToDateString(today, 1);
  const expectedMessage = window.buildPickupConfirmationMessage(today, tomorrow);

  assert.equal(item.customerNotices.length, 1);
  assert.deepEqual(norm(item.customerNotices[0]).type, "pickup-scheduling");
  assert.equal(item.customerNotices[0].message, expectedMessage);
  assert.match(item.customerNotices[0].message, /preso in carico/);
  assert.ok(item.customerNotices[0].shownAt, "shownAt deve essere valorizzato");
  assert.ok(!isNaN(Date.parse(item.customerNotices[0].shownAt)));
});

test("(2) un ritiro rispettato genera ANCHE una voce customerNotices (conferma, non solo il caso problematico)", async (t) => {
  const { window, document, context } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
  });
  setState(context, {
    idDocument: "data:image/jpeg;base64,ZmFrZQ==",
    signatureDetected: true,
    purchaseHistory: [{ id: "TG-900002", objectName: "Sciarpa", pickupPoint: "Negozio Test", hsCode: "6214.30", addressLabel: "Via Test 2, Torino, Italia", price: 15, status: "in confezionamento", date: new Date().toISOString() }],
    screen: "history",
  });
  window.render();

  const today = window.todayDateString();
  const inFiveDays = window.addDaysToDateString(today, 5);
  requestPickup(window, document, inFiveDays); // margine sufficiente -> rispettata
  await wait(20);

  const item = getState(context, "purchaseHistory").find((it) => it.id === "TG-900002");
  const expectedMessage = window.buildPickupConfirmationMessage(inFiveDays, inFiveDays);

  assert.equal(item.customerNotices.length, 1, "anche il caso 'rispettata' deve generare una voce di prova");
  assert.equal(item.customerNotices[0].message, expectedMessage);
  assert.match(item.customerNotices[0].message, /^Ritiro confermato per/);
});

test("(3) più avvisi nel tempo si accumulano, mai si sovrascrivono", async (t) => {
  const syncedPayloads = [];
  const fetchMock = (url, opts) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/save-purchase")) {
      syncedPayloads.push(JSON.parse(opts.body));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  };
  const { window, document, context } = bootApp(t, { fetchMock });
  setState(context, {
    idDocument: "data:image/jpeg;base64,ZmFrZQ==",
    signatureDetected: true,
    purchaseHistory: [{
      id: "TG-900003",
      objectName: "Vaso",
      pickupPoint: "Negozio Test",
      hsCode: "6913.90",
      addressLabel: "Via Test 3, Milano, Italia",
      price: 40,
      status: "in confezionamento",
      date: new Date().toISOString(),
      customerNotices: [{ type: "altro-avviso-preesistente", message: "Avviso preesistente non deve mai sparire", shownAt: "2026-01-01T10:00:00.000Z" }],
    }],
    screen: "history",
  });
  window.render();

  const today = window.todayDateString();
  const inThreeDays = window.addDaysToDateString(today, 3);
  requestPickup(window, document, inThreeDays);
  await wait(20);

  let item = getState(context, "purchaseHistory").find((it) => it.id === "TG-900003");
  assert.equal(item.customerNotices.length, 2, "il nuovo avviso si aggiunge, la voce preesistente resta");
  assert.equal(item.customerNotices[0].type, "altro-avviso-preesistente");
  assert.equal(item.customerNotices[0].message, "Avviso preesistente non deve mai sparire");
  assert.equal(item.customerNotices[1].type, "pickup-scheduling");

  // Un secondo giro (es. una ri-pianificazione via assistenza sullo stesso
  // item) deve accodare una TERZA voce, senza toccare le prime due. Il
  // bottone "Richiedi ritiro" non è più disponibile per un item già
  // "ritiro richiesto" (solo per "in confezionamento") quindi qui si
  // richiama direttamente confirmPickupSchedule() — la stessa funzione
  // invocata dal bottone — impostando lo stato di scheduling come farebbe
  // openPickupScheduler().
  setState(context, { schedulingPickupItemId: "TG-900003", pickupDateChoice: today });
  window.confirmPickupSchedule();
  await wait(20);

  item = getState(context, "purchaseHistory").find((it) => it.id === "TG-900003");
  assert.equal(item.customerNotices.length, 3);
  assert.equal(item.customerNotices[0].message, "Avviso preesistente non deve mai sparire");
  assert.equal(item.customerNotices[1].type, "pickup-scheduling");
  assert.equal(item.customerNotices[2].type, "pickup-scheduling");
  assert.notEqual(item.customerNotices[1].message, item.customerNotices[2].message, "il secondo giro (posticipata) ha un testo diverso dal primo (rispettata)");

  assert.equal(syncedPayloads.length, 2, "syncPurchaseToCRM chiamata una volta per ogni conferma");
  assert.equal(syncedPayloads[0].customerNotices.length, 2, "il primo sync porta con sé preesistente + nuovo");
  assert.equal(syncedPayloads[1].customerNotices.length, 3, "il secondo sync porta con sé tutti e tre gli avvisi, accumulati");
});

test("(4) customerNotices non influenza mai il prezzo calcolato (priceFor/priceQuotes)", async (t) => {
  const { window, document, context } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
  });
  const destination = getGlobal(context, "DESTINATIONS")[0].name;
  const dims = { length_cm: 20, width_cm: 15, height_cm: 10 };

  const priceBefore = norm(window.priceFor(3, destination, dims));
  const quotesBefore = norm(window.priceQuotes(3, destination, dims));

  setState(context, {
    idDocument: "data:image/jpeg;base64,ZmFrZQ==",
    signatureDetected: true,
    purchaseHistory: [{ id: "TG-900004", objectName: "Cintura", pickupPoint: "Negozio Test", hsCode: "4203.30", addressLabel: "Via Test 4, Bari, Italia", price: 20, status: "in confezionamento", date: new Date().toISOString() }],
    screen: "history",
  });
  window.render();
  const today = window.todayDateString();
  requestPickup(window, document, today);
  await wait(20);

  const item = getState(context, "purchaseHistory").find((it) => it.id === "TG-900004");
  assert.ok(item.customerNotices.length >= 1, "precondizione: l'item ora porta customerNotices");
  assert.equal(item.price, 20, "il prezzo salvato sull'item resta quello originale, mai alterato");

  const priceAfter = norm(window.priceFor(3, destination, dims));
  const quotesAfter = norm(window.priceQuotes(3, destination, dims));
  assert.deepEqual(priceAfter, priceBefore, "priceFor() resta indipendente da customerNotices");
  assert.deepEqual(quotesAfter, quotesBefore, "priceQuotes() resta indipendente da customerNotices");
});
