// Verifica l'"Area abbonato per PC": chi si abbona a Touchandgo-app riceve
// un codice personale "ABB-…" e con quello accede dal computer (?mode=partner)
// al solo spazio "Genera spedizione"/"Spedizioni generate", senza vendite,
// commissioni o comunicati partner. Lato server: netlify/functions/__tests__/
// subscriber-access.test.js. Qui: app.js REALE in jsdom (vm.runInContext).
//
// Esecuzione: node --test  (dalla root del repository)
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const CODE = "ABB-ABCDEFGH";

const FAKE_CLASSIFY = {
  object_it: "Borsa in pelle", object_en: "Leather bag", hs_code: "420221", hs_description_it: "Borsa in pelle",
  category: "Accessori Moda", material: "pelle", weight_kg: 1.5, length_cm: 30, width_cm: 20, height_cm: 15,
  value_eur: 200, fragile: false, confidence: "alta",
};

function bootApp(t, { fetchMock, url = "https://touchandgo.test/", storage = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url, runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = fetchMock || (() => Promise.reject(new Error("network disabled in test")));
  class FakeImage {
    constructor() { this.width = 100; this.height = 100; }
    set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
    get src() { return this._src; }
  }
  window.Image = FakeImage;
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,ZmFrZQ==";
  window.localStorage.setItem("tg_lang", "it");
  window.localStorage.setItem("tg_onboarded", "1");
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });
  return { window, document: window.document, context };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getState = (context, expr) => vm.runInContext(`state.${expr}`, context);
const setState = (context, patch) => vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context);
const clickByText = (document, selector, text) => {
  const m = Array.from(document.querySelectorAll(selector)).find((e) => e.textContent.trim() === text);
  if (!m) throw new Error(`Nessun "${selector}" con testo "${text}"`);
  m.click();
};

function mockFetch({ onSave, registerCode = CODE, verifyValid = true, calls = [] } = {}) {
  return (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url: String(url), body });
    const u = String(url);
    if (u.includes("/subscriber-access")) {
      if (body.action === "register") return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: registerCode }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ valid: verifyValid }) });
    }
    if (u.includes("/classify")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: [{ text: JSON.stringify(FAKE_CLASSIFY) }] }) });
    }
    if (u.includes("/save-purchase")) {
      if (onSave) onSave(body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    if (u.includes("/functions/sync") && body.action === "list-generated-shipments") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
    }
    return Promise.reject(new Error("not mocked: " + u));
  };
}

test("abbonarsi chiede un codice ABB-… al server, lo salva nel profilo e imposta l'abbonamento", async (t) => {
  const calls = [];
  const { window, context } = bootApp(t, { fetchMock: mockFetch({ calls }) });
  window.activateSubscription();
  await wait(30);
  assert.equal(getState(context, "isSubscribed"), true);
  assert.equal(getState(context, "subscriberCode"), CODE);
  assert.equal(JSON.parse(window.localStorage.getItem("tg_profile")).subscriberCode, CODE);
  assert.equal(calls.filter((c) => c.url.includes("subscriber-access") && c.body.action === "register").length, 1);
});

test("il codice si chiede una volta sola: riabbonarsi/riaprire non ne emette un altro", async (t) => {
  const calls = [];
  const { window } = bootApp(t, { fetchMock: mockFetch({ calls }) });
  window.activateSubscription();
  await wait(30);
  window.activateSubscription();
  await wait(30);
  assert.equal(calls.filter((c) => c.body.action === "register").length, 1);
});

test("offline: l'abbonamento funziona comunque, senza codice; nessun errore", async (t) => {
  const { window, context } = bootApp(t, { fetchMock: () => Promise.reject(new Error("offline")) });
  window.activateSubscription();
  await wait(30);
  assert.equal(getState(context, "isSubscribed"), true);
  assert.equal(getState(context, "subscriberCode"), null);
});

test("un codice salvato torna dopo un ricaricamento (loadProfile); un valore non ABB- è ignorato", async (t) => {
  const ok = bootApp(t, { storage: { tg_profile: JSON.stringify({ isSubscribed: true, subscriberCode: CODE }) } });
  ok.window.loadProfile();
  assert.equal(getState(ok.context, "subscriberCode"), CODE);
  const bad = bootApp(t, { storage: { tg_profile: JSON.stringify({ isSubscribed: true, subscriberCode: "NDP924" }) } });
  bad.window.loadProfile();
  assert.equal(getState(bad.context, "subscriberCode"), null);
});

test("Cruscotto: l'abbonato con codice vede il codice e l'indirizzo per il PC (con escaping); senza codice vede il pulsante per ottenerlo; il non abbonato non vede nulla", async (t) => {
  const withCode = bootApp(t);
  setState(withCode.context, { isSubscribed: true, subscriberCode: CODE, screen: "dashboard" });
  withCode.window.render();
  const txt = withCode.document.querySelector(".subscriber-pc-card").textContent;
  assert.ok(txt.includes(CODE) && txt.includes("/?mode=partner"));

  const noCode = bootApp(t, { fetchMock: () => Promise.reject(new Error("offline")) });
  setState(noCode.context, { isSubscribed: true, screen: "dashboard" });
  noCode.window.render();
  assert.ok(noCode.document.getElementById("subscriber-code-retry-btn"));

  const free = bootApp(t);
  setState(free.context, { isSubscribed: false, screen: "dashboard" });
  free.window.render();
  assert.equal(free.document.querySelector(".subscriber-pc-card"), null);
});

test("PC: il login con un codice ABB- verifica su subscriber-access (mai su partner-stats) e mostra SOLO Genera spedizione e storico", async (t) => {
  const calls = [];
  const { document } = bootApp(t, { url: "https://touchandgo.test/?mode=partner", fetchMock: mockFetch({ calls }) });
  document.getElementById("partner-code-input").value = CODE.toLowerCase();
  clickByText(document, "button", "Accedi");
  await wait(50);
  assert.ok(calls.some((c) => c.url.includes("subscriber-access") && c.body.action === "verify" && c.body.code === CODE));
  assert.ok(!calls.some((c) => c.url.includes("partner-stats")), "un abbonato non passa da partner-stats");
  assert.ok(!calls.some((c) => c.body.action === "list-comunicati"), "nessun comunicato partner");
  assert.ok(document.getElementById("partner-generate-entry-btn"));
  assert.ok(document.getElementById("partner-shipments-entry-btn"));
  const page = document.body.textContent;
  for (const forbidden of ["Commissioni maturate", "Credito disponibile", "Vendite registrate", "piano partner", "Piano gratuito"]) {
    assert.ok(!page.includes(forbidden), `un abbonato non deve vedere "${forbidden}"`);
  }
});

test("PC: un codice ABB- non valido -> errore, nessun accesso", async (t) => {
  const { document } = bootApp(t, { url: "https://touchandgo.test/?mode=partner", fetchMock: mockFetch({ verifyValid: false }) });
  document.getElementById("partner-code-input").value = "ABB-ZZZZZZZZ";
  clickByText(document, "button", "Accedi");
  await wait(50);
  assert.ok(document.body.textContent.includes("Codice non riconosciuto"));
  assert.equal(document.getElementById("partner-generate-entry-btn"), null);
});

test("PC: la spedizione generata da un abbonato ha generatedByPartnerCode = codice ABB-…, tier 'abbonato', mai partnerCode", async (t) => {
  const saved = [];
  const { window, document } = bootApp(t, {
    url: "https://touchandgo.test/?mode=partner",
    fetchMock: mockFetch({ onSave: (b) => saved.push(b) }),
  });
  document.getElementById("partner-code-input").value = CODE;
  clickByText(document, "button", "Accedi");
  await wait(50);
  document.getElementById("partner-generate-entry-btn").click();
  const input = document.getElementById("partner-generate-file");
  Object.defineProperty(input, "files", { value: [new window.File(["x"], "o.jpg", { type: "image/jpeg" })], writable: false });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(50);
  document.getElementById("partner-generate-client-name").value = "Cliente Finale";
  document.getElementById("partner-generate-dest-city").value = "Parigi";
  document.getElementById("partner-generate-dest-realcountry").value = "Francia";
  document.getElementById("partner-generate-dest-country").value = "Unione Europea";
  document.getElementById("partner-generate-submit-btn").click();
  await wait(50);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].generatedByPartnerCode, CODE);
  assert.equal(saved[0].partnerCode, undefined);
  assert.equal(saved[0].pricingTier, "abbonato");
  assert.ok(saved[0].price > 0);
});

test("lo storico 'Spedizioni generate' dell'abbonato chiede solo il PROPRIO codice", async (t) => {
  const calls = [];
  const { document } = bootApp(t, { url: "https://touchandgo.test/?mode=partner", fetchMock: mockFetch({ calls }) });
  document.getElementById("partner-code-input").value = CODE;
  clickByText(document, "button", "Accedi");
  await wait(50);
  document.getElementById("partner-shipments-entry-btn").click();
  await wait(50);
  const listCalls = calls.filter((c) => c.body.action === "list-generated-shipments");
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].body.code, CODE);
});

test("un codice partner normale continua a vedere la dashboard partner completa (nessuna regressione)", async (t) => {
  const fetchMock = (url, opts) => {
    if (String(url).includes("partner-stats")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ valid: true, partnerName: "Boutique", plan: "boutique", paid: true, access: { blocked: false }, salesCount: 3, totalSalesValue: 150, totalCommission: 15, creditBalance: 5, monthlyBreakdown: [], recentOrders: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [], comunicati: [] }) });
  };
  const { document } = bootApp(t, { url: "https://touchandgo.test/?mode=partner", fetchMock });
  document.getElementById("partner-code-input").value = "BOUTIQUE1";
  clickByText(document, "button", "Accedi");
  await wait(50);
  assert.ok(document.body.textContent.includes("Commissioni maturate"));
  assert.ok(document.body.textContent.includes("Credito disponibile"));
});
