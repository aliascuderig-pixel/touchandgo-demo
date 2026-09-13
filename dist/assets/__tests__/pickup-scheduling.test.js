// Verifica il selettore data di ritiro — il click su "📦 Richiedi ritiro"
// (PurchaseHistoryList, dist/assets/app.js) non imposta più subito
// status="ritiro richiesto": apre un selettore dove il cliente sceglie una
// data preferita, poi il sistema decide la data reale (PickupSchedulerModal/
// resolveScheduledPickupDate). Vedi MANUALE.md per la descrizione completa.
//
// Punti richiesti, verificati sia come funzioni pure sia end-to-end sul
// vero app.js caricato in una finestra jsdom isolata (stessa tecnica di
// partner-generate-shipment.test.js/support-request.test.js):
// (1) una data preferita con almeno un giorno di margine viene rispettata
//     esattamente.
// (2) una data preferita per oggi viene posticipata a domani.
// (3) preferredPickupDate e scheduledPickupDate sono entrambi salvati
//     correttamente, anche quando diversi.
// (4) il messaggio mostrato distingue correttamente i due casi (rispettata
//     vs posticipata).
// (5) il controllo identità esistente continua a funzionare esattamente
//     come prima, prima ancora di arrivare alla scelta della data.

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

// state è dichiarato "const" in app.js: accessibile come identificatore
// bare nel context, non come window.state — stessa tecnica già usata in
// support-trail.test.js/support-request.test.js.
function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}
function getState(context, expr) {
  return vm.runInContext(`state.${expr}`, context, { filename: "get-state.js" });
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
// Normalizza un oggetto cross-realm (creato dentro il context vm) prima di
// un deepEqual — stessa tecnica già usata in support-request.test.js:
// senza, deepStrictEqual fallisce per "stessa struttura ma non
// reference-equal" anche quando i valori sono davvero identici.
function norm(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------
// Funzioni pure — resolveScheduledPickupDate/buildPickupConfirmationMessage.
// ---------------------------------------------------------------------

test("(1) una data preferita con almeno un giorno pieno di margine viene rispettata esattamente", (t) => {
  const { window } = bootApp(t);
  const today = window.todayDateString();
  const tomorrow = window.addDaysToDateString(today, 1);
  const inTenDays = window.addDaysToDateString(today, 10);

  assert.deepEqual(norm(window.resolveScheduledPickupDate(tomorrow, today)), { preferredDate: tomorrow, scheduledDate: tomorrow });
  assert.deepEqual(norm(window.resolveScheduledPickupDate(inTenDays, today)), { preferredDate: inTenDays, scheduledDate: inTenDays });
});

test("(2) una data preferita per oggi viene posticipata a domani", (t) => {
  const { window } = bootApp(t);
  const today = window.todayDateString();
  const tomorrow = window.addDaysToDateString(today, 1);

  const result = window.resolveScheduledPickupDate(today, today);
  assert.equal(result.preferredDate, today);
  assert.equal(result.scheduledDate, tomorrow);
});

test("(2b) una data preferita nel passato (mai selezionabile dal calendario, ma verificato comunque) viene trattata come 'nessun margine' -> posticipata a domani", (t) => {
  const { window } = bootApp(t);
  const today = window.todayDateString();
  const tomorrow = window.addDaysToDateString(today, 1);
  const yesterday = window.addDaysToDateString(today, -1);

  const result = window.resolveScheduledPickupDate(yesterday, today);
  assert.equal(result.scheduledDate, tomorrow);
});

test("una preferenza non valida/vuota non genera un errore: ricade su oggi, quindi posticipata a domani", (t) => {
  const { window } = bootApp(t);
  const today = window.todayDateString();
  const tomorrow = window.addDaysToDateString(today, 1);

  assert.deepEqual(norm(window.resolveScheduledPickupDate("", today)), { preferredDate: today, scheduledDate: tomorrow });
  assert.deepEqual(norm(window.resolveScheduledPickupDate("non-una-data", today)), { preferredDate: today, scheduledDate: tomorrow });
});

test("(4) buildPickupConfirmationMessage: quando la data coincide, una conferma semplice — mai la parola 'ritardo'", (t) => {
  const { window } = bootApp(t);
  const today = window.todayDateString();
  const tomorrow = window.addDaysToDateString(today, 1);
  const msg = window.buildPickupConfirmationMessage(tomorrow, tomorrow);
  assert.match(msg, /^Ritiro confermato per/);
  assert.ok(!/ritardo/i.test(msg));
});

test("(4b) buildPickupConfirmationMessage: quando la data è posticipata, una spiegazione neutra che menziona ENTRAMBE le date — mai come una scusa/un problema", (t) => {
  const { window } = bootApp(t);
  const today = window.todayDateString();
  const tomorrow = window.addDaysToDateString(today, 1);
  const msg = window.buildPickupConfirmationMessage(today, tomorrow);
  assert.match(msg, /preso in carico/);
  assert.match(msg, /tua preferenza/);
  assert.ok(!/ritardo|purtroppo|spiacenti|scusa/i.test(msg), "mai toni di scusa/problema, il vincolo è esplicito");
});

// ---------------------------------------------------------------------
// (5) Il controllo identità esistente resta invariato, PRIMA della scelta
// della data.
// ---------------------------------------------------------------------

test("(5) senza documento d'identità valido, il click apre 'identify' come prima — il selettore data non si apre mai", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, {
    idDocument: null,
    signatureDetected: false,
    purchaseHistory: [{ id: "TG-000001", objectName: "Borsa", pickupPoint: "Negozio Test", hsCode: "4202.21", addressLabel: "Via Test 1, Roma, Italia", price: 25, status: "in confezionamento", date: new Date().toISOString() }],
    screen: "history",
  });
  window.render();

  const pickupBtn = findButtonByText(document, "📦 Richiedi ritiro");
  assert.ok(pickupBtn, "deve esistere il bottone 'Richiedi ritiro' per un item in confezionamento");
  pickupBtn.click();

  assert.equal(getState(context, "screen"), "identify", "stesso comportamento di prima: senza identità valida si va a 'identify'");
  assert.equal(getState(context, "pickupSchedulerOpen"), false, "il selettore data non deve mai aprirsi senza identità valida");
  assert.ok(getState(context, "identifyPrompt"), "il messaggio di richiesta documento deve essere impostato come prima");
});

test("(5b) CON documento d'identità valido, il click apre il selettore data (non imposta più subito 'ritiro richiesto')", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, {
    idDocument: "data:image/jpeg;base64,ZmFrZQ==",
    signatureDetected: true,
    purchaseHistory: [{ id: "TG-000002", objectName: "Vaso", pickupPoint: "Negozio Test", hsCode: "6913.90", addressLabel: "Via Test 2, Milano, Italia", price: 40, status: "in confezionamento", date: new Date().toISOString() }],
    screen: "history",
  });
  window.render();

  const pickupBtn = findButtonByText(document, "📦 Richiedi ritiro");
  pickupBtn.click();

  assert.equal(getState(context, "pickupSchedulerOpen"), true, "con identità valida il selettore data deve aprirsi");
  assert.equal(getState(context, "schedulingPickupItemId"), "TG-000002");
  const item = getState(context, "purchaseHistory").find((it) => it.id === "TG-000002");
  assert.equal(item.status, "in confezionamento", "lo stato non deve ancora cambiare finché la data non è confermata");
  assert.ok(document.getElementById("pickup-date-input"), "il selettore data deve essere visibile nel DOM");
});

// ---------------------------------------------------------------------
// (3) Flusso end-to-end completo: click -> selezione data -> conferma ->
// entrambi i campi salvati correttamente sull'item reale.
// ---------------------------------------------------------------------

test("(3) flusso completo con margine sufficiente: preferredPickupDate === scheduledPickupDate, entrambi salvati", async (t) => {
  const syncedPayloads = [];
  const fetchMock = (url, opts) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/save-purchase")) {
      syncedPayloads.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.reject(new Error("network disabled in test: " + url));
  };
  const { window, document, context } = bootApp(t, { fetchMock });
  setState(context, {
    idDocument: "data:image/jpeg;base64,ZmFrZQ==",
    signatureDetected: true,
    purchaseHistory: [{ id: "TG-000003", objectName: "Sciarpa", pickupPoint: "Negozio Test", hsCode: "6214.30", addressLabel: "Via Test 3, Torino, Italia", price: 15, status: "in confezionamento", date: new Date().toISOString(), touristEmail: "test@example.it" }],
    screen: "history",
  });
  window.render();
  findButtonByText(document, "📦 Richiedi ritiro").click();

  const today = window.todayDateString();
  const inFiveDays = window.addDaysToDateString(today, 5);
  const dateInput = document.getElementById("pickup-date-input");
  dateInput.value = inFiveDays;
  dateInput.dispatchEvent(new window.Event("input", { bubbles: true }));

  findButtonContaining(document, "Conferma ritiro").click();
  await wait(20);

  const item = getState(context, "purchaseHistory").find((it) => it.id === "TG-000003");
  assert.equal(item.preferredPickupDate, inFiveDays);
  assert.equal(item.scheduledPickupDate, inFiveDays, "con 5 giorni di margine la preferenza deve essere rispettata esattamente");
  assert.equal(item.status, "ritiro richiesto");
  assert.ok(item.pickupRequestedAt);

  assert.equal(syncedPayloads.length, 1, "syncPurchaseToCRM deve essere stata chiamata esattamente una volta");
  assert.equal(syncedPayloads[0].preferredPickupDate, inFiveDays, "i due nuovi campi devono viaggiare col resto dell'item, invariato");
  assert.equal(syncedPayloads[0].scheduledPickupDate, inFiveDays);

  // Conferma mostrata nel modal.
  const confirmBox = document.querySelector(".support-confirm-message");
  assert.ok(confirmBox);
  assert.match(confirmBox.textContent, /^Ritiro confermato per/);
});

test("(3b) flusso completo con data preferita = oggi: preferredPickupDate !== scheduledPickupDate, entrambi salvati correttamente", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }) });
  setState(context, {
    idDocument: "data:image/jpeg;base64,ZmFrZQ==",
    signatureDetected: true,
    purchaseHistory: [{ id: "TG-000004", objectName: "Anello", pickupPoint: "Negozio Test", hsCode: "7113.19", addressLabel: "Via Test 4, Napoli, Italia", price: 90, status: "in confezionamento", date: new Date().toISOString() }],
    screen: "history",
  });
  window.render();
  findButtonByText(document, "📦 Richiedi ritiro").click();

  const today = window.todayDateString();
  const tomorrow = window.addDaysToDateString(today, 1);
  const dateInput = document.getElementById("pickup-date-input");
  // Il cliente lascia il valore precompilato di default: oggi.
  assert.equal(dateInput.value, today, "il selettore deve precompilare la data odierna come default");

  findButtonContaining(document, "Conferma ritiro").click();
  await wait(20);

  const item = getState(context, "purchaseHistory").find((it) => it.id === "TG-000004");
  assert.equal(item.preferredPickupDate, today, "la preferenza originale del cliente deve restare quella scelta (oggi), invariata");
  assert.equal(item.scheduledPickupDate, tomorrow, "la data reale deve essere posticipata a domani");
  assert.notEqual(item.preferredPickupDate, item.scheduledPickupDate);

  // (4) Messaggio distingue il caso "posticipata".
  const confirmBox = document.querySelector(".support-confirm-message");
  assert.match(confirmBox.textContent, /preso in carico/);
  assert.match(confirmBox.textContent, /tua preferenza/);
});

test("il selettore data non permette di scegliere una data passata (attributo min = oggi)", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, {
    idDocument: "data:image/jpeg;base64,ZmFrZQ==",
    signatureDetected: true,
    purchaseHistory: [{ id: "TG-000005", objectName: "Cintura", pickupPoint: "Negozio Test", hsCode: "4203.30", addressLabel: "Via Test 5, Bari, Italia", price: 20, status: "in confezionamento", date: new Date().toISOString() }],
    screen: "history",
  });
  window.render();
  findButtonByText(document, "📦 Richiedi ritiro").click();

  const dateInput = document.getElementById("pickup-date-input");
  assert.equal(dateInput.getAttribute("min"), window.todayDateString());
});
