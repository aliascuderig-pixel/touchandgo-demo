// Verifica la stima dazi doganali lato client (dist/assets/app.js) — vedi
// MANUALE.md per i 5 vincoli non negoziabili decisi con Giuseppe. Copre i
// punti richiesti:
// (1) un fallimento di estimate-duty non impedisce in nessun modo il
//     completamento del resto del flusso (classificazione/prezzo/schermata
//     Result) — provato mostrando che runClassification() si conclude
//     PRIMA che la chiamata di stima (mai attesa da lì) si sia anche solo
//     risolta con esito negativo.
// (3) la stima non entra mai in nessun calcolo di prezzo — verificato
//     staticamente estraendo il corpo sorgente di ogni funzione di prezzo
//     e confermando che nessuna menzioni "duty" in alcuna forma.
// Più: popolamento riuscito e rendering (badge "non ufficiale" + testo),
// e il caso "paese non ancora noto" (nessun tentativo, nessuna sezione).
//
// Stessa tecnica già usata in xss-escape.test.js di questo repository:
// app.js reale caricato in una finestra jsdom isolata via vm.runInContext.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, "utf8");

function bootApp(t) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error("network disabled in test"));
  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });
  return { window, document: window.document, context };
}

function flushMicrotasks(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 5); i++) p = p.then(() => Promise.resolve());
  return p;
}

const FAKE_RESULT = {
  object_it: "Vaso in ceramica",
  hs_code: "691200",
  category: "Ceramica",
  material: "ceramica",
  weight_kg: 1.2,
  length_cm: 20,
  width_cm: 20,
  height_cm: 25,
  value_eur: 80,
  fragile: true,
  confidence: "alta",
};

test("(1) un fallimento (rete) di estimate-duty NON impedisce il completamento di classificazione/prezzo/schermata Result", async (t) => {
  const { window, context } = bootApp(t);
  vm.runInContext('state.guestDestinationCountry = "Stati Uniti";', context);

  let estimateDutyCalled = false;
  window.fetch = (url) => {
    if (String(url).includes("/estimate-duty")) {
      estimateDutyCalled = true;
      return Promise.reject(new Error("simulated network failure"));
    }
    return Promise.reject(new Error("not expected in this test"));
  };

  await window.runClassification(Promise.resolve(FAKE_RESULT));

  // Il momento esatto della prova di "non bloccante": runClassification()
  // è già tornata (l'await sopra si è già risolto) ma la chiamata di
  // stima dazi, partita da lì senza essere attesa, non si è ancora
  // risolta (è ancora "in caricamento") — la dimostrazione che il flusso
  // critico non ha aspettato quella chiamata, non solo che "ha comunque
  // funzionato".
  assert.equal(vm.runInContext("state.screen", context), "result", "la schermata Result deve essere già raggiunta");
  assert.deepEqual(vm.runInContext("state.result", context), FAKE_RESULT, "il risultato della classificazione deve essere quello atteso, invariato");
  assert.ok(vm.runInContext("state.price", context), "il prezzo deve essere già calcolato");
  assert.equal(typeof vm.runInContext("state.price.grandTotal", context), "number", "il prezzo calcolato deve avere un totale numerico, come sempre");
  assert.equal(estimateDutyCalled, true, "la chiamata di stima deve comunque essere partita (fire-and-forget)");
  assert.equal(vm.runInContext("state.dutyEstimateLoading", context), true, "la stima è ancora pending: prova che runClassification() non l'ha aspettata");

  // Ora lasciamo che il fallimento venga effettivamente elaborato.
  await flushMicrotasks();

  assert.equal(vm.runInContext("state.dutyEstimateLoading", context), false, "il fallimento deve comunque essere gestito, portando loading a false");
  assert.equal(vm.runInContext("state.dutyEstimate", context), null, "un fallimento non deve mai popolare una stima finta");
  // Il resto dello stato del percorso principale resta intatto anche dopo
  // che il fallimento è stato elaborato — nessuna "correzione" a
  // posteriori che lo alteri.
  assert.equal(vm.runInContext("state.screen", context), "result");
  assert.deepEqual(vm.runInContext("state.result", context), FAKE_RESULT);
});

test("(1) anche un errore HTTP (500) da estimate-duty non impedisce il completamento del resto del flusso", async (t) => {
  const { window, context } = bootApp(t);
  vm.runInContext('state.guestDestinationCountry = "Germania";', context);
  window.fetch = (url) => {
    if (String(url).includes("/estimate-duty")) {
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) });
    }
    return Promise.reject(new Error("not expected"));
  };

  await window.runClassification(Promise.resolve(FAKE_RESULT));
  assert.equal(vm.runInContext("state.screen", context), "result");

  await flushMicrotasks();
  assert.equal(vm.runInContext("state.dutyEstimate", context), null);
  assert.equal(vm.runInContext("state.dutyEstimateLoading", context), false);
  assert.equal(vm.runInContext("state.screen", context), "result", "nessuna regressione sullo screen dopo che l'errore è stato elaborato");
});

test("popolamento riuscito: la stima arriva, viene mostrata con il badge \"non ufficiale\" e il testo del disclaimer", async (t) => {
  const { window, document, context } = bootApp(t);
  vm.runInContext('state.guestDestinationCountry = "Canada";', context);
  const fakeEstimateText = "Circa 10-15%, indicativamente 8-12€. Stima indicativa, non vincolante — verifica sempre con le autorità doganali del paese di destinazione prima di partire.";
  window.fetch = (url) => {
    if (String(url).includes("/estimate-duty")) {
      return Promise.resolve({ ok: true, json: async () => ({ estimate: fakeEstimateText }) });
    }
    return Promise.reject(new Error("not expected"));
  };

  await window.runClassification(Promise.resolve(FAKE_RESULT));
  await flushMicrotasks();

  assert.equal(vm.runInContext("state.dutyEstimate", context), fakeEstimateText);
  assert.equal(vm.runInContext("state.dutyEstimateLoading", context), false);

  window.render();
  const card = document.querySelector(".duty-estimate-card");
  assert.ok(card, "la sezione deve comparire nella schermata Result una volta arrivata la stima");
  assert.match(card.querySelector(".duty-estimate-badge").textContent, /non ufficiale|unofficial/i);
  assert.match(card.querySelector(".duty-estimate-text").textContent, /verifica sempre con le autorità doganali/);
});

test("paese di destinazione non noto: nessun tentativo di stima, nessuna sezione mostrata", async (t) => {
  const { window, document, context } = bootApp(t);
  let estimateDutyCalled = false;
  // Filtrato per URL, non "qualunque fetch": il boot dell'app fa altre
  // chiamate di rete indipendenti (es. checkGuestMode()) che non
  // c'entrano con questo test e non devono produrre un falso positivo.
  window.fetch = (url) => {
    if (String(url).includes("/estimate-duty")) estimateDutyCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato per questo test"));
  };

  // Chiamata diretta della funzione con country vuoto/assente — copre il
  // vincolo 5 indipendentemente da come app.js garantisce oggi che questo
  // non accada nel percorso normale (DestinationField() fissa sempre un
  // paese prima della classificazione).
  await window.refreshDutyEstimate(FAKE_RESULT, "");
  assert.equal(estimateDutyCalled, false, "nessuna chiamata a estimate-duty se il paese non è noto");
  assert.equal(vm.runInContext("state.dutyEstimate", context), null);
  assert.equal(vm.runInContext("state.dutyEstimateLoading", context), false);

  vm.runInContext(`state.result = ${JSON.stringify(FAKE_RESULT)}; state.price = { grandTotal: 39, quotes: null }; state.screen = "result";`, context);
  window.render();
  assert.equal(document.querySelector(".duty-estimate-card"), null, "nessuna sezione deve comparire se non c'è mai stata una stima");
});

test("(3) isolamento dal prezzo: nessuna funzione di calcolo prezzo fa mai riferimento a dutyEstimate", () => {
  // Estrazione statica del corpo sorgente di ogni funzione di prezzo
  // esistente (bracketPrice, shippingCost, priceQuotes, priceFor) e
  // verifica che nessuna contenga alcuna forma di "duty" — la stima resta
  // un dato completamente separato, mai letto da chi calcola il prezzo
  // pagato a Touch&Go.
  const priceFunctionNames = ["bracketPrice", "shippingCost", "priceQuotes", "priceFor"];
  for (const name of priceFunctionNames) {
    const match = APP_JS_SOURCE.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`));
    assert.ok(match, `funzione ${name} non trovata nel sorgente — verificare che il nome non sia cambiato`);
    const start = match.index;
    // Estrae fino alla chiusura della graffa di primo livello della
    // funzione (bilanciamento manuale, sufficiente per queste funzioni
    // relativamente brevi e senza literal di stringa contenenti graffe).
    let depth = 0;
    let end = start;
    for (let i = start; i < APP_JS_SOURCE.length; i++) {
      if (APP_JS_SOURCE[i] === "{") depth++;
      else if (APP_JS_SOURCE[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const body = APP_JS_SOURCE.slice(start, end);
    assert.doesNotMatch(body.toLowerCase(), /duty/, `${name} non deve mai fare riferimento alla stima dazi (dutyEstimate)`);
  }
});

test("(3) grep diretto: dutyEstimate compare SOLO nei punti attesi (stato, sezione UI, refreshDutyEstimate), mai vicino a grandTotal/breakeven/priceFor", () => {
  const lines = APP_JS_SOURCE.split("\n");
  const dutyLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /dutyEstimate/i.test(line));
  assert.ok(dutyLines.length > 0, "ci si aspetta che dutyEstimate compaia da qualche parte nel file");
  for (const { line, i } of dutyLines) {
    assert.doesNotMatch(line, /grandTotal|priceFor\(|priceQuotes\(|bracketPrice\(|shippingCost\(/, `riga ${i + 1} mescola dutyEstimate con logica di prezzo: "${line.trim()}"`);
  }
});
