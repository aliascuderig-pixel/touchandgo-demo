// Verifica il pagamento reale con Stripe Checkout in ConcludeScreen
// (dist/assets/app.js) — vedi MANUALE.md, sezione "Pagamento reale con
// Stripe Checkout". Copre end-to-end, lato client, i 4 punti della verifica
// finale richiesta:
//   (1) create-checkout-session riceve gli item GREZZI (peso, dimensioni,
//       tier, sconto, destinazione), mai un totale precalcolato dal client.
//   (2) un ritorno con session_id il cui payment_status non è "paid" NON
//       marca nessun oggetto come ritirato.
//   (3) SOLO un pagamento verificato "paid" da verify-checkout-session.js
//       fa procedere con la sincronizzazione (marcatura ritirato, gruppi
//       salvati, coda pending svuotata).
//   (4) un ritorno via cancel_url (nessun session_id nell'URL) non marca
//       nulla — stesso comportamento di un pagamento mai avvenuto.
//
// Stessa tecnica di identity-verification-pickup.test.js: app.js REALE
// caricato in una finestra jsdom isolata via vm.runInContext, guidato con
// veri click DOM.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, "utf8");

const ADDRESS = { id: "addr-t1", label: "Casa", street: "Via Test 1", city: "Roma", cap: "00100", country: "Italia" };

function profilePayload(overrides) {
  return Object.assign(
    {
      name: "Turista Test",
      email: "turista@example.com",
      addresses: [ADDRESS],
      selectedAddressId: ADDRESS.id,
      idDocument: "data:image/jpeg;base64,AAAA",
      signatureDetected: true,
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
      dims: { length_cm: 20, width_cm: 15, height_cm: 10 },
      pricingTier: "pieno",
      partnerDiscountAmount: 0,
      touristName: "Turista Test",
      status: "in sospeso",
      date: new Date().toISOString(),
    },
    overrides
  );
}

// Cattura le chiamate a create-checkout-session/verify-checkout-session
// (corpo inviato) senza mai toccare la rete davvero; classify.js è
// mockata solo perché alcuni helper di navigazione la richiedono
// indirettamente in altri test dello stesso stile — qui non serve, ma
// resta per coerenza con lo stesso pattern.
function makeFetchMock({ createSessionResponse, verifyResponse } = {}) {
  const calls = { createCheckoutSession: null, verifyCheckoutSession: null };
  const fetchMock = (url, opts) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/create-checkout-session")) {
      calls.createCheckoutSession = JSON.parse(opts.body);
      if (!createSessionResponse) return Promise.reject(new Error("network disabled in test"));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(createSessionResponse),
      });
    }
    if (typeof url === "string" && url.includes("/.netlify/functions/verify-checkout-session")) {
      calls.verifyCheckoutSession = JSON.parse(opts.body);
      if (!verifyResponse) return Promise.reject(new Error("network disabled in test"));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(verifyResponse),
      });
    }
    return Promise.reject(new Error("network disabled in test"));
  };
  return { fetchMock, calls };
}

function bootApp(t, { seedLocalStorage, fetchMock, url } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: url || "https://touchandgo.test/",
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

function goHome(document) {
  document.querySelector(".cover-screen").click();
}

function goConclude(document) {
  Array.from(document.querySelectorAll(".btn-secondary"))
    .find((e) => e.textContent.trim() === "Concludi il soggiorno e invia il ritiro →")
    .click();
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms == null ? 30 : ms));
}

// ---------------------------------------------------------------------
// (1) create-checkout-session riceve gli item grezzi, mai un totale
//     precalcolato dal client — e il redirect avviene solo dopo la
//     risposta del server, mai prima/senza.
// ---------------------------------------------------------------------

test("Conferma e paga: invia a create-checkout-session gli item grezzi (peso/dimensioni/tier/sconto/destinazione), MAI un campo 'total' o 'price'", async (t) => {
  const { fetchMock, calls } = makeFetchMock({
    createSessionResponse: { url: "https://checkout.stripe.com/c/pay/cs_test_abc" },
  });
  const { window, document } = bootApp(t, {
    fetchMock,
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem(
        "tg_pending",
        JSON.stringify([pendingItem({ id: "a", weightKg: 1, pricingTier: "pieno", partnerDiscountAmount: 5 })])
      );
    },
  });
  const redirects = [];
  window.redirectToCheckout = (url) => redirects.push(url);

  goHome(document);
  goConclude(document);
  const confirmBtn = Array.from(document.querySelectorAll(".btn-primary")).find((e) => e.textContent.trim().startsWith("Conferma e paga"));
  confirmBtn.click();

  await tick();

  assert.ok(calls.createCheckoutSession, "create-checkout-session deve essere stata chiamata");
  assert.equal(calls.createCheckoutSession.items.length, 1);
  const sentItem = calls.createCheckoutSession.items[0];
  assert.equal(sentItem.id, "a");
  assert.equal(sentItem.weightKg, 1);
  assert.equal(sentItem.pricingTier, "pieno");
  assert.equal(sentItem.partnerDiscountAmount, 5);
  assert.equal(sentItem.destinationCountry, "Italia");
  assert.deepEqual(sentItem.dims, { length_cm: 20, width_cm: 15, height_cm: 10 });
  assert.equal(sentItem.total, undefined, "MAI un totale precalcolato inviato dal client");
  assert.equal(sentItem.price, undefined, "MAI il prezzo stimato individuale inviato come se fosse il totale da pagare");

  assert.deepEqual(redirects, ["https://checkout.stripe.com/c/pay/cs_test_abc"], "deve reindirizzare esattamente all'URL restituito dal server");

  // Il solo click + redirect non marca ancora nulla: la marcatura avviene
  // SOLO al ritorno, dopo verifica server-side (vedi test successivi).
  const pending = JSON.parse(window.localStorage.getItem("tg_pending"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "in sospeso");
});

test("Conferma e paga: se create-checkout-session fallisce, nessun redirect e nessuna marcatura — un errore viene mostrato", async (t) => {
  const { fetchMock, calls } = makeFetchMock(); // nessuna risposta configurata -> la chiamata viene rifiutata
  const { window, document } = bootApp(t, {
    fetchMock,
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_pending", JSON.stringify([pendingItem()]));
    },
  });
  const redirects = [];
  window.redirectToCheckout = (url) => redirects.push(url);

  goHome(document);
  goConclude(document);
  const confirmBtn = Array.from(document.querySelectorAll(".btn-primary")).find((e) => e.textContent.trim().startsWith("Conferma e paga"));
  confirmBtn.click();
  await tick();

  assert.equal(redirects.length, 0, "nessun redirect se la creazione della sessione fallisce");
  assert.equal(document.querySelectorAll(".alert").length, 1);
  const pending = JSON.parse(window.localStorage.getItem("tg_pending"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "in sospeso");
});

// ---------------------------------------------------------------------
// (2)/(3) Ritorno da Stripe: SOLO paid:true marca gli oggetti, qualunque
//         altro esito non marca nulla.
// ---------------------------------------------------------------------

test('Ritorno da Stripe con ?session_id= e payment_status "paid": marca TUTTI gli oggetti in sospeso come ritirati, salva i gruppi, svuota la coda, screen "shipped"', async (t) => {
  const { fetchMock, calls } = makeFetchMock({
    verifyResponse: { paid: true, sessionId: "cs_test_paid", amountTotal: 5025, currency: "eur" },
  });
  const { window, document } = bootApp(t, {
    fetchMock,
    url: "https://touchandgo.test/?session_id=cs_test_paid",
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_pending", JSON.stringify([pendingItem({ id: "a" }), pendingItem({ id: "b" })]));
      ls.setItem("tg_history", JSON.stringify([pendingItem({ id: "a" }), pendingItem({ id: "b" })]));
    },
  });

  await tick(60);

  assert.equal(calls.verifyCheckoutSession.sessionId, "cs_test_paid", "verify-checkout-session deve ricevere esattamente il session_id dell'URL");

  assert.ok(document.querySelector(".booked-title"), "deve mostrare ShippedScreen dopo un pagamento verificato");
  assert.match(document.querySelector(".booked-title").textContent, /confermato e pagato/i);

  const pending = JSON.parse(window.localStorage.getItem("tg_pending"));
  assert.equal(pending.length, 0, "la coda 'in sospeso' deve essere svuotata dopo un pagamento verificato");

  const history = JSON.parse(window.localStorage.getItem("tg_history"));
  assert.ok(history.every((it) => it.status === "ritirato"), "tutti gli oggetti devono risultare ritirati nello storico");
  assert.ok(history.every((it) => it.shipmentGroupCode), "ogni oggetto deve avere il codice del gruppo di spedizione assegnato");

  // ?session_id= non deve restare nell'URL dopo la verifica.
  assert.equal(window.location.search, "");
});

test('Ritorno da Stripe con ?session_id= ma payment_status NON "paid": NON marca nulla, la coda resta intatta', async (t) => {
  const { fetchMock, calls } = makeFetchMock({
    verifyResponse: { paid: false, sessionId: "cs_test_unpaid" },
  });
  const { window, document } = bootApp(t, {
    fetchMock,
    url: "https://touchandgo.test/?session_id=cs_test_unpaid",
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_pending", JSON.stringify([pendingItem({ id: "a" })]));
    },
  });

  await tick(60);

  assert.equal(calls.verifyCheckoutSession.sessionId, "cs_test_unpaid");
  assert.ok(!document.querySelector(".booked-title"), "MAI ShippedScreen se il pagamento non è verificato paid:true");

  const pending = JSON.parse(window.localStorage.getItem("tg_pending"));
  assert.equal(pending.length, 1, "la coda 'in sospeso' NON deve essere toccata");
  assert.equal(pending[0].status, "in sospeso", "l'oggetto non deve mai risultare ritirato senza un pagamento verificato");
});

test("Ritorno da Stripe con un errore di verifica (rete/Stripe irraggiungibile): fail-closed, non marca nulla", async (t) => {
  const { fetchMock } = makeFetchMock(); // verifyResponse non configurata -> fetch rifiutata
  const { window, document } = bootApp(t, {
    fetchMock,
    url: "https://touchandgo.test/?session_id=cs_test_error",
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_pending", JSON.stringify([pendingItem({ id: "a" })]));
    },
  });

  await tick(60);

  assert.ok(!document.querySelector(".booked-title"));
  const pending = JSON.parse(window.localStorage.getItem("tg_pending"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "in sospeso");
});

// Mentre la verifica è in corso (prima che il mock risolva), l'app non
// deve mostrare la schermata "in sospeso" con lo stato vecchio: mostra un
// passaggio esplicito di verifica.
test("Mentre verify-checkout-session è in corso, l'app mostra un passaggio di verifica esplicito, non la schermata normale", (t) => {
  let resolveVerify;
  const fetchMock = (url) => {
    if (typeof url === "string" && url.includes("/.netlify/functions/verify-checkout-session")) {
      return new Promise((resolve) => {
        resolveVerify = () => resolve({ ok: true, json: () => Promise.resolve({ paid: true }) });
      });
    }
    return Promise.reject(new Error("network disabled in test"));
  };
  const { document } = bootApp(t, {
    fetchMock,
    url: "https://touchandgo.test/?session_id=cs_test_pending",
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_pending", JSON.stringify([pendingItem()]));
    },
  });

  assert.match(document.body.textContent, /verifica del pagamento/i);
  assert.ok(!document.querySelector(".booked-title"));
  // Non risolviamo mai resolveVerify(): il test finisce con la promise
  // ancora pending, comportamento innocuo (nessun timer reale coinvolto).
});

// ---------------------------------------------------------------------
// (4) Ritorno via cancel_url (nessun session_id) — stesso comportamento
//     di un pagamento mai avvenuto: nessuna chiamata, nessuna marcatura.
// ---------------------------------------------------------------------

test("Ritorno senza ?session_id= (cancel_url): nessuna chiamata a verify-checkout-session, nessuna marcatura — come un pagamento mai avvenuto", async (t) => {
  const { fetchMock, calls } = makeFetchMock({ verifyResponse: { paid: true } });
  const { window, document } = bootApp(t, {
    fetchMock,
    url: "https://touchandgo.test/", // esattamente il cancel_url configurato da create-checkout-session.js
    seedLocalStorage: (ls) => {
      ls.setItem("tg_onboarded", "1");
      ls.setItem("tg_profile", JSON.stringify(profilePayload()));
      ls.setItem("tg_pending", JSON.stringify([pendingItem({ id: "a" })]));
    },
  });

  await tick();

  assert.equal(calls.verifyCheckoutSession, null, "nessuna chiamata a verify-checkout-session senza session_id nell'URL");
  assert.ok(!document.querySelector(".booked-title"));
  const pending = JSON.parse(window.localStorage.getItem("tg_pending"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "in sospeso");
});
