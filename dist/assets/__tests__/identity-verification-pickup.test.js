// Verifica il gate di identità per la richiesta di ritiro: un turista può
// procedere con "📦 Richiedi ritiro" (PurchaseHistoryList, HistoryScreen) o
// con il bottone di conferma di ConcludeScreen SOLO se ha sia un documento
// di riconoscimento caricato (state.idDocument) SIA una firma effettivamente
// rilevata su quel documento (state.signatureDetected === true) — vedi
// hasValidIdentity() in app.js e MANUALE.md, sezione "Documento e firma
// obbligatori per richiedere il ritiro".
//
// Ogni scenario carica l'app intera (dist/assets/app.js) in una finestra
// jsdom isolata, semina localStorage con un profilo/storico/coda noti, guida
// l'app con veri click DOM (esattamente come farebbe un turista) e verifica
// che l'azione venga bloccata con reindirizzamento a IdentifyScreen (con il
// messaggio corretto) oppure proceda normalmente, a seconda dei casi.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, "utf8");

const ADDRESS = { id: "addr-t1", label: "Casa", street: "Via Test 1", city: "Roma", cap: "00100", country: "Italia" };

const GENERIC_MSG_HISTORY = "Prima di richiedere il ritiro, carica un documento di riconoscimento con firma visibile.";
const SPECIFIC_MSG_HISTORY =
  "Il documento caricato non mostra una firma visibile: ricaricane uno che la includa prima di richiedere il ritiro.";
const GENERIC_MSG_CONCLUDE = "Prima di confermare il ritiro, carica un documento di riconoscimento con firma visibile.";
const SPECIFIC_MSG_CONCLUDE =
  "Il documento caricato non mostra una firma visibile: ricaricane uno che la includa prima di confermare il ritiro.";

function profilePayload({ idDocument = null, signatureDetected = false } = {}) {
  return {
    name: "Turista Test",
    email: "turista@example.com",
    addresses: [ADDRESS],
    selectedAddressId: ADDRESS.id,
    idDocument,
    signatureDetected,
  };
}

function historyItem(overrides) {
  return Object.assign(
    {
      id: "TG-PICK01",
      objectName: "Borsa in pelle",
      hsCode: "420221",
      pickupPoint: "Roma centro",
      addressLabel: `${ADDRESS.label} — ${ADDRESS.street}, ${ADDRESS.city} ${ADDRESS.cap}, ${ADDRESS.country}`,
      addressId: ADDRESS.id,
      touristName: "Turista Test",
      price: 20,
      itemValue: 15,
      weightKg: 1,
      status: "in confezionamento",
      date: new Date().toISOString(),
    },
    overrides
  );
}

function pendingItem(overrides) {
  return Object.assign(
    {
      id: "TG-PEND01",
      objectName: "Scarpe artigianali",
      hsCode: "640351",
      pickupPoint: "Firenze centro",
      addressLabel: `${ADDRESS.label} — ${ADDRESS.street}, ${ADDRESS.city} ${ADDRESS.cap}, ${ADDRESS.country}`,
      addressId: ADDRESS.id,
      price: 30,
      itemValue: 25,
      weightKg: 1,
      pricingTier: "pieno",
      touristName: "Turista Test",
      status: "in sospeso",
      date: new Date().toISOString(),
    },
    overrides
  );
}

function makeFetchMock(hasSignature) {
  return (url) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/classify")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: [{ text: JSON.stringify({ has_signature: hasSignature }) }] }),
      });
    }
    return Promise.reject(new Error("network disabled in test"));
  };
}

// Image/canvas fittizi: jsdom non implementa la decodifica reale di
// immagini né HTMLCanvasElement.getContext("2d") senza il pacchetto
// "canvas" — qui si simula solo la "forma" del contratto che compressImage()
// (in app.js) si aspetta, non una vera compressione.
function installFakeImageAndCanvas(window) {
  class FakeImage {
    constructor() {
      this.width = 100;
      this.height = 100;
      this.onload = null;
      this.onerror = null;
    }
    set src(v) {
      this._src = v;
      setTimeout(() => {
        if (this.onload) this.onload();
      }, 0);
    }
    get src() {
      return this._src;
    }
  }
  window.Image = FakeImage;
  window.HTMLCanvasElement.prototype.getContext = function () {
    return { drawImage() {} };
  };
  window.HTMLCanvasElement.prototype.toDataURL = function () {
    return "data:image/jpeg;base64,ZmFrZQ==";
  };
}

function bootApp(t, { seedLocalStorage, fetchMock }) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = fetchMock || (() => Promise.reject(new Error("network disabled in test")));
  installFakeImageAndCanvas(window);

  // jsdom riporta navigator.language="en-US" di default, che farebbe
  // partire l'app in inglese (vedi detectInitialLang() in app.js) — i test
  // qui confrontano stringhe italiane (sia quelle nuove del gate identità
  // sia quelle già esistenti nell'UI), quindi si fissa la lingua salvata.
  window.localStorage.setItem("tg_lang", "it");
  seedLocalStorage(window.localStorage);

  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });

  return { window, document: window.document };
}

function clickByText(document, selector, text) {
  const match = Array.from(document.querySelectorAll(selector)).find((e) => e.textContent.trim() === text);
  if (!match) throw new Error(`Nessun elemento "${selector}" con testo "${text}"`);
  match.click();
}

function clickByPrefix(document, selector, prefix) {
  const match = Array.from(document.querySelectorAll(selector)).find((e) => e.textContent.trim().startsWith(prefix));
  if (!match) throw new Error(`Nessun elemento "${selector}" con testo che inizia per "${prefix}"`);
  match.click();
}

function goHome(document) {
  document.querySelector(".cover-screen").click();
}

function goHistory(document) {
  document.querySelector("#history-link").click();
}

function isOnIdentifyScreen(document) {
  return !!document.querySelector(".identify-screen");
}

function identifyIntroText(document) {
  const el = document.querySelector(".identify-intro");
  return el ? el.textContent : null;
}

async function completeIdentification(window, document, { hasSignature }) {
  document.getElementById("name-input").value = "Turista Cinque";
  document.getElementById("email-input").value = "cinque@example.com";
  document.getElementById("identify-city").value = "Roma";
  document.getElementById("identify-country").value = "Italia";

  const fileInput = document.querySelector(".id-upload-card input[type=file]");
  const file = new window.File(["fake-bytes"], "id.jpg", { type: "image/jpeg" });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event("change"));

  // Attende la catena reale FileReader -> compressImage -> detectSignature
  // (fetch mockata) -> aggiornamento dello stato visibile in #id-upload-status.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const statusEl = document.getElementById("id-upload-status");
  const expected = hasSignature ? "✓ Documento caricato — firma rilevata sul documento" : "✓ Documento caricato — nessuna firma rilevata sul documento";
  assert.equal(statusEl.textContent, expected, "il rilevamento firma (mockato) deve completarsi prima di salvare");

  clickByText(document, ".identify-screen .btn-primary", "Salva e continua →");
}

// ---------------------------------------------------------------------
// 1) Storico (PurchaseHistoryList, "📦 Richiedi ritiro")
// ---------------------------------------------------------------------

test("Richiedi ritiro: senza documento né firma, blocca e reindirizza a IdentifyScreen con messaggio generico", (t) => {
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_history", JSON.stringify([historyItem()]));
    },
  });
  goHome(document);
  goHistory(document);
  clickByText(document, ".queue-item-change", "📦 Richiedi ritiro");

  assert.ok(isOnIdentifyScreen(document), "deve reindirizzare a IdentifyScreen");
  assert.equal(identifyIntroText(document), GENERIC_MSG_HISTORY);
});

test("Richiedi ritiro: documento presente ma firma non rilevata, blocca con messaggio specifico", (t) => {
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload({ idDocument: "data:image/jpeg;base64,AAAA", signatureDetected: false })));
      ls.setItem("tg_history", JSON.stringify([historyItem()]));
    },
  });
  goHome(document);
  goHistory(document);
  clickByText(document, ".queue-item-change", "📦 Richiedi ritiro");

  assert.ok(isOnIdentifyScreen(document), "deve reindirizzare a IdentifyScreen");
  assert.equal(identifyIntroText(document), SPECIFIC_MSG_HISTORY);
});

test("Richiedi ritiro: documento e firma rilevata, l'azione procede normalmente", (t) => {
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload({ idDocument: "data:image/jpeg;base64,AAAA", signatureDetected: true })));
      ls.setItem("tg_history", JSON.stringify([historyItem()]));
    },
  });
  goHome(document);
  goHistory(document);
  clickByText(document, ".queue-item-change", "📦 Richiedi ritiro");

  assert.equal(isOnIdentifyScreen(document), false, "non deve reindirizzare a IdentifyScreen");
  const statusEl = document.querySelector(".history-status");
  assert.equal(statusEl.textContent, "ritiro richiesto");
});

// ---------------------------------------------------------------------
// 2) ConcludeScreen (bottone di conferma consolidato)
// ---------------------------------------------------------------------

function goConclude(document) {
  clickByText(document, ".btn-secondary", "Concludi il soggiorno e invia il ritiro →");
}

test("ConcludeScreen: senza documento né firma, blocca e reindirizza a IdentifyScreen con messaggio generico", (t) => {
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_pending", JSON.stringify([pendingItem()]));
    },
  });
  goHome(document);
  goConclude(document);
  clickByPrefix(document, ".btn-primary", "Conferma e paga");

  assert.ok(isOnIdentifyScreen(document), "deve reindirizzare a IdentifyScreen");
  assert.equal(identifyIntroText(document), GENERIC_MSG_CONCLUDE);
});

test("ConcludeScreen: documento presente ma firma non rilevata, blocca con messaggio specifico", (t) => {
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload({ idDocument: "data:image/jpeg;base64,AAAA", signatureDetected: false })));
      ls.setItem("tg_pending", JSON.stringify([pendingItem()]));
    },
  });
  goHome(document);
  goConclude(document);
  clickByPrefix(document, ".btn-primary", "Conferma e paga");

  assert.ok(isOnIdentifyScreen(document), "deve reindirizzare a IdentifyScreen");
  assert.equal(identifyIntroText(document), SPECIFIC_MSG_CONCLUDE);
});

test("ConcludeScreen: documento e firma rilevata, l'azione procede normalmente", (t) => {
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload({ idDocument: "data:image/jpeg;base64,AAAA", signatureDetected: true })));
      ls.setItem("tg_pending", JSON.stringify([pendingItem()]));
    },
  });
  goHome(document);
  goConclude(document);
  const confirmBtn = Array.from(document.querySelectorAll(".btn-primary")).find((e) => e.textContent.trim().startsWith("Conferma e paga"));
  confirmBtn.click();

  assert.equal(isOnIdentifyScreen(document), false, "non deve reindirizzare a IdentifyScreen");
  assert.equal(confirmBtn.disabled, true, "il pagamento (simulato) deve procedere, non restare bloccato");
  assert.equal(confirmBtn.textContent, "Confermo e pago…");
});

// ---------------------------------------------------------------------
// 3) Round-trip: reindirizzamento -> identificazione completata -> ritorno
//    al punto di partenza -> azione completabile
// ---------------------------------------------------------------------

test("Round-trip storico: dopo l'identificazione completata torna a History e può richiedere il ritiro", async (t) => {
  const { window, document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_history", JSON.stringify([historyItem()]));
    },
    fetchMock: makeFetchMock(true),
  });
  goHome(document);
  goHistory(document);
  clickByText(document, ".queue-item-change", "📦 Richiedi ritiro");
  assert.ok(isOnIdentifyScreen(document), "precondizione: deve essere stato reindirizzato");

  await completeIdentification(window, document, { hasSignature: true });

  assert.equal(isOnIdentifyScreen(document), false, "deve tornare indietro da IdentifyScreen");
  assert.ok(document.querySelector(".history-list"), "deve tornare esattamente a HistoryScreen (identifyReturnTo)");

  clickByText(document, ".queue-item-change", "📦 Richiedi ritiro");
  assert.equal(isOnIdentifyScreen(document), false, "ora con identità valida l'azione deve procedere");
  const statusEl = document.querySelector(".history-status");
  assert.equal(statusEl.textContent, "ritiro richiesto");
});

test("Round-trip Concludi: dopo l'identificazione completata torna a ConcludeScreen e può confermare il ritiro", async (t) => {
  const { window, document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_pending", JSON.stringify([pendingItem()]));
    },
    fetchMock: makeFetchMock(true),
  });
  goHome(document);
  goConclude(document);
  clickByPrefix(document, ".btn-primary", "Conferma e paga");
  assert.ok(isOnIdentifyScreen(document), "precondizione: deve essere stato reindirizzato");

  await completeIdentification(window, document, { hasSignature: true });

  assert.equal(isOnIdentifyScreen(document), false, "deve tornare indietro da IdentifyScreen");
  assert.ok(
    Array.from(document.querySelectorAll(".step-lbl")).some((e) => e.textContent.trim() === "Concludi il soggiorno"),
    "deve tornare esattamente a ConcludeScreen (identifyReturnTo)"
  );

  const confirmBtn = Array.from(document.querySelectorAll(".btn-primary")).find((e) => e.textContent.trim().startsWith("Conferma e paga"));
  confirmBtn.click();
  assert.equal(isOnIdentifyScreen(document), false, "ora con identità valida l'azione deve procedere");
  assert.equal(confirmBtn.disabled, true);
  assert.equal(confirmBtn.textContent, "Confermo e pago…");
});
