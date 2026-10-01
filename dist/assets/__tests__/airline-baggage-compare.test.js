// Verifica il confronto costo bagaglio extra compagnia aerea in
// ConcludeScreen (dist/assets/app.js) — vedi MANUALE.md, sezione
// "Confronto costo bagaglio extra compagnia aerea". Copre, in quest'ordine:
//   1. routeClassForZone()/routeClassForDestinationName() — riuso della
//      zona tariffaria Touch&Go esistente (DESTINATIONS), mai una nuova
//      tabella di zone duplicata.
//   2. findAirlineFeeEntries()/estimateAirlineBaggageCost() — il calcolo
//      del confronto: per_kg_overweight moltiplica per l'intero
//      billableWeight (nessuna franchigia sottratta, vedi report di
//      investigazione concordato), per_extra_piece è un costo fisso
//      indipendente dal peso, variable_by_fare non produce mai un numero.
//   3. Dati mancanti/compagnia non trovata — dataset non ancora arrivato,
//      compagnia assente dal dataset, compagnia presente ma senza alcuna
//      voce per la rotta richiesta: mai un crash, sempre uno stato
//      esplicito gestito.
//   4. Rendering del disclaimer (data di verifica più recente, testo
//      obbligatorio) e della sezione completa in ConcludeScreen, incluso
//      il caso di conversione USD->EUR approssimativa.
//   5. Regressione (ottobre 2026, trovata in revisione): una compagnia con
//      PIÙ voci per la stessa rotta (KLM: per_extra_piece E
//      per_kg_overweight) deve mostrarle ENTRAMBE, mai solo la prima —
//      vedi baggageComparisonsForGroup() (array, non più un singolo
//      oggetto) e i test dedicati KLM più sotto.
//
// Stessa tecnica già usata in consolidated-group-price.test.js/
// duty-estimate.test.js: app.js REALE caricato in una finestra jsdom
// isolata via vm.runInContext, fetch mockato.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

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
  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });
  return { window, document: window.document, context };
}

function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}
function callGlobal(context, expr) {
  return vm.runInContext(expr, context, { filename: "call-global.js" });
}
function flushMicrotasks(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 5); i++) p = p.then(() => Promise.resolve());
  return p;
}

// ---------------------------------------------------------------------
// 1) routeClassForZone()/routeClassForDestinationName() — riuso di
//    DESTINATIONS, nessuna nuova tabella di zone.
// ---------------------------------------------------------------------

test("routeClassForZone(): domestico e transfrontaliero -> eu, worldwide -> intercontinental", (t) => {
  const { context } = bootApp(t);
  assert.equal(callGlobal(context, 'routeClassForZone("domestico")'), "eu");
  assert.equal(callGlobal(context, 'routeClassForZone("transfrontaliero")'), "eu");
  assert.equal(callGlobal(context, 'routeClassForZone("worldwide")'), "intercontinental");
});

test("routeClassForDestinationName(): Italia/UE/UK/Svizzera -> eu, resto del mondo -> intercontinental", (t) => {
  const { context } = bootApp(t);
  assert.equal(callGlobal(context, 'routeClassForDestinationName("Italia")'), "eu");
  assert.equal(callGlobal(context, 'routeClassForDestinationName("Unione Europea")'), "eu");
  assert.equal(callGlobal(context, 'routeClassForDestinationName("Regno Unito")'), "eu");
  assert.equal(callGlobal(context, 'routeClassForDestinationName("Stati Uniti")'), "intercontinental");
  assert.equal(callGlobal(context, 'routeClassForDestinationName("Giappone")'), "intercontinental");
});

// ---------------------------------------------------------------------
// 2) findAirlineFeeEntry()/estimateAirlineBaggageCost() — il calcolo.
// ---------------------------------------------------------------------

const FAKE_FEES = [
  { airline: "Ryanair", feeType: "per_kg_overweight", routeClass: null, travelClass: null, amountMin: 13, amountMax: 13, currency: "EUR", sourceUrl: "https://example.com/ryanair", verifiedAt: "2026-09-30", note: null },
  // KLM: QUATTRO voci, mirror della struttura reale in
  // netlify/lib/airline-baggage-fees.js — sia per_extra_piece sia
  // per_kg_overweight, per entrambe le rotte eu/intercontinental. Usata
  // sotto per il bug trovato in revisione (ottobre 2026): la versione
  // precedente di findAirlineFeeEntry() restituiva SEMPRE e SOLO la prima
  // voce che matchava routeClass (qui per_extra_piece, perché scritta
  // prima nell'array), nascondendo silenziosamente la tariffa al kg
  // indipendentemente dal peso reale del pacco.
  { airline: "KLM", feeType: "per_extra_piece", routeClass: "eu", travelClass: null, amountMin: 20, amountMax: 70, currency: "EUR", sourceUrl: "https://example.com/klm", verifiedAt: "2026-09-30", note: null },
  { airline: "KLM", feeType: "per_extra_piece", routeClass: "intercontinental", travelClass: null, amountMin: 30, amountMax: 240, currency: "EUR", sourceUrl: "https://example.com/klm", verifiedAt: "2026-09-30", note: null },
  { airline: "KLM", feeType: "per_kg_overweight", routeClass: "eu", travelClass: null, amountMin: 75, amountMax: 100, currency: "EUR", sourceUrl: "https://example.com/klm", verifiedAt: "2026-09-30", note: null },
  { airline: "KLM", feeType: "per_kg_overweight", routeClass: "intercontinental", travelClass: null, amountMin: 100, amountMax: 300, currency: "EUR", sourceUrl: "https://example.com/klm", verifiedAt: "2026-09-30", note: null },
  { airline: "Lufthansa Group", feeType: "variable_by_fare", routeClass: null, travelClass: null, amountMin: null, amountMax: null, currency: "EUR", sourceUrl: "https://example.com/lh", verifiedAt: "2026-09-30", note: "Tariffa variabile, verifica la tua tariffa specifica." },
  { airline: "Qatar Airways", feeType: "per_extra_piece", routeClass: null, travelClass: null, amountMin: 130, amountMax: 255, currency: "USD", sourceUrl: "https://example.com/qatar", verifiedAt: "2026-09-30", note: null },
  // Compagnia con SOLO una voce "intercontinental" (nessun fallback
  // routeClass:null) — usata sotto per il caso "nessuna voce per questa
  // rotta" (non la stessa cosa di "compagnia non trovata").
  { airline: "Solo Intercontinentale Airways", feeType: "per_extra_piece", routeClass: "intercontinental", travelClass: null, amountMin: 50, amountMax: 50, currency: "EUR", sourceUrl: "https://example.com/solo-intl", verifiedAt: "2026-09-30", note: null },
];

test("findAirlineFeeEntry(): match esatto su routeClass quando la fonte lo distingue (KLM eu vs intercontinental)", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const eu = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "KLM", "eu", "economy")');
  const intl = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "KLM", "intercontinental", "economy")');
  assert.equal(eu.amountMin, 20);
  assert.equal(eu.amountMax, 70);
  assert.equal(intl.amountMin, 30);
  assert.equal(intl.amountMax, 240);
});

test("findAirlineFeeEntry(): fallback a una voce routeClass:null quando la fonte non distingue per rotta (Ryanair)", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const eu = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "Ryanair", "eu", "economy")');
  const intl = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "Ryanair", "intercontinental", "economy")');
  assert.equal(eu.amountMin, 13);
  assert.equal(intl.amountMin, 13, "stessa tariffa flat indipendentemente dalla rotta");
});

test("findAirlineFeeEntry(): compagnia assente dal dataset -> null, mai un crash", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const result = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "Compagnia Inesistente", "eu", "economy")');
  assert.equal(result, null);
});

test("findAirlineFeeEntry(): compagnia presente ma senza alcuna voce per la rotta richiesta (né match né fallback) -> null", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const result = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "Solo Intercontinentale Airways", "eu", "economy")');
  assert.equal(result, null, "ha solo una voce intercontinental, nessun fallback null: su rotta eu non deve inventare un numero");
  const intl = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "Solo Intercontinentale Airways", "intercontinental", "economy")');
  assert.equal(intl.amountMin, 50, "sulla rotta corretta invece la trova");
});

test("estimateAirlineBaggageCost(): per_kg_overweight moltiplica amountMin/Max per l'INTERO billableWeight (nessuna franchigia sottratta)", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const entry = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "Ryanair", "eu", "economy")');
  setState(context, { __t_entry: entry });
  const result = callGlobal(context, "estimateAirlineBaggageCost(state.__t_entry, 4.5)");
  assert.equal(result.feeType, "per_kg_overweight");
  assert.equal(result.min, 13 * 4.5);
  assert.equal(result.max, 13 * 4.5);
  assert.equal(result.currency, "EUR");
});

test("estimateAirlineBaggageCost(): per_extra_piece è un costo FISSO, indipendente dal peso", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const entry = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "KLM", "eu", "economy")');
  setState(context, { __t_entry: entry });
  const light = callGlobal(context, "estimateAirlineBaggageCost(state.__t_entry, 0.5)");
  const heavy = callGlobal(context, "estimateAirlineBaggageCost(state.__t_entry, 18)");
  assert.equal(light.min, 20);
  assert.equal(light.max, 70);
  assert.deepEqual(light, heavy, "lo stesso costo fisso indipendentemente dal peso in eccesso");
});

test("estimateAirlineBaggageCost(): variable_by_fare (Lufthansa) non produce MAI un numero, solo la nota", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const entry = callGlobal(context, 'findAirlineFeeEntry(state.__t_fees, "Lufthansa Group", "eu", "economy")');
  setState(context, { __t_entry: entry });
  const result = callGlobal(context, "estimateAirlineBaggageCost(state.__t_entry, 7)");
  assert.equal(result.feeType, "variable_by_fare");
  assert.equal(result.min, null);
  assert.equal(result.max, null);
  assert.equal(result.note, "Tariffa variabile, verifica la tua tariffa specifica.");
});

test("estimateAirlineBaggageCost(): nessuna voce trovata -> null, mai un crash", (t) => {
  const { context } = bootApp(t);
  const result = callGlobal(context, "estimateAirlineBaggageCost(null, 5)");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------
// 3) baggageComparisonsForGroup() — "tutto in uno" usata dalla UI: dati
//    mancanti/compagnia non trovata gestiti esplicitamente. Restituisce
//    sempre un ARRAY (mai un singolo oggetto) perché una compagnia può
//    avere più voci per la stessa rotta — vedi il test dedicato KLM sotto
//    (bug trovato in revisione, ottobre 2026).
// ---------------------------------------------------------------------

test("baggageComparisonsForGroup(): dataset non ancora arrivato (fees vuoto) -> array vuoto, mai un crash", (t) => {
  const { context } = bootApp(t);
  const result = callGlobal(context, 'baggageComparisonsForGroup([], "Ryanair", "economy", "Italia", 5)');
  // Array.from(): result arriva dal realm sandbox (vm.runInContext) — un
  // Array di quel realm non è reference-equal a un Array literal del
  // realm host anche a contenuto identico, stessa tecnica già in uso
  // altrove in questo repository per confronti cross-realm.
  assert.deepEqual(Array.from(result), []);
});

test("baggageComparisonsForGroup(): nessuna compagnia selezionata (null/undefined) -> array vuoto", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const result = callGlobal(context, "baggageComparisonsForGroup(state.__t_fees, null, \"economy\", \"Italia\", 5)");
  assert.deepEqual(Array.from(result), []);
});

test("baggageComparisonsForGroup(): end-to-end, Ryanair (una sola voce) su destinazione intercontinentale con peso reale", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const result = callGlobal(context, 'baggageComparisonsForGroup(state.__t_fees, "Ryanair", "economy", "Stati Uniti", 2)');
  assert.equal(result.length, 1, "una sola voce per Ryanair -> un solo confronto");
  assert.equal(result[0].min, 26);
  assert.equal(result[0].max, 26);
  assert.equal(result[0].currency, "EUR");
});

// ---------------------------------------------------------------------
// Regressione del bug trovato in revisione (ottobre 2026): per una
// compagnia con PIÙ voci per la stessa rotta (KLM: per_extra_piece E
// per_kg_overweight, sia per "eu" sia per "intercontinental"),
// baggageComparisonsForGroup() deve restituire ENTRAMBE le voci — la
// versione precedente (findAirlineFeeEntry a voce singola) restituiva
// sempre e solo la prima (per_extra_piece, scritta prima nel dataset),
// nascondendo silenziosamente la tariffa al kg indipendentemente dal peso
// reale del pacco.
// ---------------------------------------------------------------------

test("baggageComparisonsForGroup(): KLM rotta 'eu' -> ENTRAMBE le voci (per_extra_piece E per_kg_overweight), non solo la prima", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const result = callGlobal(context, 'baggageComparisonsForGroup(state.__t_fees, "KLM", "economy", "Italia", 4)');

  assert.equal(result.length, 2, "KLM ha due voci per la rotta eu: entrambe devono comparire");
  const extraPiece = result.find((r) => r.feeType === "per_extra_piece");
  const perKg = result.find((r) => r.feeType === "per_kg_overweight");
  assert.ok(extraPiece, "la voce per_extra_piece deve essere presente");
  assert.ok(perKg, "la voce per_kg_overweight NON deve sparire dietro la prima trovata (il bug corretto)");

  // per_extra_piece: costo fisso, invariato rispetto al peso (20-70€, dal
  // dataset).
  assert.equal(extraPiece.min, 20);
  assert.equal(extraPiece.max, 70);

  // per_kg_overweight: 75-100€/kg (dal dataset) × 4kg di billableWeight.
  assert.equal(perKg.min, 75 * 4);
  assert.equal(perKg.max, 100 * 4);
});

test("baggageComparisonsForGroup(): KLM per_kg_overweight è effettivamente proporzionale al peso (doppio peso = doppio importo)", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });

  const resultLight = callGlobal(context, 'baggageComparisonsForGroup(state.__t_fees, "KLM", "economy", "Italia", 3)');
  const resultHeavy = callGlobal(context, 'baggageComparisonsForGroup(state.__t_fees, "KLM", "economy", "Italia", 6)');

  const perKgLight = resultLight.find((r) => r.feeType === "per_kg_overweight");
  const perKgHeavy = resultHeavy.find((r) => r.feeType === "per_kg_overweight");
  assert.equal(perKgHeavy.min, perKgLight.min * 2, "doppio peso -> doppio importo minimo");
  assert.equal(perKgHeavy.max, perKgLight.max * 2, "doppio peso -> doppio importo massimo");

  // La voce per_extra_piece, invece, non deve MAI variare col peso — è un
  // costo fisso, vedi test sopra.
  const extraPieceLight = resultLight.find((r) => r.feeType === "per_extra_piece");
  const extraPieceHeavy = resultHeavy.find((r) => r.feeType === "per_extra_piece");
  assert.deepEqual(extraPieceLight, extraPieceHeavy);
});

test("baggageComparisonsForGroup(): KLM rotta 'intercontinental' -> le voci corrette per quella rotta, non quelle 'eu'", (t) => {
  const { context } = bootApp(t);
  setState(context, { __t_fees: FAKE_FEES });
  const result = callGlobal(context, 'baggageComparisonsForGroup(state.__t_fees, "KLM", "economy", "Stati Uniti", 4)');

  assert.equal(result.length, 2);
  const extraPiece = result.find((r) => r.feeType === "per_extra_piece");
  const perKg = result.find((r) => r.feeType === "per_kg_overweight");
  assert.equal(extraPiece.min, 30);
  assert.equal(extraPiece.max, 240);
  assert.equal(perKg.min, 100 * 4);
  assert.equal(perKg.max, 300 * 4);
});

// ---------------------------------------------------------------------
// 4) Rendering in ConcludeScreen — sezione completa, disclaimer, stati.
// ---------------------------------------------------------------------

const ADDRESS_EU = { id: "addr-eu", label: "Casa — Via Roma 1, Milano 20100, Italia", street: "Via Roma 1", city: "Milano", cap: "20100", country: "Italia" };
const ADDRESS_INTL = { id: "addr-intl", label: "Hotel — 5th Ave, New York, Stati Uniti", street: "5th Ave", city: "New York", cap: "10001", country: "Stati Uniti" };

function item(overrides) {
  return Object.assign(
    {
      id: "TG-000001",
      objectName: "Souvenir",
      pickupPoint: "Firenze centro",
      addressId: ADDRESS_EU.id,
      addressLabel: ADDRESS_EU.label,
      pricingTier: "pieno",
      weightKg: 2,
      dims: null,
    },
    overrides
  );
}

function fetchMockFor(fees, verifiedAt) {
  return (url) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/airline-baggage-fees")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ fees, verifiedAt }) });
    }
    return Promise.reject(new Error("network disabled in test"));
  };
}

function gotoConclude(context, window) {
  setState(context, { screen: "conclude" });
  window.render();
}

test("ConcludeScreen: prima di scegliere una compagnia, la sezione mostra solo intro+selettori, nessun risultato", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: fetchMockFor(FAKE_FEES, "2026-09-30") });
  setState(context, { addresses: [ADDRESS_EU], pendingItems: [item()] });
  gotoConclude(context, window);
  await flushMicrotasks();

  const card = document.querySelector(".baggage-compare-card");
  assert.ok(card, "la sezione deve esistere in ConcludeScreen");
  assert.ok(card.textContent.includes("Confronto costo bagaglio extra compagnia aerea"));
  assert.ok(!document.querySelector(".baggage-compare-results"), "nessun risultato finché il turista non ha scelto una compagnia");
});

test("ConcludeScreen: selezionando Ryanair, mostra il costo calcolato (per_kg_overweight × billableWeight del gruppo)", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: fetchMockFor(FAKE_FEES, "2026-09-30") });
  setState(context, { addresses: [ADDRESS_EU], pendingItems: [item({ weightKg: 2 })] });
  gotoConclude(context, window);
  await flushMicrotasks();

  const airlineSelect = document.querySelector(".baggage-compare-airline");
  airlineSelect.value = "Ryanair";
  airlineSelect.dispatchEvent(new window.Event("change"));

  const row = document.querySelector(".baggage-compare-row");
  assert.ok(row, "deve comparire una riga di confronto per la destinazione");
  // billableWeight del gruppo (vedi consolidatedGroupPrice: min 0.3kg per
  // collo, qui 2kg reali, nessun volumetrico) = 2kg -> 13 * 2 = 26€.
  assert.ok(row.textContent.includes("26.00"), `atteso 26.00€ nel testo, trovato: "${row.textContent}"`);
});

test("ConcludeScreen: Lufthansa Group mostra la nota, mai un numero", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: fetchMockFor(FAKE_FEES, "2026-09-30") });
  setState(context, { addresses: [ADDRESS_EU], pendingItems: [item({ weightKg: 2 })] });
  gotoConclude(context, window);
  await flushMicrotasks();

  const airlineSelect = document.querySelector(".baggage-compare-airline");
  airlineSelect.value = "Lufthansa Group";
  airlineSelect.dispatchEvent(new window.Event("change"));

  const row = document.querySelector(".baggage-compare-row");
  assert.ok(row.textContent.includes("Tariffa variabile, verifica la tua tariffa specifica."));
  assert.ok(!/\d/.test(row.querySelector(".baggage-compare-note").textContent.replace(/2026/g, "")), "nessuna cifra di importo nella nota (a parte eventuali anni, qui non presenti)");
});

test("ConcludeScreen: KLM mostra DUE righe distinte (pezzo extra E sovrappeso al kg), mai solo la prima — regressione del bug trovato in revisione", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: fetchMockFor(FAKE_FEES, "2026-09-30") });
  setState(context, { addresses: [ADDRESS_EU], pendingItems: [item({ weightKg: 4 })] });
  gotoConclude(context, window);
  await flushMicrotasks();

  const airlineSelect = document.querySelector(".baggage-compare-airline");
  airlineSelect.value = "KLM";
  airlineSelect.dispatchEvent(new window.Event("change"));

  const rows = Array.from(document.querySelectorAll(".baggage-compare-row"));
  assert.equal(rows.length, 2, "KLM deve mostrare due righe (pezzo extra + sovrappeso al kg), mai una sola");

  const extraPieceRow = rows.find((r) => r.textContent.includes("Se comprassi un bagaglio extra"));
  const overweightRow = rows.find((r) => r.textContent.includes("Se sei in sovrappeso"));
  assert.ok(extraPieceRow, "deve esserci la riga del pezzo extra, etichettata");
  assert.ok(overweightRow, "deve esserci la riga del sovrappeso al kg, etichettata — quella che il bug nascondeva");

  assert.ok(extraPieceRow.textContent.includes("20.00") && extraPieceRow.textContent.includes("70.00"), `riga pezzo extra attesa 20-70€, trovata: "${extraPieceRow.textContent}"`);
  // Sovrappeso: 75-100€/kg × 4kg (vedi item({weightKg: 4}) sopra) = 300-400€.
  assert.ok(overweightRow.textContent.includes("300.00") && overweightRow.textContent.includes("400.00"), `riga sovrappeso attesa 300-400€ (75-100 × 4kg), trovata: "${overweightRow.textContent}"`);
});

test("ConcludeScreen: compagnia senza alcuna voce per questa rotta -> messaggio esplicito, mai un numero inventato", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: fetchMockFor(FAKE_FEES, "2026-09-30") });
  // Destinazione EU, ma "Solo Intercontinentale Airways" ha solo una voce
  // intercontinental.
  setState(context, { addresses: [ADDRESS_EU], pendingItems: [item({ weightKg: 2 })] });
  gotoConclude(context, window);
  await flushMicrotasks();

  const airlineSelect = document.querySelector(".baggage-compare-airline");
  airlineSelect.value = "Solo Intercontinentale Airways";
  airlineSelect.dispatchEvent(new window.Event("change"));

  const row = document.querySelector(".baggage-compare-row");
  assert.ok(row.querySelector(".baggage-compare-unavailable"), "deve mostrare esplicitamente 'nessun dato disponibile'");
});

test("ConcludeScreen: compagnia con fee in USD mostra l'importo originale PIÙ la conversione approssimativa etichettata", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: fetchMockFor(FAKE_FEES, "2026-09-30") });
  setState(context, { addresses: [ADDRESS_EU], pendingItems: [item({ weightKg: 2 })] });
  gotoConclude(context, window);
  await flushMicrotasks();

  const airlineSelect = document.querySelector(".baggage-compare-airline");
  airlineSelect.value = "Qatar Airways";
  airlineSelect.dispatchEvent(new window.Event("change"));

  const row = document.querySelector(".baggage-compare-row");
  assert.ok(row.textContent.includes("$130.00–255.00"), `l'importo originale in USD (range) deve sempre essere mostrato, trovato: "${row.textContent}"`);
  const expectedMin = Math.round(130 * 0.92 * 100) / 100;
  const expectedMax = Math.round(255 * 0.92 * 100) / 100;
  assert.ok(row.textContent.includes(expectedMin.toFixed(2)), `atteso il convertito ~€${expectedMin.toFixed(2)} nel testo: "${row.textContent}"`);
  assert.ok(row.textContent.includes(expectedMax.toFixed(2)));
  assert.ok(row.textContent.includes("conversione stimata"), "l'etichetta di conversione approssimativa deve sempre comparire accanto a un importo convertito");
});

test("ConcludeScreen: fetch del dataset fallito -> nessun crash, sezione resta senza risultati/disclaimer", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: () => Promise.reject(new Error("network down")) });
  setState(context, { addresses: [ADDRESS_EU], pendingItems: [item()] });
  gotoConclude(context, window);
  await flushMicrotasks();

  const card = document.querySelector(".baggage-compare-card");
  assert.ok(card, "la sezione deve comunque esistere, senza errori mostrati al turista");
  assert.ok(!document.querySelector(".baggage-compare-disclaimer"), "nessun disclaimer senza una verifiedAt reale da mostrare");
});

test("ConcludeScreen: il disclaimer mostra la data di verifica più recente e il testo obbligatorio", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: fetchMockFor(FAKE_FEES, "2026-09-30") });
  setState(context, { addresses: [ADDRESS_EU], pendingItems: [item({ weightKg: 2 })] });
  gotoConclude(context, window);
  await flushMicrotasks();

  const airlineSelect = document.querySelector(".baggage-compare-airline");
  airlineSelect.value = "Ryanair";
  airlineSelect.dispatchEvent(new window.Event("change"));

  const disclaimer = document.querySelector(".baggage-compare-disclaimer");
  assert.ok(disclaimer, "il disclaimer deve comparire una volta che i dati sono arrivati");
  assert.ok(disclaimer.textContent.includes("2026-09-30"), "deve citare la data di verifica più recente");
  assert.ok(disclaimer.textContent.includes("fonti ufficiali"));
  assert.ok(disclaimer.textContent.includes("variano per tariffa, rotta e canale di acquisto"));
});

test("ConcludeScreen: la stima bagaglio è SOLO informativa, mai parte del totale Touch&Go mostrato/confermato", async (t) => {
  const { window, document, context } = bootApp(t, { fetchMock: fetchMockFor(FAKE_FEES, "2026-09-30") });
  setState(context, { addresses: [ADDRESS_EU], pendingItems: [item({ weightKg: 2 })] });
  gotoConclude(context, window);
  await flushMicrotasks();

  const totalBefore = document.querySelector(".info-row.total b").textContent;
  const airlineSelect = document.querySelector(".baggage-compare-airline");
  airlineSelect.value = "KLM";
  airlineSelect.dispatchEvent(new window.Event("change"));
  const totalAfter = document.querySelector(".info-row.total b").textContent;

  assert.equal(totalBefore, totalAfter, "scegliere una compagnia aerea non deve MAI alterare il totale Touch&Go");
});
