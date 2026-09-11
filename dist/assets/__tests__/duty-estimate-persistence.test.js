// Verifica end-to-end lato client che il testo della stima dazi mostrata
// al turista (state.dutyEstimate, popolato da refreshDutyEstimate() — vedi
// MANUALE.md, "Stima dazi doganali") finisca correttamente su
// item.dutyEstimateShown nel payload inviato a save-purchase.js — primo
// passo per poterlo eventualmente confrontare in futuro con un dazio
// reale riportato. Nessuna modifica alla generazione/visualizzazione
// della stima: qui si verifica solo che il valore già esistente in stato
// venga propagato correttamente all'acquisto salvato.
//
// Stessa tecnica end-to-end di real-country-city.test.js (flusso di
// acquisto completo: Home -> descrivi -> classify mockata -> destinazione
// -> conferma indirizzo -> payload effettivo a save-purchase).

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

const ESTIMATE_TEXT =
  "Per gli Stati Uniti, oggetti in ceramica di questo valore rientrano tipicamente in un dazio del 4-6% circa. Stima indicativa, non vincolante — verifica sempre con le autorità doganali del paese di destinazione prima di partire.";

function makeFetchMock({ onSavePurchase, dutyEstimateOutcome }) {
  return (url, opts) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/classify")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: [{ text: JSON.stringify(CLASSIFY_RESULT) }] }),
      });
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/estimate-duty")) {
      if (dutyEstimateOutcome === "success") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ estimate: ESTIMATE_TEXT }) });
      }
      if (dutyEstimateOutcome === "http-error") {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: "boom" } }) });
      }
      // "network-error"
      return Promise.reject(new Error("network disabled in test"));
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/save-purchase")) {
      if (onSavePurchase) onSavePurchase(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.reject(new Error("network disabled in test: " + url));
  };
}

// Percorso comune fino a ChooseAddressScreen con un indirizzo già pronto
// (seed diretto di tg_profile, per non dover ripetere il modulo
// IdentifyScreen in ogni test — stesso principio di riuso già visto in
// altri file di questo repository).
const ADDRESS = { id: "addr-duty1", label: "Casa", street: "Rue de Rivoli 10", city: "Parigi", cap: "75001", country: "Unione Europea", realCountry: "Francia" };

function seedProfile(ls) {
  ls.setItem("tg_onboarded", "1");
  ls.setItem(
    "tg_profile",
    JSON.stringify({
      name: "Turista Dazi",
      email: "dazi@example.com",
      addresses: [ADDRESS],
      selectedAddressId: ADDRESS.id,
    })
  );
}

async function runToSavedPurchase(t, dutyEstimateOutcome) {
  const savedPurchases = [];
  const { document } = bootApp(t, {
    seedLocalStorage: seedProfile,
    fetchMock: makeFetchMock({ onSavePurchase: (item) => savedPurchases.push(item), dutyEstimateOutcome }),
  });

  goHome(document);
  const describeInput = document.querySelector('.describe-box input[type="text"]');
  describeInput.value = "Vaso in ceramica";
  clickByText(document, ".describe-box button", "→");

  await wait(150);
  assert.ok(document.querySelector(".dest-field-block"), "deve essere arrivato a DestinationScreen");
  clickByText(document, "button", "Analizza e calcola il prezzo →");

  await wait(150);
  assert.ok(document.querySelector(".result-card"), "deve essere arrivato a ResultScreen dopo la classificazione mockata");

  // La chiamata a estimate-duty parte da runClassification() ma non è mai
  // attesa (vedi MANUALE.md, vincolo "mai bloccante") — un'attesa breve
  // qui lascia al mock il tempo di risolversi PRIMA di procedere, così il
  // test verifica il caso "la stima è già arrivata quando si conferma
  // l'acquisto", lo scenario realistico più comune.
  await wait(100);

  clickByText(document, "button", "Genera QR code →");
  clickByText(document, "button", "Conferma e genera QR →");
  await wait(800); // setTimeout(…, 700) prima della costruzione dell'item in app.js

  assert.equal(savedPurchases.length, 1, "save-purchase deve essere stato chiamato una volta");
  return savedPurchases[0];
}

// ---------------------------------------------------------------------
// (1) Una stima disponibile viene persistita correttamente
// ---------------------------------------------------------------------

test("una stima dazi disponibile al momento del salvataggio viene persistita ESATTAMENTE su item.dutyEstimateShown", async (t) => {
  const item = await runToSavedPurchase(t, "success");
  assert.equal(item.dutyEstimateShown, ESTIMATE_TEXT, "il testo salvato deve essere identico a quello mostrato al turista in ResultScreen");
});

// ---------------------------------------------------------------------
// (2) Nessuna stima disponibile (fallita) -> null, nessun errore
// ---------------------------------------------------------------------

test("un errore HTTP nella chiamata a estimate-duty non impedisce l'acquisto e salva dutyEstimateShown: null", async (t) => {
  const item = await runToSavedPurchase(t, "http-error");
  assert.equal(item.dutyEstimateShown, null, "una stima fallita deve salvare null, mai un valore inventato o un errore che blocchi il salvataggio");
});

test("un errore di rete nella chiamata a estimate-duty non impedisce l'acquisto e salva dutyEstimateShown: null", async (t) => {
  const item = await runToSavedPurchase(t, "network-error");
  assert.equal(item.dutyEstimateShown, null);
});

// ---------------------------------------------------------------------
// (3) Nessuna influenza sul prezzo — stesso test di isolamento richiesto,
//     verificato anche qui a livello di payload effettivamente inviato.
// ---------------------------------------------------------------------

test("il prezzo dell'acquisto (item.price) è identico con o senza una stima dazi disponibile — dutyEstimateShown non influenza in alcun modo il prezzo calcolato", async (t) => {
  const withEstimate = await runToSavedPurchase(t, "success");
  const withoutEstimate = await runToSavedPurchase(t, "network-error");
  assert.equal(withEstimate.price, withoutEstimate.price, "stesso oggetto, stessa destinazione, stesso prezzo — la sola presenza/assenza della stima dazi non deve mai cambiarlo");
});
