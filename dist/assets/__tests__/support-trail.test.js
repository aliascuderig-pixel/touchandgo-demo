// Verifica il trail di supporto (assistenza predittiva) in app.js: la
// raccolta locale di un breve storico di schermate/azioni del turista,
// primo pezzo del futuro sistema di ticket assistenza predittivo (vedi
// MANUALE.md, sezione "Trail di supporto (assistenza predittiva)").
//
// Copre, in quest'ordine:
//   1. recordScreenChange()/render() — il trail accumula una voce "screen"
//      ad ogni cambio REALE di state.screen, mai un duplicato quando si
//      ri-renderizza la stessa schermata.
//   2. Le azioni specifiche vengono registrate con il label corretto, nei
//      punti reali del codice (non simulati): handleImageDataUrl(),
//      applyPartnerDiscountCode(), submitReview(), il click su "Genera QR"
//      in ChooseAddressScreen, "Conferma e paga" in ConcludeScreen,
//      "Richiedi ritiro" in PurchaseHistoryList/HistoryScreen.
//   3. Il testo di un errore reale (offline E fallimento classificazione)
//      finisce nel trail, con lo stesso testo mostrato al turista.
//   4. VINCOLO DI PRIVACY — punto critico: un'email di test realmente
//      digitata/salvata nel profilo del turista non compare MAI in
//      nessuna voce del trail, nemmeno dopo un flusso completo che genera
//      un QR per un oggetto (che scrive quell'email sull'item salvato).
//      Stesso principio verificato anche per nome e indirizzo.
//   5. Limite di 15 voci: le più vecchie escono quando se ne aggiunge una
//      nuova oltre il limite.
//
// Stessa tecnica di real-country-city.test.js: app.js REALE caricato in
// una finestra jsdom isolata via vm.runInContext (app.js non è un modulo
// CommonJS — referenzia document/localStorage a livello di script).
//
// Nota tecnica: "state" e "TRAIL_MAX_ENTRIES" sono dichiarati con
// const/let a livello di script in app.js — in un browser (e allo stesso
// modo qui, via vm.runInContext) questo li rende accessibili come
// identificatori bare nel contesto globale, ma NON come proprietà
// dell'oggetto window (a differenza delle "function" dichiarate con
// `function nome() {}`, che diventano entrambe le cose). Per questo le
// funzioni si chiamano via window.<nome>(...) ma lo stato si legge/scrive
// eseguendo codice nel context via setState()/getState() sotto.

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
  // Onboarding già visto -> arriva dritto a "home", stesso trucco già usato
  // in real-country-city.test.js per non dover attraversare le slide di
  // onboarding in ogni test.
  window.localStorage.setItem("tg_onboarded", "1");
  if (seedLocalStorage) seedLocalStorage(window.localStorage);

  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });

  return { window, document: window.document, context };
}

// state è dichiarato con "const" in app.js: accessibile come identificatore
// bare nel context (stessa realm), non come window.state — vedi nota sopra.
function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}
function getState(context, expr) {
  return vm.runInContext(`state.${expr}`, context, { filename: "get-state.js" });
}
function getGlobal(context, name) {
  return vm.runInContext(name, context, { filename: "get-global.js" });
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

// ---------------------------------------------------------------------
// 1. Accumulo del trail sui cambi schermata
// ---------------------------------------------------------------------

test("il trail accumula una voce 'screen' ad ogni cambio REALE di state.screen", async (t) => {
  const { window, context } = bootApp(t);
  const before = window.getRecentTrail().length;

  setState(context, { screen: "history" });
  window.render();
  setState(context, { screen: "dashboard" });
  window.render();

  const trail = window.getRecentTrail();
  assert.equal(trail.length, before + 2, "due cambi di schermata reali -> due nuove voci");
  assert.equal(trail[trail.length - 2].type, "screen");
  assert.equal(trail[trail.length - 2].label, "Storico");
  assert.equal(trail[trail.length - 1].type, "screen");
  assert.equal(trail[trail.length - 1].label, "Dashboard");
  assert.ok(trail[trail.length - 1].at, "ogni voce ha un timestamp");
  assert.ok(!Number.isNaN(Date.parse(trail[trail.length - 1].at)), "il timestamp è un ISO valido");
});

test("render() ripetuto sulla STESSA schermata non duplica la voce 'screen'", async (t) => {
  const { window, context } = bootApp(t);
  setState(context, { screen: "history" });
  window.render();
  const afterFirst = window.getRecentTrail().length;

  // Tre render successivi senza cambiare screen (com'è normale: render()
  // viene richiamato molto più spesso di quanto cambi la schermata).
  window.render();
  window.render();
  window.render();

  assert.equal(window.getRecentTrail().length, afterFirst, "nessuna voce aggiuntiva senza un cambio reale di schermata");
});

// ---------------------------------------------------------------------
// 2. Azioni specifiche — label corretto, agganciate ai punti reali del codice
// ---------------------------------------------------------------------

test("handleImageDataUrl(): foto caricata/scattata registrata con il label corretto", async (t) => {
  const { window } = bootApp(t);
  window.handleImageDataUrl("data:image/jpeg;base64,AAAA", "image/jpeg");
  const trail = window.getRecentTrail();
  const entry = trail.find((e) => e.type === "action" && e.label === "Foto caricata/scattata");
  assert.ok(entry, "deve esserci una voce action 'Foto caricata/scattata'");
});

test("applyPartnerDiscountCode(): 'Codice partner inserito' registrato con label generico, MAI il codice reale", async (t) => {
  const { window } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ valid: false, error: "Codice non valido" }) }),
  });
  await window.applyPartnerDiscountCode("SEGRETO123", 10);
  const trail = window.getRecentTrail();
  const entry = trail.find((e) => e.type === "action" && e.label === "Codice partner inserito");
  assert.ok(entry, "deve esserci una voce action 'Codice partner inserito'");
  assert.ok(
    !JSON.stringify(trail).includes("SEGRETO123"),
    "il codice partner reale non deve MAI comparire in nessuna voce del trail"
  );
});

test("submitReview(): recensione inviata con successo registrata", async (t) => {
  const { window, context } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
  });
  setState(context, { reviewDraftRating: 5, reviewDraftText: "Ottimo servizio" });
  await window.submitReview({ id: "TG-000001" });
  const trail = window.getRecentTrail();
  const entry = trail.find((e) => e.type === "action" && e.label === "Recensione inviata");
  assert.ok(entry, "deve esserci una voce action 'Recensione inviata'");
});

test("submitReview(): un invio FALLITO non registra 'Recensione inviata' (la voce è solo per il successo)", async (t) => {
  const { window, context } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "Errore server" }) }),
  });
  setState(context, { reviewDraftRating: 3 });
  const before = window.getRecentTrail().length;
  await window.submitReview({ id: "TG-000002" });
  const trail = window.getRecentTrail();
  assert.equal(trail.length, before, "nessuna nuova voce quando l'invio della recensione fallisce");
});

test("ChooseAddressScreen: click su 'Conferma e genera QR' registra 'QR generato per un oggetto'", async (t) => {
  const { window, document, context } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
  });
  setState(context, {
    touristName: "Turista Test",
    result: { object_name: "Vaso", hs_code: "6913.90", weight_kg: 1, length_cm: 10, width_cm: 10, height_cm: 10, value_eur: 30 },
    price: { grandTotal: 30 },
    addresses: [{ id: "addr-1", label: "Casa", street: "Via Test 1", cap: "00100", city: "Roma", country: "Italia" }],
    selectedAddressId: "addr-1",
    screen: "choose-address",
  });
  window.render();

  const confirmBtn = findButtonContaining(document, "Conferma e genera QR");
  assert.ok(confirmBtn, "deve esistere il bottone di conferma");
  confirmBtn.click();
  await wait(800); // stesso setTimeout(…, 700) del codice reale

  const trail = window.getRecentTrail();
  const entry = trail.find((e) => e.type === "action" && e.label === "QR generato per un oggetto");
  assert.ok(entry, "deve esserci una voce action 'QR generato per un oggetto'");
});

test("ConcludeScreen: click su 'Conferma e paga' registra 'Concludi e paga cliccato'", async (t) => {
  const { window, document, context } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
  });
  setState(context, { pendingItems: [], screen: "conclude" });
  window.render();

  const confirmBtn = findButtonContaining(document, "Conferma e paga");
  assert.ok(confirmBtn, "deve esistere il bottone 'Conferma e paga'");
  confirmBtn.click();

  const trail = window.getRecentTrail();
  const entry = trail.find((e) => e.type === "action" && e.label === "Concludi e paga cliccato");
  assert.ok(entry, "il click deve essere registrato SUBITO, anche se poi la verifica identità blocca il resto del flusso");
});

test("HistoryScreen: click su 'Richiedi ritiro' registra 'Richiedi ritiro cliccato'", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, {
    purchaseHistory: [
      {
        id: "TG-000003",
        objectName: "Borsa",
        pickupPoint: "Negozio Test",
        hsCode: "4202.21",
        addressLabel: "Via Test 1, Roma, Italia",
        price: 25,
        status: "in confezionamento",
      },
    ],
    screen: "history",
  });
  window.render();

  const pickupBtn = findButtonByText(document, "📦 Richiedi ritiro");
  assert.ok(pickupBtn, "deve esistere il bottone 'Richiedi ritiro' per un acquisto 'in confezionamento'");
  pickupBtn.click();

  const trail = window.getRecentTrail();
  const entry = trail.find((e) => e.type === "action" && e.label === "Richiedi ritiro cliccato");
  assert.ok(entry, "il click deve essere registrato");
});

// ---------------------------------------------------------------------
// 3. Il testo di un errore reale finisce nel trail
// ---------------------------------------------------------------------

// Prima della modifica di settembre 2026 (percorso offline — vedi
// MANUALE.md), un click su "Analizza" mentre offline bloccava con un
// errore permanente (state.error, mai possibile proseguire). Ora offre
// invece il percorso di classificazione provvisoria: nessun errore, il
// trail registra un'azione, non un "Errore: ...". Vedi anche
// offline-classify.test.js per la verifica end-to-end di quel percorso.
test("DestinationScreen: un click su Analizza mentre offline apre il percorso provvisorio, nessun errore nel trail", async (t) => {
  const { window, document, context } = bootApp(t);
  setState(context, {
    pendingInput: { type: "text", label: "un oggetto qualsiasi" },
    isOffline: true,
    screen: "destination",
  });
  window.render();

  const goBtn = findButtonContaining(document, "Analizza e calcola il prezzo");
  assert.ok(goBtn, "deve esistere il bottone di avvio classificazione");
  goBtn.click();

  assert.equal(getState(context, "error"), null, "non deve più essere mostrato come un errore bloccante");
  assert.equal(getState(context, "screen"), "offline-classify", "deve passare al selettore di categoria offline");
  const trail = window.getRecentTrail();
  const errorEntry = trail.find((e) => e.type === "action" && /^Errore:/.test(e.label));
  assert.ok(!errorEntry, "nessuna voce 'Errore:' nel trail per questo percorso, non è più un errore");
  const actionEntry = trail.find((e) => e.type === "action" && /percorso di classificazione provvisoria/i.test(e.label));
  assert.ok(actionEntry, "il trail deve comunque registrare che si è passati al percorso provvisorio");
});

test("runClassification(): un fallimento di classificazione registra il testo dell'errore mostrato", async (t) => {
  const { window, context } = bootApp(t);
  await window.runClassification(Promise.reject(new Error("Errore di rete generico, non 401")));

  const errorText = getState(context, "error");
  assert.ok(errorText, "state.error deve essere valorizzato dopo il fallimento");
  const trail = window.getRecentTrail();
  const entry = trail.find((e) => e.type === "action" && e.label === "Errore: " + errorText);
  assert.ok(entry, "il testo dell'errore di classificazione deve comparire nel trail");
});

// ---------------------------------------------------------------------
// 4. VINCOLO DI PRIVACY — nessun dato sensibile finisce mai in un label
// ---------------------------------------------------------------------

test("PRIVACY: un'email di test realmente salvata sul profilo non compare MAI nel trail, nemmeno dopo un flusso completo fino al QR", async (t) => {
  const SENSITIVE_EMAIL = "trail-privacy-test@example.com";
  const SENSITIVE_NAME = "Mario Rossi Riservatissimo";
  const SENSITIVE_STREET = "Via Segretissima 42";

  const { window, document, context } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
  });

  // 1) Foto "caricata" — azione registrata, nessun dato personale coinvolto.
  window.handleImageDataUrl("data:image/jpeg;base64,AAAA", "image/jpeg");

  // 2) Risultato di classificazione simulato (bypassa la chiamata AI reale,
  //    fuori scope qui) e passaggio a Result -> Scegli indirizzo. pendingInput
  //    viene riportato a type:"text" qui: con type:"image" il click di
  //    conferma più sotto passerebbe da compressImage() (new Image().onload),
  //    che jsdom non risolve mai per un data URL fittizio — irrilevante per
  //    quello che sta verificando QUESTO test (la fuga di dati sensibili),
  //    quindi evitato per non appendere il test a un dettaglio non pertinente.
  setState(context, {
    pendingInput: { type: "text", label: "oggetto generico" },
    result: { object_name: "Vaso", hs_code: "6913.90", weight_kg: 1, length_cm: 10, width_cm: 10, height_cm: 10, value_eur: 30 },
    price: { grandTotal: 30 },
    screen: "result",
  });
  window.render();

  // 3) Identità e indirizzo REALMENTE presenti in stato con dati sensibili
  //    di prova (equivalente, ai fini di questo test, a un turista che li
  //    ha appena digitati in IdentifyScreen/AddAddressScreen).
  setState(context, {
    touristName: SENSITIVE_NAME,
    touristEmail: SENSITIVE_EMAIL,
    addresses: [{ id: "addr-1", label: "Casa", street: SENSITIVE_STREET, cap: "00100", city: "Roma", country: "Italia" }],
    selectedAddressId: "addr-1",
    screen: "choose-address",
  });
  window.render();

  const confirmBtn = findButtonContaining(document, "Conferma e genera QR");
  assert.ok(confirmBtn);
  confirmBtn.click();
  await wait(800);

  // L'item salvato realmente contiene l'email/nome/via (verifica di
  // controllo: se questo fallisse, il test sotto sarebbe vuoto di
  // significato — dimostra che i dati sensibili SONO nel sistema, solo
  // non nel trail).
  const pendingItems = getState(context, "pendingItems");
  const savedItem = pendingItems[pendingItems.length - 1];
  assert.equal(savedItem.touristName, SENSITIVE_NAME);
  assert.ok(savedItem.addressLabel.includes(SENSITIVE_STREET));

  // 4) Anche una recensione, con testo libero scritto dal turista.
  setState(context, {
    reviewDraftRating: 4,
    reviewDraftText: `Consegnato a ${SENSITIVE_STREET}, contattatemi su ${SENSITIVE_EMAIL}`,
  });
  await window.submitReview(savedItem);

  const trailJson = JSON.stringify(window.getRecentTrail());
  assert.ok(!trailJson.includes(SENSITIVE_EMAIL), "l'email non deve MAI comparire nel trail");
  assert.ok(!trailJson.includes(SENSITIVE_NAME), "il nome non deve MAI comparire nel trail");
  assert.ok(!trailJson.includes(SENSITIVE_STREET), "l'indirizzo non deve MAI comparire nel trail");
  assert.ok(!trailJson.includes(SENSITIVE_STREET.split(" ")[1]), "nemmeno un frammento del testo libero della recensione deve trapelare");

  // Controllo positivo: il trail comunque esiste e si è popolato con le
  // azioni/schermate attese (non è vuoto per un motivo sbagliato, es. un
  // crash silenzioso).
  const trail = window.getRecentTrail();
  assert.ok(trail.some((e) => e.label === "Foto caricata/scattata"));
  assert.ok(trail.some((e) => e.label === "QR generato per un oggetto"));
  assert.ok(trail.some((e) => e.label === "Recensione inviata"));
  assert.ok(trail.some((e) => e.type === "screen" && e.label === "Risultato"));
  assert.ok(trail.some((e) => e.type === "screen" && e.label === "Scegli indirizzo"));
});

// ---------------------------------------------------------------------
// 5. Limite di 15 voci
// ---------------------------------------------------------------------

test("il trail resta troncato alle ultime 15 voci — le più vecchie escono", async (t) => {
  const { window, context } = bootApp(t);
  assert.equal(getGlobal(context, "TRAIL_MAX_ENTRIES"), 15, "il test assume il limite attuale di 15 — se cambia, va aggiornato qui");

  // 20 cambi di schermata distinti in sequenza (alternando due valori, così
  // ognuno è sempre un cambio REALE rispetto al precedente).
  for (let i = 0; i < 20; i++) {
    setState(context, { screen: i % 2 === 0 ? "history" : "dashboard" });
    window.render();
  }

  const trail = window.getRecentTrail();
  assert.equal(trail.length, 15, "mai più di TRAIL_MAX_ENTRIES voci, qualunque sia il numero di eventi generati");
  // 20 iterazioni (indici 0..19), alternanza history(pari)/dashboard(dispari)
  // -> 20 voci generate, poi troncate alle ultime 15: sopravvivono gli
  // indici 5..19. L'indice 5 (dispari) e l'indice 19 (dispari) sono
  // entrambi "dashboard".
  assert.equal(trail[0].label, "Dashboard", "la voce più vecchia rimasta (indice 5 delle 20 generate) deve essere quella corretta, non una a caso");
  assert.equal(trail[14].label, "Dashboard", "l'ultima voce generata (indice 19 delle 20) deve essere ancora presente, invariata");
});

test("getRecentTrail() restituisce una COPIA, non il riferimento interno", async (t) => {
  const { window, context } = bootApp(t);
  setState(context, { screen: "history" });
  window.render();
  const trail = window.getRecentTrail();
  trail.push({ type: "action", label: "manomissione esterna", at: new Date().toISOString() });
  const trailAgain = window.getRecentTrail();
  assert.ok(
    !trailAgain.some((e) => e.label === "manomissione esterna"),
    "mutare l'array restituito non deve mai alterare il trail interno"
  );
});
