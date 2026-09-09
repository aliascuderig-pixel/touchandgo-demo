// Verifica "Genera spedizione" / "Spedizioni generate" — nuovo spazio
// dentro l'area partner GIÀ loggata (stesso ?mode=partner, stesso codice
// di accesso, NESSUN nuovo login/account) per generare spedizioni per
// conto di clienti finali. Vedi MANUALE.md per la descrizione completa.
//
// Punti richiesti, verificati end-to-end sul vero app.js caricato in una
// finestra jsdom isolata (stessa tecnica di real-country-city.test.js):
// (a) una spedizione generata da un partner ha sempre generatedByPartnerCode
//     valorizzato con quel codice esatto;
// (b) il pricingTier applicato corrisponde esattamente a quanto restituito
//     da PARTNER_PLAN_TO_PRICING_TIER per il piano di quel partner;
// (c) il client richiede lo storico "Spedizioni generate" passando il
//     proprio codice partner (l'isolamento vero e proprio, server-side, è
//     già verificato in netlify/functions/__tests__/sync.generated-shipments.test.js
//     — qui si verifica che il client non lo aggiri in alcun modo, es.
//     provando a leggere lo storico di un altro codice);
// (d) un acquisto turista self-service ordinario (percorso home) non ha
//     mai questo campo.
//
// Più: la costante PARTNER_PLAN_TO_PRICING_TIER copre i 7 piani REALI
// esistenti in netlify/functions/sync.js (PARTNER_PLANS), non i 3 nomi
// Free/Boutique/Flagship usati solo come esempio illustrativo.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, "utf8");

// Image/canvas fittizi: jsdom non implementa la decodifica reale di
// immagini né HTMLCanvasElement.getContext("2d") senza il pacchetto
// "canvas" — stessa tecnica già usata in identity-verification-pickup.test.js
// per compressImage() (chiamata invariata anche da submitPartnerGeneratedShipment).
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

function bootPartnerApp(t, { fetchMock } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/?mode=partner",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = fetchMock || (() => Promise.reject(new Error("network disabled in test")));
  installFakeImageAndCanvas(window);
  window.localStorage.setItem("tg_lang", "it");
  window.localStorage.setItem("tg_onboarded", "1");
  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });
  return { window, document: window.document };
}

function clickByText(document, selector, text) {
  const match = Array.from(document.querySelectorAll(selector)).find((e) => e.textContent.trim() === text);
  if (!match) throw new Error(`Nessun elemento "${selector}" con testo "${text}"`);
  match.click();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FAKE_CLASSIFY_RESULT = {
  object_it: "Borsa in pelle",
  object_en: "Leather bag",
  hs_code: "420221",
  hs_description_it: "Borsa in pelle",
  category: "Accessori Moda",
  material: "pelle",
  weight_kg: 1.5,
  length_cm: 30,
  width_cm: 20,
  height_cm: 15,
  value_eur: 200,
  fragile: false,
  confidence: "alta",
};

function makeFetchMock({ partnerPlan = "boutique", onSavePurchase, onListGenerated, generatedItemsToReturn } = {}) {
  return (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (typeof url === "string" && url.includes("/.netlify/functions/partner-stats")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            valid: true,
            partnerName: "Boutique Test",
            plan: partnerPlan,
            paid: true,
            access: { blocked: false },
            salesCount: 3,
            totalSalesValue: 150,
            totalCommission: 15,
            creditBalance: 5,
            monthlyBreakdown: [],
            recentOrders: [],
          }),
      });
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/classify")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: [{ text: JSON.stringify(FAKE_CLASSIFY_RESULT) }] }),
      });
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/save-purchase")) {
      if (onSavePurchase) onSavePurchase(body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/sync")) {
      if (body.action === "list-generated-shipments") {
        if (onListGenerated) onListGenerated(body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: generatedItemsToReturn || [] }) });
      }
    }
    return Promise.reject(new Error("network disabled in test: " + url));
  };
}

async function loginAsPartner(document, code) {
  document.getElementById("partner-code-input").value = code;
  clickByText(document, "button", "Accedi");
  await wait(50);
}

// Simula davvero la selezione di un file dal vero <input type="file">
// (jsdom supporta File/FileReader) invece di richiamare le funzioni interne
// — passa dallo stesso evento "change" già collegato da
// PartnerGenerateShipmentScreen(), esattamente come farebbe un operatore
// reale al PC che seleziona una foto già scattata.
async function uploadFakePhoto(window, document) {
  const input = document.getElementById("partner-generate-file");
  const file = new window.File(["contenuto finto"], "oggetto.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { value: [file], writable: false });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(50);
}

// ---------------------------------------------------------------------
// Unità: la mappatura piano -> pricingTier
// ---------------------------------------------------------------------

test("pricingTierForPartnerPlan copre i 7 piani REALI di PARTNER_PLANS (sync.js), non solo l'esempio Free/Boutique/Flagship, tutti su 'pieno' oggi", (t) => {
  const { window } = bootPartnerApp(t);
  const REAL_PLAN_KEYS = ["boutique", "enoteche", "sport", "hotel", "agenzie", "touroperator", "free"];
  for (const key of REAL_PLAN_KEYS) {
    assert.equal(window.pricingTierForPartnerPlan(key), "pieno", `oggi ogni piano reale deve mappare provvisoriamente su "pieno" (${key})`);
  }
  // I nomi usati solo come esempio illustrativo nella richiesta originaria
  // (Free/Boutique/Flagship) non sono le chiavi REALI salvo "free"/"boutique",
  // che infatti esistono già sopra — "flaghip" non esiste in PARTNER_PLANS:
  // un piano sconosciuto ricade comunque sul fallback "pieno", mai un tier
  // scontato per un piano che non riusciamo a identificare con certezza.
  assert.equal(window.pricingTierForPartnerPlan("flagship"), "pieno");
});

test("pricingTierForPartnerPlan: fallback 'pieno' per un piano non riconosciuto (mai un tier scontato per un piano incerto)", (t) => {
  const { window } = bootPartnerApp(t);
  assert.equal(window.pricingTierForPartnerPlan("piano-inesistente"), "pieno");
  assert.equal(window.pricingTierForPartnerPlan(undefined), "pieno");
});

// ---------------------------------------------------------------------
// End-to-end: login partner (nessun nuovo sistema di auth) -> Genera
// spedizione -> foto/classificazione -> dati cliente -> salvataggio
// ---------------------------------------------------------------------

test("flusso completo 'Genera spedizione': generatedByPartnerCode e pricingTier corretti sul payload inviato a save-purchase.js (invariato)", async (t) => {
  const savedPurchases = [];
  const { window, document } = bootPartnerApp(t, {
    fetchMock: makeFetchMock({ partnerPlan: "boutique", onSavePurchase: (item) => savedPurchases.push(item) }),
  });

  assert.ok(document.getElementById("partner-code-input"), "deve avvenire il login con lo STESSO form codice partner esistente, nessun nuovo login");
  await loginAsPartner(document, "BOUTIQUE1");

  assert.ok(document.getElementById("partner-generate-entry-btn"), "deve comparire il nuovo punto d'accesso 'Genera spedizione' nell'area partner già loggata");
  document.getElementById("partner-generate-entry-btn").click();

  assert.ok(document.getElementById("partner-generate-file"), "deve essere arrivato allo spazio dedicato Genera spedizione, con l'upload foto");

  await uploadFakePhoto(window, document);

  assert.ok(document.getElementById("partner-generate-client-name"), "dopo la classificazione deve comparire il modulo dati cliente finale");

  document.getElementById("partner-generate-client-name").value = "Cliente Finale Srl";
  document.getElementById("partner-generate-client-email").value = "cliente@example.com";
  document.getElementById("partner-generate-dest-city").value = "Parigi";
  document.getElementById("partner-generate-dest-realcountry").value = "Francia";
  document.getElementById("partner-generate-dest-country").value = "Unione Europea";

  document.getElementById("partner-generate-submit-btn").click();
  await wait(50);

  assert.equal(savedPurchases.length, 1, "save-purchase.js deve essere stato chiamato esattamente una volta");
  const item = savedPurchases[0];

  // (a) generatedByPartnerCode sempre valorizzato con IL codice del partner
  assert.equal(item.generatedByPartnerCode, "BOUTIQUE1", "generatedByPartnerCode deve essere esattamente il codice del partner che ha generato la spedizione");
  assert.equal(item.partnerCode, undefined, "non deve mai usare item.partnerCode (riservato al meccanismo commissioni/credito esistente)");

  // (b) pricingTier == PARTNER_PLAN_TO_PRICING_TIER[piano del partner]
  const expectedTier = document.defaultView.pricingTierForPartnerPlan("boutique");
  assert.equal(item.pricingTier, expectedTier, "il pricingTier applicato deve corrispondere esattamente a PARTNER_PLAN_TO_PRICING_TIER");
  assert.equal(item.pricingTier, "pieno");

  // Cliente finale sul record, come richiesto (save-purchase.js accetta
  // già qualunque touristName/touristEmail, invariato)
  assert.equal(item.touristName, "Cliente Finale Srl");
  assert.equal(item.touristEmail, "cliente@example.com");
  assert.equal(item.country, "Francia");
  assert.equal(item.city, "Parigi");
  assert.ok(item.price > 0);
});

test("piani diversi mappano comunque tutti su 'pieno' oggi (mappatura provvisoria) — verificato end-to-end anche per un piano diverso da boutique", async (t) => {
  const savedPurchases = [];
  const { window, document } = bootPartnerApp(t, {
    fetchMock: makeFetchMock({ partnerPlan: "touroperator", onSavePurchase: (item) => savedPurchases.push(item) }),
  });
  await loginAsPartner(document, "TOUROP1");
  document.getElementById("partner-generate-entry-btn").click();
  await uploadFakePhoto(window, document);
  document.getElementById("partner-generate-client-name").value = "Altro Cliente";
  document.getElementById("partner-generate-dest-city").value = "Roma";
  document.getElementById("partner-generate-dest-realcountry").value = "Italia";
  document.getElementById("partner-generate-dest-country").value = "Italia";
  document.getElementById("partner-generate-submit-btn").click();
  await wait(50);

  assert.equal(savedPurchases.length, 1);
  assert.equal(savedPurchases[0].pricingTier, "pieno");
  assert.equal(savedPurchases[0].generatedByPartnerCode, "TOUROP1");
});

// ---------------------------------------------------------------------
// "Spedizioni generate": il client interroga sempre e solo il PROPRIO
// codice partner, mai un codice arbitrario/di un altro partner.
// ---------------------------------------------------------------------

test("'Spedizioni generate': la richiesta al server usa sempre il codice del partner loggato, mai un altro", async (t) => {
  let requestedCode = null;
  const OWN_ITEMS = [{ id: "gen-1", touristName: "Cliente Proprio", price: 39, pricingTier: "pieno", status: "in sospeso", objectName: "Vaso", date: new Date().toISOString() }];
  const { document } = bootPartnerApp(t, {
    fetchMock: makeFetchMock({
      partnerPlan: "boutique",
      onListGenerated: (body) => { requestedCode = body.code; },
      generatedItemsToReturn: OWN_ITEMS,
    }),
  });
  await loginAsPartner(document, "BOUTIQUE1");
  document.getElementById("partner-shipments-entry-btn").click();
  await wait(50);

  assert.equal(requestedCode, "BOUTIQUE1", "il client deve chiedere lo storico solo per il proprio codice partner loggato");
  assert.ok(document.body.textContent.includes("Cliente Proprio"), "deve mostrare le proprie spedizioni generate");
});

// ---------------------------------------------------------------------
// (d) Un acquisto turista self-service ordinario non ha mai
//     generatedByPartnerCode — percorso home invariato, in modalità
//     turista (non partner).
// ---------------------------------------------------------------------

test("un acquisto turista self-service (percorso home, modalità turista) non ha mai generatedByPartnerCode", async (t) => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const savedPurchases = [];
  window.fetch = (url, opts) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/classify")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: [{ text: JSON.stringify(FAKE_CLASSIFY_RESULT) }] }) });
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/estimate-duty")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/save-purchase")) {
      savedPurchases.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.reject(new Error("network disabled in test: " + url));
  };
  window.localStorage.setItem("tg_lang", "it");
  window.localStorage.setItem("tg_onboarded", "1");
  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });
  const document = window.document;

  document.querySelector(".cover-screen").click();
  const describeInput = document.querySelector('.describe-box input[type="text"]');
  describeInput.value = "Borsa in pelle";
  clickByText(document, ".describe-box button", "→");
  await wait(150);
  clickByText(document, "button", "Analizza e calcola il prezzo →");
  await wait(150);
  clickByText(document, "button", "Genera QR code →");
  clickByText(document, "button", "Conferma e genera QR →");
  document.getElementById("name-input").value = "Turista Normale";
  document.getElementById("email-input").value = "normale@example.com";
  document.getElementById("identify-street").value = "Via Roma 1";
  document.getElementById("identify-city").value = "Roma";
  document.getElementById("identify-cap").value = "00100";
  document.getElementById("identify-country").value = "Italia";
  document.getElementById("identify-realcountry").value = "Italia";
  clickByText(document, ".identify-screen .btn-primary", "Salva e continua →");
  clickByText(document, "button", "Conferma e genera QR →");
  await wait(800);

  assert.equal(savedPurchases.length, 1);
  assert.equal(savedPurchases[0].generatedByPartnerCode, undefined, "un acquisto turista self-service non deve mai avere questo campo");
});
