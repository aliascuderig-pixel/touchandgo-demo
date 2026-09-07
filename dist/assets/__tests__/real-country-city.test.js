// Verifica il nuovo campo "paese/città reali" (ISO_COUNTRIES) raccolto in
// AddressFormFields() e propagato come item.country/item.city sull'acquisto
// — cambio richiesto per registrare una destinazione reale e specifica,
// invece del solo vocabolario chiuso a 9 valori DESTINATIONS (che resta
// INVARIATO e continua a determinare solo la zona di tariffazione, vedi
// MANUALE.md, sezione "Paese e città reali della spedizione").
//
// Tre livelli di verifica:
// 1) unità — AddressFormFields/readAddressForm/isKnownRealCountry, chiamate
//    direttamente (sono "function" top-level, quindi proprietà di window
//    nel contesto vm — vedi convenzione già usata in questo repo).
// 2) integrazione — il gate di salvataggio in IdentifyScreen e
//    AddAddressScreen blocca un paese reale mancante/non valido, DOM reale.
// 3) end-to-end — flusso di acquisto completo (Home -> descrivi -> classify
//    mockata -> destinazione -> conferma indirizzo) fino al payload
//    effettivamente inviato a /.netlify/functions/save-purchase, più il
//    caso di fallback per un indirizzo storico privo di realCountry.

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

function makeFetchMock({ onSavePurchase } = {}) {
  return (url, opts) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/classify")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: [{ text: JSON.stringify(CLASSIFY_RESULT) }] }),
      });
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/estimate-duty")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/save-purchase")) {
      if (onSavePurchase) onSavePurchase(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.reject(new Error("network disabled in test: " + url));
  };
}

// ---------------------------------------------------------------------
// 1) Unità: AddressFormFields / readAddressForm / isKnownRealCountry
// ---------------------------------------------------------------------

test("AddressFormFields: aggiunge un campo paese reale (autocomplete via datalist) separato dal selettore zona/prezzo esistente", (t) => {
  const { window, document } = bootApp(t);
  const wrap = window.AddressFormFields("test");
  document.body.appendChild(wrap);

  const realCountryInput = document.getElementById("test-realcountry");
  assert.ok(realCountryInput, "deve esserci un input per il paese reale");
  assert.equal(realCountryInput.tagName, "INPUT", "deve essere un input di testo, non una <select> a tendina");
  assert.equal(realCountryInput.getAttribute("list"), "test-realcountry-list");

  const datalist = document.getElementById("test-realcountry-list");
  assert.ok(datalist, "deve esserci il <datalist> con le opzioni paese");
  const options = Array.from(datalist.querySelectorAll("option")).map((o) => o.value);
  assert.ok(options.includes("Francia"), "un paese reale come la Francia deve essere selezionabile");
  assert.ok(options.includes("Brasile"), "copertura ampia, non solo i 9 valori di DESTINATIONS");
  assert.ok(options.length > 100, "elenco ISO 3166 completo, non un sottoinsieme ridotto (trovate " + options.length + " opzioni)");

  // Il selettore a 9 zone/prezzo esistente resta presente e INVARIATO.
  const zoneSelect = document.getElementById("test-country");
  assert.ok(zoneSelect, "il selettore a 9 zone/prezzo deve restare presente, invariato");
  assert.equal(zoneSelect.querySelectorAll("option").length, 9);
});

test("readAddressForm: legge il nuovo campo realCountry insieme agli altri", (t) => {
  const { window, document } = bootApp(t);
  document.body.appendChild(window.AddressFormFields("test"));
  document.getElementById("test-street").value = "Via Dante 5";
  document.getElementById("test-city").value = "Bologna";
  document.getElementById("test-cap").value = "40100";
  document.getElementById("test-country").value = "Italia";
  document.getElementById("test-realcountry").value = "Italia";

  const addr = window.readAddressForm("test");
  assert.equal(addr.street, "Via Dante 5");
  assert.equal(addr.city, "Bologna");
  assert.equal(addr.cap, "40100");
  assert.equal(addr.country, "Italia");
  assert.equal(addr.realCountry, "Italia");
});

test("isKnownRealCountry: valida solo un paese reale della lista ISO, indipendente da DESTINATIONS", (t) => {
  const { window } = bootApp(t);
  assert.equal(window.isKnownRealCountry("Francia"), true);
  assert.equal(window.isKnownRealCountry("Brasile"), true);
  // "Unione Europea" è un blocco valido per il selettore zona/prezzo
  // (DESTINATIONS) ma NON è un paese reale — dimostra la separazione tra
  // i due elenchi.
  assert.equal(window.isKnownRealCountry("Unione Europea"), false);
  assert.equal(window.isKnownRealCountry(""), false);
  assert.equal(window.isKnownRealCountry("Paese inventato xyz"), false);
  assert.equal(window.isKnownRealCountry(undefined), false);
});

// ---------------------------------------------------------------------
// 2) + 3) Integrazione ed end-to-end: gate di salvataggio e propagazione
//    sull'item acquisto, in un unico flusso coerente (nuovo utente, nessun
//    indirizzo salvato in precedenza).
// ---------------------------------------------------------------------

test("flusso completo: gate blocca un paese reale mancante, poi propaga country/city sull'acquisto salvato", async (t) => {
  const savedPurchases = [];
  const { document } = bootApp(t, {
    // Dispositivo già onboardato in passato ma senza alcun profilo/indirizzo
    // salvato — evita la schermata di onboarding linguistico (irrilevante
    // qui) e mette a fuoco il caso reale sotto test: primo indirizzo mai
    // inserito su questo account.
    seedLocalStorage: (ls) => ls.setItem("tg_onboarded", "1"),
    fetchMock: makeFetchMock({ onSavePurchase: (item) => savedPurchases.push(item) }),
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
  clickByText(document, "button", "Genera QR code →");

  // Nessun indirizzo salvato: ChooseAddressScreen mostra solo il riepilogo
  // guest, non la lista indirizzi — il bottone conferma reindirizza subito
  // a IdentifyScreen perché manca state.touristName.
  clickByText(document, "button", "Conferma e genera QR →");
  assert.ok(document.querySelector(".identify-screen"), "senza nome/email deve reindirizzare a IdentifyScreen");

  document.getElementById("name-input").value = "Turista Paese Reale";
  document.getElementById("email-input").value = "paesereale@example.com";
  document.getElementById("identify-street").value = "Rue de Rivoli 10";
  document.getElementById("identify-city").value = "Parigi";
  document.getElementById("identify-cap").value = "75001";
  document.getElementById("identify-country").value = "Unione Europea"; // zona/prezzo, invariato

  // Paese reale mancante: il salvataggio deve essere bloccato, resta su
  // IdentifyScreen.
  clickByText(document, ".identify-screen .btn-primary", "Salva e continua →");
  assert.ok(document.querySelector(".identify-screen"), "senza un paese reale valido il salvataggio deve essere bloccato");

  // Testo non riconosciuto (l'autocomplete via datalist non impedisce di
  // digitare testo libero non corrispondente a nessuna opzione): bloccato
  // allo stesso modo.
  document.getElementById("identify-realcountry").value = "Paese che non esiste";
  clickByText(document, ".identify-screen .btn-primary", "Salva e continua →");
  assert.ok(document.querySelector(".identify-screen"), "un paese reale non riconosciuto deve restare bloccato");

  // Paese reale valido: ora procede.
  document.getElementById("identify-realcountry").value = "Francia";
  clickByText(document, ".identify-screen .btn-primary", "Salva e continua →");
  assert.equal(document.querySelector(".identify-screen"), null, "con un paese reale valido il salvataggio deve procedere");

  const savedProfile = JSON.parse(document.defaultView.localStorage.getItem("tg_profile"));
  assert.equal(savedProfile.addresses.length, 1);
  assert.equal(savedProfile.addresses[0].realCountry, "Francia");
  assert.equal(savedProfile.addresses[0].city, "Parigi");
  assert.equal(savedProfile.addresses[0].country, "Unione Europea", "il selettore zona/prezzo resta un campo distinto, invariato");

  // Torna su ChooseAddressScreen (addAddressReturnTo) con l'indirizzo ora
  // selezionato: conferma finale.
  clickByText(document, "button", "Conferma e genera QR →");
  await wait(800); // setTimeout(…, 700) prima della costruzione dell'item in app.js

  assert.equal(savedPurchases.length, 1, "save-purchase deve essere stato chiamato una volta");
  const item = savedPurchases[0];
  assert.equal(item.country, "Francia", "il paese reale strutturato deve finire sull'item acquisto");
  assert.equal(item.city, "Parigi", "la città reale strutturata deve finire sull'item acquisto");
  assert.ok(item.addressLabel.includes("Parigi"), "addressLabel resta generato come prima, invariato, per compatibilità");
});

test("indirizzo storico senza realCountry (salvato prima di questa modifica): country resta null, nessun blocco, il resto del flusso procede invariato", async (t) => {
  const OLD_ADDRESS = { id: "addr-old-1", label: "Casa", street: "Via Vecchia 1", city: "Torino", cap: "10100", country: "Italia" };
  const savedPurchases = [];
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem(
        "tg_profile",
        JSON.stringify({
          name: "Turista Storico",
          email: "storico@example.com",
          addresses: [OLD_ADDRESS],
          selectedAddressId: OLD_ADDRESS.id,
        })
      );
    },
    fetchMock: makeFetchMock({ onSavePurchase: (item) => savedPurchases.push(item) }),
  });

  goHome(document);
  const describeInput = document.querySelector('.describe-box input[type="text"]');
  describeInput.value = "Borsa in pelle";
  clickByText(document, ".describe-box button", "→");
  await wait(150);
  clickByText(document, "button", "Analizza e calcola il prezzo →");
  await wait(150);
  clickByText(document, "button", "Genera QR code →");

  // Con un indirizzo già presente, ChooseAddressScreen mostra direttamente
  // la lista — la conferma non richiede di ripassare da IdentifyScreen né
  // da AddressFormFields, quindi non c'è alcun nuovo gate su realCountry
  // per un indirizzo storico selezionato così com'è.
  clickByText(document, "button", "Conferma e genera QR →");
  await wait(800);

  assert.equal(savedPurchases.length, 1);
  const item = savedPurchases[0];
  assert.equal(item.country, null, "un indirizzo storico privo di realCountry non deve inventare un paese");
  assert.equal(item.city, "Torino", "la città era già un campo esistente sull'indirizzo, quindi resta popolata");
  assert.ok(item.addressLabel.includes("Torino"), "il fallback addressLabel resta l'unica fonte per i dati storici (vedi parseDestination in PR #17)");
});

test("AddAddressScreen (secondo indirizzo, prefix newaddr): stesso gate su realCountry", async (t) => {
  const EXISTING_ADDRESS = { id: "addr-e1", label: "Casa", street: "Via Roma 1", city: "Roma", cap: "00100", country: "Italia", realCountry: "Italia" };
  const { document } = bootApp(t, {
    seedLocalStorage: (ls) => {
      ls.setItem(
        "tg_profile",
        JSON.stringify({
          name: "Turista Due Indirizzi",
          email: "due@example.com",
          addresses: [EXISTING_ADDRESS],
          selectedAddressId: EXISTING_ADDRESS.id,
        })
      );
    },
    fetchMock: makeFetchMock(),
  });

  goHome(document);
  const describeInput = document.querySelector('.describe-box input[type="text"]');
  describeInput.value = "Cappello di paglia";
  clickByText(document, ".describe-box button", "→");
  await wait(150);
  clickByText(document, "button", "Analizza e calcola il prezzo →");
  await wait(150);
  clickByText(document, "button", "Genera QR code →");

  clickByText(document, "button", "+ Aggiungi un nuovo indirizzo");
  assert.ok(document.getElementById("newaddr-realcountry"), "deve essere arrivato ad AddAddressScreen con il nuovo campo");

  document.getElementById("newaddr-label").value = "Ufficio";
  document.getElementById("newaddr-street").value = "Baker Street 221B";
  document.getElementById("newaddr-city").value = "Londra";
  document.getElementById("newaddr-cap").value = "NW16XE";
  document.getElementById("newaddr-country").value = "Regno Unito";

  clickByText(document, "button", "Salva indirizzo →");
  assert.ok(document.getElementById("newaddr-realcountry"), "senza paese reale valido resta su AddAddressScreen");

  document.getElementById("newaddr-realcountry").value = "Regno Unito";
  clickByText(document, "button", "Salva indirizzo →");
  assert.equal(document.getElementById("newaddr-realcountry"), null, "con un paese reale valido procede");

  const savedProfile = JSON.parse(document.defaultView.localStorage.getItem("tg_profile"));
  assert.equal(savedProfile.addresses.length, 2);
  assert.equal(savedProfile.addresses[1].realCountry, "Regno Unito");
  assert.equal(savedProfile.addresses[1].city, "Londra");
});
