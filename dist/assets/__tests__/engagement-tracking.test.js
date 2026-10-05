// Verifica la strumentazione client-side degli eventi di engagement
// (trackEvent(), vedi MANUALE.md, "Analytics di engagement — app turista")
// introdotta per alimentare netlify/functions/track-event.js. Copre i
// quattro punti strumentati: avvio app (app_opened), classificazione
// riuscita (classification_completed), acquisto salvato
// (purchase_saved — SOLO al primo salvataggio, non alle risincronizzazioni
// di syncPurchaseToCRM() altrove nel file) e apertura dell'assistente
// (agent_chat_opened). Stessa tecnica delle altre suite su app.js:
// vm.runInContext su una finestra jsdom isolata (vedi real-country-city.test.js
// per il flusso di acquisto end-to-end completo riusato qui).
//
// trackEvent() è fire-and-forget per principio (vedi commento nel codice):
// qui catturiamo le chiamate a /.netlify/functions/track-event tramite un
// fetch mockato, mai una vera rete.

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
  if (seedLocalStorage) seedLocalStorage(window.localStorage);

  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });

  return { window, document: window.document };
}

function clickByText(document, selector, text) {
  const match = Array.from(document.querySelectorAll(selector)).find((e) => e.textContent.trim() === text);
  if (!match) throw new Error(`Nessun elemento "${selector}" con testo "${text}"`);
  match.click();
}

function goHome(document) {
  document.querySelector(".cover-screen").click();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLASSIFY_RESULT = {
  hs_code: "6911.10",
  category: "Ceramiche",
  material: "Ceramica",
  weight_kg: 1.2,
  length_cm: 20,
  width_cm: 15,
  height_cm: 15,
  value_eur: 60,
  fragile: true,
  confidence: "alta",
};

// Cattura ogni chiamata a track-event, lasciando passare (mockate) tutte
// le altre chiamate di rete già note al flusso d'acquisto — stesso schema
// di makeFetchMock() in real-country-city.test.js.
function makeFetchMock({ trackedEvents }) {
  return (url, opts) => {
    if (typeof url !== "string") return Promise.reject(new Error("network disabled in test"));
    if (url.includes("/.netlify/functions/track-event")) {
      trackedEvents.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    if (url.includes("/.netlify/functions/classify")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: [{ text: JSON.stringify(CLASSIFY_RESULT) }] }),
      });
    }
    if (url.includes("/.netlify/functions/estimate-duty")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url.includes("/.netlify/functions/save-purchase")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    if (url.includes("/.netlify/functions/guest-status")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ guestMode: false }) });
    }
    return Promise.reject(new Error("network disabled in test: " + url));
  };
}

test("app_opened: inviato una sola volta all'avvio dell'app, prima di qualunque interazione", async (t) => {
  const trackedEvents = [];
  bootApp(t, { fetchMock: makeFetchMock({ trackedEvents }) });
  await wait(10);

  const appOpened = trackedEvents.filter((e) => e.event === "app_opened");
  assert.equal(appOpened.length, 1, "app_opened deve essere inviato esattamente una volta all'avvio");
  assert.equal(appOpened[0].role, "turista");
});

test("classification_completed: inviato solo dopo una classificazione riuscita (runClassification, percorso successo)", async (t) => {
  const trackedEvents = [];
  const { window, document } = bootApp(t, { fetchMock: makeFetchMock({ trackedEvents }) });

  // Nessun evento ancora, a parte app_opened all'avvio.
  await wait(10);
  assert.equal(trackedEvents.filter((e) => e.event === "classification_completed").length, 0);

  await window.runClassification(Promise.resolve(CLASSIFY_RESULT));
  assert.ok(document.querySelector(".result-card"), "deve essere arrivato a ResultScreen");
  assert.equal(trackedEvents.filter((e) => e.event === "classification_completed").length, 1);
});

test("classification_completed: NON inviato se la classificazione fallisce (percorso errore/offline)", async (t) => {
  const trackedEvents = [];
  const { window } = bootApp(t, { fetchMock: makeFetchMock({ trackedEvents }) });
  await wait(10);

  await window.runClassification(Promise.reject(new Error("errore simulato")));
  assert.equal(trackedEvents.filter((e) => e.event === "classification_completed").length, 0);
});

test("agent_chat_opened: inviato al click su 'Chiedi all'agente' nell'header", async (t) => {
  const trackedEvents = [];
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => ls.setItem("tg_onboarded", "1"),
    fetchMock: makeFetchMock({ trackedEvents }),
  });
  await wait(10);
  goHome(document);

  const assistantBtn = document.getElementById("header-assistant-btn");
  assert.ok(assistantBtn, "il bottone 'Chiedi all'agente' deve essere presente in home");
  assistantBtn.click();

  const events = trackedEvents.filter((e) => e.event === "agent_chat_opened");
  assert.equal(events.length, 1);
  assert.equal(events[0].role, "turista");
});

test("purchase_saved: inviato una sola volta al salvataggio di un nuovo acquisto, non alle risincronizzazioni successive", async (t) => {
  const trackedEvents = [];
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => ls.setItem("tg_onboarded", "1"),
    fetchMock: makeFetchMock({ trackedEvents }),
  });
  await wait(10);

  goHome(document);
  const describeInput = document.querySelector('.describe-box input[type="text"]');
  describeInput.value = "Vaso in ceramica";
  clickByText(document, ".describe-box button", "→");
  await wait(150);
  clickByText(document, "button", "Analizza e calcola il prezzo →");
  await wait(150);
  assert.ok(document.querySelector(".result-card"), "deve essere arrivato a ResultScreen dopo la classificazione mockata");
  clickByText(document, "button", "Genera QR code →");

  // Nessun indirizzo salvato: reindirizza a IdentifyScreen.
  clickByText(document, "button", "Conferma e genera QR →");
  document.getElementById("name-input").value = "Turista Engagement";
  document.getElementById("email-input").value = "engagement@example.com";
  document.getElementById("identify-street").value = "Via Etnea 1";
  document.getElementById("identify-city").value = "Catania";
  document.getElementById("identify-cap").value = "95100";
  document.getElementById("identify-country").value = "Italia";
  document.getElementById("identify-realcountry").value = "Italia";
  clickByText(document, ".identify-screen .btn-primary", "Salva e continua →");

  clickByText(document, "button", "Conferma e genera QR →");
  await wait(800); // setTimeout(…, 700) prima della costruzione dell'item in app.js, stesso tempo già usato altrove in questa cartella

  const purchaseSaved = trackedEvents.filter((e) => e.event === "purchase_saved");
  assert.equal(purchaseSaved.length, 1, "purchase_saved deve essere inviato esattamente una volta al salvataggio");
});
