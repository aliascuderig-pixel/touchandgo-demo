// Verifica l'input vocale (dettatura) nei campi di testo libero
// (dist/assets/app.js, addVoiceButton()).
//
// IMPORTANTE — investigazione preliminare: la funzione addVoiceButton()
// esisteva GIÀ in questo repository prima di questo task (applicata a
// assistant-chat-input, partner-code-input, la textarea di ReviewScreen,
// name-input, street/città/CAP di AddressFormFields, newaddr-label — vedi
// MANUALE.md, sezione "Dettatura vocale nei campi del form", e il commento
// sopra addVoiceButton() in app.js che documenta un bugfix reale già
// avvenuto). Questo file NON reinventa la funzione: verifica il suo
// comportamento reale (compreso il bugfix) ed estende la copertura ai
// campi ancora scoperti (vedi commit/PR per l'elenco esatto).
//
// Punto critico: il comportamento REALE e deliberato di addVoiceButton()
// quando l'API non è supportata è diverso da "il pulsante sparisce" — il
// pulsante compare SEMPRE (attenuato, classe .voice-btn-unsupported) con
// un toast esplicativo al tap, per non lasciare il turista senza alcuna
// spiegazione (bug reale già corretto in precedenza, documentato sopra
// addVoiceButton() in app.js). I test sotto verificano questo comportamento
// REALE, non una versione "a sparizione silenziosa".
//
// Stessa tecnica di support-request.test.js: app.js REALE caricato in una
// finestra jsdom isolata via vm.runInContext. Le funzioni top-level
// dichiarate con "function" (AddressFormFields, PickupField,
// ChooseAddressScreen, SupportRequestModal, PartnerGenerateShipmentScreen,
// PartnerDiscountField, IdentifyScreen, HomeScreen, addVoiceButton) sono
// proprietà di "window" nel contesto vm e quindi chiamabili direttamente,
// senza dover navigare l'intero flusso schermo per schermo.

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
  window.localStorage.setItem("tg_lang", "it");
  window.localStorage.setItem("tg_onboarded", "1");

  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });

  return { window, document: window.document, context };
}

function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}

// Installa una SpeechRecognition finta nel contesto vm (simula un browser
// che SUPPORTA l'API). Non installarla affatto = browser che non la
// supporta (Firefox), esattamente come in un vero jsdom senza polyfill.
function installFakeRecognition(context) {
  vm.runInContext(
    `
    class __FakeRecognition extends EventTarget {
      constructor() {
        super();
        __FakeRecognition.instances.push(this);
      }
      start() { __FakeRecognition.startCalls++; }
    }
    __FakeRecognition.instances = [];
    __FakeRecognition.startCalls = 0;
    window.SpeechRecognition = __FakeRecognition;
    `,
    context,
    { filename: "fake-recognition.js" }
  );
}
function lastRecognition(context) {
  return vm.runInContext("__FakeRecognition.instances[__FakeRecognition.instances.length - 1]", context);
}
function startCallCount(context) {
  return vm.runInContext("__FakeRecognition.startCalls", context);
}

function mountInput(document, id) {
  const input = document.createElement("input");
  input.id = id;
  document.body.appendChild(input);
  return input;
}

// ---------------------------------------------------------------------
// 1. Comportamento reale con/senza supporto — mai un campo rotto
// ---------------------------------------------------------------------

test("addVoiceButton(): API supportata — pulsante NON attenuato, il click avvia davvero il riconoscimento", async (t) => {
  const { document, context } = bootApp(t);
  installFakeRecognition(context);
  mountInput(document, "voice-supported");
  vm.runInContext(`addVoiceButton(document.getElementById("voice-supported"))`, context);

  const btn = document.querySelector(".voice-btn");
  assert.ok(btn, "il pulsante deve comparire");
  assert.equal(btn.classList.contains("voice-btn-unsupported"), false);
  btn.click();
  assert.equal(startCallCount(context), 1, "il click deve avviare recognition.start()");
  assert.ok(btn.classList.contains("listening"), "indicazione visiva 'in ascolto' attiva durante il riconoscimento");
});

test("addVoiceButton(): API NON supportata — il pulsante compare comunque (mai un campo rotto), attenuato, il click mostra un toast senza avviare nulla", async (t) => {
  const { document, context } = bootApp(t);
  // Nessuna installFakeRecognition(): come un vero Firefox, senza l'API.
  mountInput(document, "voice-unsupported");
  vm.runInContext(`addVoiceButton(document.getElementById("voice-unsupported"))`, context);

  const btn = document.querySelector(".voice-btn");
  assert.ok(btn, "il pulsante compare SEMPRE, anche senza supporto — comportamento deliberato: farlo sparire lascerebbe il turista senza alcuna spiegazione (bug reale già corretto, vedi commento in addVoiceButton())");
  assert.ok(btn.classList.contains("voice-btn-unsupported"));

  const toast = document.querySelector(".voice-toast");
  assert.equal(toast.hidden, true, "nessun toast prima del click");
  btn.click();
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /non disponibile su questo browser/);

  // Il campo deve restare perfettamente utilizzabile da tastiera dopo il click.
  const input = document.getElementById("voice-unsupported");
  let changed = null;
  input.addEventListener("input", (e) => {
    changed = e.target.value;
  });
  input.value = "scritto a mano";
  input.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));
  assert.equal(changed, "scritto a mano");
});

// ---------------------------------------------------------------------
// 2. Il testo trascritto finisce nel campo giusto
// ---------------------------------------------------------------------

test("addVoiceButton(): il testo trascritto (evento 'result') viene accodato al campo e scatena un evento 'input' reale", async (t) => {
  const { document, window, context } = bootApp(t);
  installFakeRecognition(context);
  const input = mountInput(document, "voice-transcript");
  input.value = "Vaso in";
  vm.runInContext(`addVoiceButton(document.getElementById("voice-transcript"))`, context);

  let inputEventFired = false;
  input.addEventListener("input", () => {
    inputEventFired = true;
  });

  document.querySelector(".voice-btn").click();
  const rec = lastRecognition(context);
  const ev = new window.Event("result");
  ev.results = [[{ transcript: "ceramica dipinta a mano" }]];
  rec.dispatchEvent(ev);

  assert.equal(input.value, "Vaso in ceramica dipinta a mano", "il testo dettato è accodato al contenuto già presente, non lo sostituisce (dettatura in più riprese)");
  assert.equal(inputEventFired, true, "deve dispatchare un evento 'input' reale — i listener già esistenti sui campi (validazione/salvataggio) lo ascoltano");
});

test("addVoiceButton(): campo inizialmente vuoto — il testo trascritto lo riempie senza spazio iniziale spurio", async (t) => {
  const { document, window, context } = bootApp(t);
  installFakeRecognition(context);
  mountInput(document, "voice-empty");
  vm.runInContext(`addVoiceButton(document.getElementById("voice-empty"))`, context);

  document.querySelector(".voice-btn").click();
  const rec = lastRecognition(context);
  const ev = new window.Event("result");
  ev.results = [[{ transcript: "Mario Rossi" }]];
  rec.dispatchEvent(ev);

  assert.equal(document.getElementById("voice-empty").value, "Mario Rossi");
});

test("addVoiceButton(): un errore 'not-allowed' (permesso negato) mostra un toast; il campo resta scrivibile normalmente subito dopo", async (t) => {
  const { document, window, context } = bootApp(t);
  installFakeRecognition(context);
  const input = mountInput(document, "voice-denied");
  vm.runInContext(`addVoiceButton(document.getElementById("voice-denied"))`, context);

  document.querySelector(".voice-btn").click();
  const rec = lastRecognition(context);
  const ev = new window.Event("error");
  ev.error = "not-allowed";
  rec.dispatchEvent(ev);

  const toast = document.querySelector(".voice-toast");
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /non autorizzato/);

  let changed = null;
  input.addEventListener("input", (e) => {
    changed = e.target.value;
  });
  input.value = "scrivo a mano dopo l'errore";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(changed, "scrivo a mano dopo l'errore");
});

// ---------------------------------------------------------------------
// 3. Nessuna regressione sull'uso da tastiera (con e senza supporto)
// ---------------------------------------------------------------------

test("addVoiceButton(): il campo resta perfettamente utilizzabile da tastiera, sia con supporto vocale sia senza, senza mai toccare il microfono", async (t) => {
  for (const supported of [true, false]) {
    const { document, window, context } = bootApp(t);
    if (supported) installFakeRecognition(context);
    const input = mountInput(document, "voice-keyboard-" + supported);
    vm.runInContext(`addVoiceButton(document.getElementById("voice-keyboard-${supported}"))`, context);

    let changed = null;
    input.addEventListener("input", (e) => {
      changed = e.target.value;
    });
    input.value = "digitato normalmente";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(changed, "digitato normalmente", `supported=${supported}: la digitazione manuale deve funzionare identica a prima`);
  }
});

// ---------------------------------------------------------------------
// 4. Copertura dei campi — ogni campo di testo libero individuato
//    nell'investigazione ha il pulsante microfono (i campi email NO,
//    per lo stesso motivo già documentato: dettare un'email a voce è
//    impreciso).
// ---------------------------------------------------------------------

test("AddressFormFields(): via/città/CAP/paese reale hanno tutti il pulsante microfono (4 in totale, per qualunque prefix)", async (t) => {
  const { document, context } = bootApp(t);
  const frag = vm.runInContext(`AddressFormFields("test-prefix")`, context);
  document.body.appendChild(frag);
  assert.equal(document.querySelectorAll(".voice-btn").length, 4);
  ["test-prefix-street", "test-prefix-city", "test-prefix-cap", "test-prefix-realcountry"].forEach((id) => {
    const input = document.getElementById(id);
    assert.ok(input, `${id} deve esistere`);
    assert.ok(input.closest(".voice-field-wrap"), `${id} deve avere il pulsante microfono`);
  });
});

test("PickupField(): il campo punto di ritiro (DestinationScreen) ha il pulsante microfono", async (t) => {
  const { document, context } = bootApp(t);
  setState(context, { pickupPoint: "Roma", pickupSource: "gps" });
  const frag = vm.runInContext("PickupField()", context);
  document.body.appendChild(frag);
  const input = document.getElementById("pickup-input");
  assert.ok(input);
  assert.ok(input.closest(".voice-field-wrap"));
});

test("ChooseAddressScreen(): il campo punto di ritiro per il singolo acquisto ha il pulsante microfono", async (t) => {
  const { document, context } = bootApp(t);
  const frag = vm.runInContext("ChooseAddressScreen()", context);
  document.body.appendChild(frag);
  const input = document.getElementById("item-pickup-input");
  assert.ok(input, "il campo deve esistere");
  assert.ok(input.closest(".voice-field-wrap"));
});

test("SupportRequestModal(): il messaggio ha il pulsante microfono, l'email NO", async (t) => {
  const { document, context } = bootApp(t);
  const frag = vm.runInContext("SupportRequestModal()", context);
  document.body.appendChild(frag);
  assert.ok(document.getElementById("support-message-input").closest(".voice-field-wrap"), "support-message-input deve avere il pulsante");
  assert.equal(document.getElementById("support-email-input").closest(".voice-field-wrap"), null, "support-email-input NON deve averlo (campo email)");
});

test("PartnerGenerateShipmentScreen(): il nome cliente ha il pulsante microfono, l'email NO", async (t) => {
  const { document, context } = bootApp(t);
  setState(context, {
    partnerLoggedCode: "P1",
    partnerGenerateResult: { object_it: "Vaso", hs_code: "6913.90", weight_kg: 1.2, value_eur: 80 },
  });
  const frag = vm.runInContext("PartnerGenerateShipmentScreen()", context);
  document.body.appendChild(frag);
  assert.ok(document.getElementById("partner-generate-client-name").closest(".voice-field-wrap"), "partner-generate-client-name deve avere il pulsante");
  assert.equal(document.getElementById("partner-generate-client-email").closest(".voice-field-wrap"), null, "partner-generate-client-email NON deve averlo (campo email)");
});

test("IdentifyScreen(): il nome ha il pulsante microfono, l'email NO", async (t) => {
  const { document, context } = bootApp(t);
  const frag = vm.runInContext("IdentifyScreen()", context);
  document.body.appendChild(frag);
  assert.ok(document.getElementById("name-input").closest(".voice-field-wrap"), "name-input deve avere il pulsante (comportamento preesistente)");
  assert.equal(document.getElementById("email-input").closest(".voice-field-wrap"), null, "email-input NON deve averlo (campo email)");
});

test("HomeScreen(): il campo 'descrivilo' ha il pulsante microfono", async (t) => {
  const { document, context } = bootApp(t);
  const frag = vm.runInContext("HomeScreen()", context);
  document.body.appendChild(frag);
  const describeInput = frag.querySelector(".describe-box input");
  assert.ok(describeInput, "il campo descrivilo deve esistere");
  assert.ok(describeInput.closest(".voice-field-wrap"), "il campo descrivilo deve avere il pulsante microfono");
});

test("HomeScreen(): il campo codice promozionale (quando mostrato) ha il pulsante microfono", async (t) => {
  const { document, context } = bootApp(t);
  setState(context, { showPromoInput: true, promoCode: null });
  const frag = vm.runInContext("HomeScreen()", context);
  document.body.appendChild(frag);
  const promoBoxes = frag.querySelectorAll(".describe-box");
  assert.ok(promoBoxes.length >= 2, "con showPromoInput true devono comparire sia il box 'descrivilo' sia il box codice promo");
  const promoInput = promoBoxes[promoBoxes.length - 1].querySelector("input");
  assert.ok(promoInput.closest(".voice-field-wrap"), "il campo codice promo deve avere il pulsante microfono");
});

test("PartnerDiscountField(): il campo codice sconto partner (quando mostrato) ha il pulsante microfono", async (t) => {
  const { document, context } = bootApp(t);
  setState(context, { showPartnerDiscountInput: true, partnerDiscountApplied: null });
  const frag = vm.runInContext("PartnerDiscountField(39)", context);
  document.body.appendChild(frag);
  const input = frag.querySelector(".describe-box input");
  assert.ok(input, "il campo codice sconto deve esistere");
  assert.ok(input.closest(".voice-field-wrap"), "deve avere il pulsante microfono");
});
