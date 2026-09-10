// Verifica il modulo client "Contatta assistenza" (SupportRequestModal /
// submitSupportRequest in app.js) — l'invio di un ticket reale allo staff,
// primo pezzo separato del sistema di ticket assistenza predittivo (vedi
// MANUALE.md). Copre, in quest'ordine:
//   1. Il bottone "Contatta assistenza" nell'header apre la modale ed è
//      sempre raggiungibile (modalità turista), con l'email precompilata
//      da state.touristEmail se già nota.
//   2. Un messaggio vuoto viene rifiutato lato client PRIMA di chiamare
//      fetch (nessuna rete inutile per un invio già invalido).
//   3. Un invio valido chiama /.netlify/functions/sync con action
//      "submit-support-request" e un payload che include ESATTAMENTE
//      l'array restituito da getRecentTrail() al momento dell'invio —
//      punto critico per il prossimo pezzo separato (CRM).
//   4. "context" è calcolato con la stessa mappa TRAIL_SCREEN_LABELS già
//      usata per le voci "screen" del trail stesso.
//   5. escapeHtml() verificato con un payload <img onerror=...> reale nel
//      messaggio, sul rendering di conferma lato client.
//
// Stessa tecnica di support-trail.test.js: app.js REALE caricato in una
// finestra jsdom isolata via vm.runInContext. Vedi quel file per la nota
// tecnica su setState()/getState() (state è dichiarato "const" in app.js:
// accessibile come identificatore bare nel context, non come window.state).

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, "utf8");

function bootApp(t, { seedLocalStorage, fetchMock } = {}) {
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
  if (seedLocalStorage) seedLocalStorage(window.localStorage);

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFetchMock({ onSubmit, ok = true, body = { request: { id: "SR-TEST01" } } } = {}) {
  return (url, opts) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/sync")) {
      const parsed = JSON.parse(opts.body);
      if (parsed.action === "submit-support-request" && onSubmit) onSubmit(parsed);
      return Promise.resolve({ ok, json: () => Promise.resolve(body) });
    }
    return Promise.reject(new Error("network disabled in test: " + url));
  };
}

// ---------------------------------------------------------------------
// 1. Punto d'accesso: bottone header, sempre raggiungibile
// ---------------------------------------------------------------------

test("Header: il bottone 'Contatta assistenza' apre la modale e precompila l'email con touristEmail già nota", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, { mode: "turista", touristEmail: "gia-noto@example.com", screen: "home" });
  window.render();

  const btn = document.getElementById("header-support-btn");
  assert.ok(btn, "il bottone 'Contatta assistenza' deve esistere nell'header in modalità turista");
  btn.click();

  assert.equal(getState(context, "supportModalOpen"), true);
  const overlay = document.querySelector(".assistant-chat-overlay");
  assert.ok(overlay, "la modale deve essere renderizzata come overlay sopra la schermata corrente");
  const emailInput = document.getElementById("support-email-input");
  assert.equal(emailInput.value, "gia-noto@example.com", "l'email deve essere precompilata con state.touristEmail");
});

test("Header: 'Contatta assistenza' resta raggiungibile da una schermata diversa da Home (non nascosto in fondo a una schermata specifica)", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, { mode: "turista", screen: "history" });
  window.render();
  assert.ok(document.getElementById("header-support-btn"), "deve comparire anche fuori dalla Home");
});

// ---------------------------------------------------------------------
// 2. Validazione client: messaggio vuoto rifiutato PRIMA di chiamare fetch
// ---------------------------------------------------------------------

test("submitSupportRequest(): messaggio vuoto -> errore locale, NESSUNA chiamata a submit-support-request", async (t) => {
  let supportRequestCalled = false;
  const { window, context } = bootApp(t, {
    // Altre fetch automatiche a bootstrap (es. guest-status) non sono
    // rilevanti per questo test: solo una vera chiamata con action
    // "submit-support-request" farebbe fallire l'assert sotto.
    fetchMock: (url, opts) => {
      if (typeof url === "string" && url.includes("/.netlify/functions/sync")) {
        const parsed = JSON.parse(opts.body);
        if (parsed.action === "submit-support-request") supportRequestCalled = true;
      }
      return Promise.reject(new Error("network disabled in test"));
    },
  });
  setState(context, { supportModalOpen: true, supportMessage: "   " });
  await window.submitSupportRequest();
  assert.equal(supportRequestCalled, false, "un messaggio vuoto/solo spazi non deve mai generare una richiesta 'submit-support-request'");
  assert.ok(getState(context, "supportSubmitError"), "state.supportSubmitError deve essere valorizzato");
});

// ---------------------------------------------------------------------
// 3. Invio valido: payload corretto, trail incluso ESATTAMENTE
// ---------------------------------------------------------------------

test("submitSupportRequest(): invio valido chiama sync.js con action 'submit-support-request' e il trail ESATTO di getRecentTrail()", async (t) => {
  let capturedPayload = null;
  const { window, context } = bootApp(t, {
    fetchMock: makeFetchMock({ onSubmit: (p) => (capturedPayload = p) }),
  });

  // Genera un trail reale con le funzioni vere del file (non simulato a
  // mano): un cambio schermata + un'azione, esattamente come farebbe un
  // turista prima di aprire "Contatta assistenza".
  setState(context, { screen: "destination" });
  window.render();
  window.handleImageDataUrl("data:image/jpeg;base64,AAAA", "image/jpeg"); // aggiunge un'azione al trail

  const trailBeforeSubmit = window.getRecentTrail();

  setState(context, {
    supportModalOpen: true,
    supportMessage: "Il QR non si genera.",
    supportContactEmail: "test@example.com",
    screen: "choose-address",
  });
  window.render();

  await window.submitSupportRequest();

  assert.ok(capturedPayload, "fetch deve essere stato chiamato con il payload");
  assert.equal(capturedPayload.action, "submit-support-request");
  assert.equal(capturedPayload.message, "Il QR non si genera.");
  assert.equal(capturedPayload.contactEmail, "test@example.com");

  // Il trail al momento dell'invio include ANCHE il cambio a "choose-address"
  // (avvenuto dopo trailBeforeSubmit, con l'ultimo render() prima del
  // submit) — quindi confrontiamo con getRecentTrail() preso ESATTAMENTE
  // allo stesso istante logico usato da submitSupportRequest(), non uno
  // snapshot precedente.
  // JSON.parse(JSON.stringify(...)) normalizza l'oggetto restituito dal
  // realm della vm (window.getRecentTrail() vive nel context jsdom) in un
  // oggetto del realm di questo test — altrimenti deepStrictEqual fallisce
  // per prototipi Object diversi tra i due realm pur essendo
  // strutturalmente identici (stesso quirk noto di Node/vm già documentato
  // altrove nel progetto, es. destinations.test.js in touchandgo-internal).
  const expectedTrail = JSON.parse(JSON.stringify(window.getRecentTrail()));
  assert.deepEqual(capturedPayload.trail, expectedTrail, "il trail inviato deve essere ESATTAMENTE quello di getRecentTrail() al momento dell'invio, nessuna trasformazione");
  assert.ok(capturedPayload.trail.length >= trailBeforeSubmit.length, "il trail inviato non deve mai essere più corto di quello raccolto fino a quel momento");

  assert.equal(getState(context, "supportSubmitted"), true, "dopo un invio riuscito lo stato passa a 'inviato'");
});

// ---------------------------------------------------------------------
// 4. "context" usa la stessa mappa TRAIL_SCREEN_LABELS del trail
// ---------------------------------------------------------------------

test("submitSupportRequest(): 'context' è l'etichetta leggibile della schermata corrente (stessa mappa TRAIL_SCREEN_LABELS del trail)", async (t) => {
  let capturedPayload = null;
  const { window, context } = bootApp(t, {
    fetchMock: makeFetchMock({ onSubmit: (p) => (capturedPayload = p) }),
  });
  setState(context, { supportModalOpen: true, supportMessage: "Messaggio di test", screen: "choose-address" });
  window.render();
  await window.submitSupportRequest();
  assert.equal(capturedPayload.context, "Scegli indirizzo", "deve usare la stessa etichetta italiana che il trail userebbe per questa schermata");
});

// ---------------------------------------------------------------------
// 5. escapeHtml() sul rendering di conferma
// ---------------------------------------------------------------------

test("SupportRequestModal: un payload malevolo nel messaggio non crea mai un elemento reale nella conferma, solo testo escapato", async (t) => {
  const EVIL = '<img src=x onerror="window.__xssFired=true">';
  const { window, document, context } = bootApp(t, {
    fetchMock: makeFetchMock(),
  });
  setState(context, { supportModalOpen: true, supportMessage: EVIL });
  window.render();
  await window.submitSupportRequest();

  const overlay = document.querySelector(".assistant-chat-overlay");
  assert.ok(overlay, "la modale di conferma deve restare visibile dopo l'invio");
  assert.equal(overlay.querySelectorAll("img").length, 0, "il payload non deve mai creare un elemento <img> reale nel DOM");
  assert.equal(window.__xssFired, undefined, "nessun onerror deve essere eseguito");
  assert.match(overlay.innerHTML, /&lt;img src=x onerror=/, "il payload deve comparire solo come testo letterale escapato nella conferma");
});
