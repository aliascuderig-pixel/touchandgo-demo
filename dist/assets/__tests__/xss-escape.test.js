// Verifica che i campi scritti/modificabili dal turista (nome oggetto,
// nome turista, punto di ritiro, etichetta/testo indirizzo, descrizione
// libera...) non possano iniettare HTML/JS reale quando finiscono in un
// innerHTML o in un template literal renderizzato nel DOM — solo testo
// letterale, mai un elemento eseguibile. Stesso standard già usato per il
// fix XSS del CRM (touchandgo-internal): un escapeHtml() applicato al
// momento del rendering, mai alla scrittura/salvataggio del dato.
//
// Ogni scenario carica l'app intera (dist/assets/app.js) in una finestra
// jsdom isolata, semina localStorage con un payload malevolo reale in un
// campo noto, guida l'app con veri click DOM (esattamente come farebbe un
// turista) fino alla schermata che espone quel campo, poi verifica che:
//   1. nessun elemento <img>/<script>/... col marker esiste davvero nel DOM
//      (l'iniezione non ha "attecchito" come markup reale);
//   2. il testo visibile (textContent) contiene il payload COME TESTO
//      LETTERALE (prova che è stato escapato, non silenziosamente rimosso);
//   3. l'handler onerror del payload non è mai scattato (nessuna esecuzione).
//
// Impostando XSS_TEST_APP_JS a un percorso diverso si può ripetere lo
// stesso identico test contro una versione precedente di app.js (usata per
// dimostrare che questo stesso test FALLISCE contro il codice pre-fix —
// vedi MANUALE.md, sezione "Escaping HTML nei campi scritti dal turista").

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_PATH = process.env.XSS_TEST_APP_JS || path.join(__dirname, "..", "app.js");
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, "utf8");

function payloadFor(marker) {
  // <img> con src rotto: se il browser lo interpreta davvero come un
  // elemento (HTML non escapato), onerror scatta SEMPRE (il caricamento di
  // "x" come URL immagine fallisce sempre) — un modo affidabile per
  // dimostrare esecuzione reale senza dipendere da rete o da un vero alert().
  return `<img src=x id="${marker}" onerror="window.__xssFired=(window.__xssFired||[]).concat('${marker}')">`;
}

function bootApp(t, seedLocalStorage) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  // dom.window.close() ferma anche i timer registrati dall'app (incluso il
  // setInterval di processPendingSyncQueue, vedi MANUALE.md "Coda di
  // ritentativo per la sincronizzazione col CRM") — senza, il processo
  // `node --test` resterebbe appeso a fine test invece di uscire.
  t.after(() => dom.window.close());
  const { window } = dom;
  window.__xssFired = [];
  // Rete disattivata: ogni fetch dell'app (sync CRM, geolocalizzazione,
  // foto città...) è già scritta per fallire silenziosamente (try/catch o
  // .catch(()=>{})) — qui vogliamo solo che il render iniziale avvenga,
  // non le chiamate di rete reali.
  window.fetch = () => Promise.reject(new Error("network disabled in test"));

  seedLocalStorage(window.localStorage);

  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });

  return { window, document: window.document, context };
}

function clickByText(document, selector, text) {
  const match = Array.from(document.querySelectorAll(selector)).find((e) => e.textContent.trim() === text);
  if (!match) throw new Error(`Nessun elemento "${selector}" con testo "${text}"`);
  match.click();
}

// Ritorna { html, text, fired, rawElementExists } per il primo elemento
// che corrisponde a `selector`, dopo aver fatto scattare eventuali
// onerror già presenti nel DOM (jsdom non carica immagini reali, quindi
// l'onerror di un <img src=x> iniettato va innescato esplicitamente qui,
// esattamente come farebbe un vero browser al fallimento del caricamento).
function inspect(window, document, selector, marker) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Elemento non trovato: ${selector}`);
  const img = document.getElementById(marker);
  if (img) img.dispatchEvent(new window.Event("error"));
  return {
    html: el.innerHTML,
    text: el.textContent,
    fired: window.__xssFired.slice(),
    rawElementExists: !!document.getElementById(marker),
  };
}

function assertEscaped(t, result, marker) {
  assert.equal(result.fired.length, 0, `[${t}] onerror non deve mai scattare (escapeHtml impedisce l'iniezione reale)`);
  assert.equal(result.rawElementExists, false, `[${t}] non deve esistere un elemento reale con id="${marker}" nel DOM`);
  assert.ok(
    result.text.includes(`<img src=x id="${marker}"`),
    `[${t}] il payload deve comparire come testo letterale (escapato), non essere sparito: ${result.text.slice(0, 120)}`
  );
}

test("HomeScreen: state.touristName (saluto) è escapato", (t) => {
  const marker = "xss-tourist-name";
  const { window, document } = bootApp(t, (ls) => {
    ls.setItem("tg_onboarded", "1");
    ls.setItem("tg_profile", JSON.stringify({ name: payloadFor(marker), email: "" }));
  });
  document.querySelector(".cover-screen").click();
  const result = inspect(window, document, ".greeting", marker);
  assertEscaped("HomeScreen greeting", result, marker);
});

test("HistoryScreen/PurchaseHistoryList: objectName, pickupPoint, addressLabel, touristName sono escapati", (t) => {
  const marker = "xss-history";
  const { window, document } = bootApp(t, (ls) => {
    ls.setItem("tg_onboarded", "1");
    ls.setItem(
      "tg_history",
      JSON.stringify([
        {
          id: "TG-HIST01",
          objectName: payloadFor(marker),
          hsCode: "420221",
          pickupPoint: payloadFor(marker),
          addressLabel: payloadFor(marker),
          touristName: payloadFor(marker),
          price: 10,
          itemValue: 5,
          status: "in sospeso",
          date: new Date().toISOString(),
        },
      ])
    );
  });
  document.querySelector(".cover-screen").click();
  document.querySelector("#history-link").click();
  const result = inspect(window, document, ".history-item", marker);
  assertEscaped("HistoryScreen", result, marker);
});

test("DocumentsScreen (lettera di vettura/fattura): touristName, pickupPoint, addressLabel, objectName sono escapati", (t) => {
  const marker = "xss-docs";
  const { window, document } = bootApp(t, (ls) => {
    ls.setItem("tg_onboarded", "1");
    ls.setItem(
      "tg_history",
      JSON.stringify([
        {
          id: "TG-DOC01",
          objectName: payloadFor(marker),
          hsCode: "420221",
          pickupPoint: payloadFor(marker),
          addressLabel: payloadFor(marker),
          touristName: payloadFor(marker),
          price: 10,
          itemValue: 5,
          weightKg: 1,
          status: "in sospeso",
          date: new Date().toISOString(),
        },
      ])
    );
  });
  document.querySelector(".cover-screen").click();
  document.querySelector("#history-link").click();
  clickByText(document, ".queue-item-change", "Lettera di vettura e fattura");
  const result = inspect(window, document, ".doc-card", marker);
  assertEscaped("DocumentsScreen waybill", result, marker);
});

test("HomeScreen: ReviewInviteBanner (objectName) è escapato", (t) => {
  const marker = "xss-review-banner";
  const deliveredAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const { window, document } = bootApp(t, (ls) => {
    ls.setItem("tg_onboarded", "1");
    ls.setItem(
      "tg_history",
      JSON.stringify([
        {
          id: "TG-REV01",
          objectName: payloadFor(marker),
          status: "ritirato",
          deliveryConfirmedAt: deliveredAt,
          date: deliveredAt,
          price: 10,
          itemValue: 5,
        },
      ])
    );
  });
  document.querySelector(".cover-screen").click();
  const result = inspect(window, document, ".review-invite-banner", marker);
  assertEscaped("ReviewInviteBanner", result, marker);
});

test("ViewItemPhotoScreen: descrizione libera (textDescription, campo 'Descrivilo') è escapata", (t) => {
  const marker = "xss-textdesc";
  const { window, document } = bootApp(t, (ls) => {
    ls.setItem("tg_onboarded", "1");
    ls.setItem(
      "tg_history",
      JSON.stringify([
        {
          id: "TG-TXT01",
          objectName: "Oggetto normale",
          hsCode: "420221",
          pickupPoint: "Acireale",
          addressLabel: "Casa — Via Roma 1",
          textDescription: payloadFor(marker),
          price: 10,
          itemValue: 5,
          status: "in sospeso",
          date: new Date().toISOString(),
        },
      ])
    );
  });
  document.querySelector(".cover-screen").click();
  document.querySelector("#history-link").click();
  document.querySelector(".history-item").click();
  const result = inspect(window, document, ".pending-desc", marker);
  assertEscaped("ViewItemPhotoScreen", result, marker);
});

test("Area partner — Comunicati: categoria e testo (creati dal CRM interno) sono escapati", async (t) => {
  // Il comunicato è scritto dallo staff nel CRM interno, non da un form
  // pubblico — ma la stessa disciplina di escaping si applica comunque,
  // senza eccezioni basate su "chi ha scritto il dato" (vedi commento in
  // PartnerComunicatiSection()). Login e lista comunicati arrivano via
  // fetch (non localStorage, a differenza degli altri test in questo
  // file): manipoliamo `state` direttamente nello stesso contesto vm
  // (stessa tecnica di setGlobal in admin-xss.test.js, touchandgo-internal)
  // invece di guidare l'intero login via click, per tenere il test
  // mirato solo all'escaping.
  const categoriaMarker = "xss-comunicato-categoria";
  const testoMarker = "xss-comunicato-testo";
  const { window, document, context } = bootApp(t, (ls) => {
    ls.setItem("tg_onboarded", "1");
  });
  window.fetch = async () => ({
    ok: true,
    json: async () => ({
      comunicati: [
        {
          id: "c-1",
          categoria: payloadFor(categoriaMarker),
          testo: payloadFor(testoMarker),
          destinatario: null,
          createdAt: new Date().toISOString(),
          readByMe: false,
        },
      ],
      readByMe: true, // forma minima valida anche per l'eventuale risposta di mark-comunicato-letto scatenata dal click sotto
    }),
  });

  document.querySelector(".cover-screen").click();
  document.querySelector('[data-mode="partner"]').click();
  vm.runInContext('state.partnerLoggedCode = "NEGOZIO123";', context);
  await vm.runInContext("refreshPartnerComunicati()", context);

  // Chiuso: solo la categoria è visibile (il testo compare solo aperto).
  const closedResult = inspect(window, document, ".comunicato-row", categoriaMarker);
  assertEscaped("Comunicati - categoria", closedResult, categoriaMarker);

  // Un tap apre la riga (render sincrono dentro il click handler, prima
  // ancora che la chiamata mark-comunicato-letto scatenata dallo stesso
  // tap si risolva) — a quel punto anche il testo è nel DOM.
  document.querySelector(".comunicato-row").click();
  const openResult = inspect(window, document, ".comunicato-row", testoMarker);
  assertEscaped("Comunicati - testo", openResult, testoMarker);
});
