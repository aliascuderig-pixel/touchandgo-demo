// La mappa interattiva della guida (sezione #s-mappa): si carica la pagina vera
// in jsdom e si guidano click e tastiera. I link "Apri" arrivano dalle schede
// della sezione, quindi restano coperti da guida-links.test.js e dal controllo
// settimanale (che leggono gli href dalla pagina).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const HTML = fs.readFileSync(path.join(__dirname, "..", "..", "site", "guida.html"), "utf8");

function load() {
  const dom = new JSDOM(HTML, { runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const $ = (s) => w.document.querySelector(s);
  const $$ = (s) => Array.from(w.document.querySelectorAll(s));
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true }));
  return { w, $, $$, click, key };
}

const DEVICES = ["guest", "router", "suite", "eshop", "gestionale", "pratiche", "api", "crm"];

test("la mappa disegna tutti i dispositivi e gli archivi", () => {
  const { $$ } = load();
  const ids = $$("#mappa-svg g[data-id]").map((g) => g.getAttribute("data-id"));
  for (const d of DEVICES) assert.ok(ids.includes(d), "manca " + d);
  assert.ok(ids.filter((i) => i.startsWith("st_")).length >= 8);
});

test("clic su un dispositivo: pannello con titolo, legge/scrive e pulsante Apri al dispositivo giusto", () => {
  const { $, click } = load();
  const expected = {
    suite: "https://touchandgo-suite.netlify.app/site/index.html",
    router: "https://touchandgo-router.netlify.app/",
    eshop: "https://touchandgo-eshop.netlify.app/site/index.html",
    gestionale: "https://touchandgo-gestionale.netlify.app",
    pratiche: "https://touchandgo-pratiche.netlify.app",
    api: "https://touchandgo-api.netlify.app",
    crm: "https://touchandgo-crm.netlify.app/site/admin.html",
  };
  for (const [id, url] of Object.entries(expected)) {
    click($(`#mappa-svg [data-id="${id}"]`));
    assert.ok($("#mappa-panel h3").textContent.length > 0);
    const a = $("#mappa-panel a.btn");
    assert.ok(a, "nessun pulsante Apri per " + id);
    assert.strictEqual(a.getAttribute("href"), url);
  }
});

test("lo spazio ospite non ha pulsante Apri (non è un indirizzo da promuovere)", () => {
  const { $, click } = load();
  click($('#mappa-svg [data-id="guest"]'));
  assert.strictEqual($("#mappa-panel a.btn"), null);
});

test("la selezione attenua ciò che non c'entra e illumina archivi e CRM collegati", () => {
  const { $, click } = load();
  click($('#mappa-svg [data-id="api"]'));
  assert.ok($('#mappa-svg [data-id="eshop"]').classList.contains("m-dim"));
  assert.ok(!$('#mappa-svg [data-id="st_api"]').classList.contains("m-dim"));
  assert.ok(!$('#mappa-svg [data-id="crm"]').classList.contains("m-dim"));
  assert.ok($('#mappa-svg [data-id="api"]').classList.contains("on"));
});

test("il testo del pannello non interpreta HTML", () => {
  const { $, click } = load();
  click($('#mappa-svg [data-id="crm"]'));
  assert.strictEqual($("#mappa-panel img, #mappa-panel script"), null);
});

test("tastiera: Invio seleziona, Esc azzera", () => {
  const { $, key } = load();
  const g = $('#mappa-svg [data-id="pratiche"]');
  assert.strictEqual(g.getAttribute("tabindex"), "0");
  key(g, "Enter");
  assert.strictEqual($("#mappa-panel").getAttribute("data-sel"), "pratiche");
  key(g.ownerDocument.body, "Escape");
  assert.strictEqual($("#mappa-panel").getAttribute("data-sel"), null);
  assert.strictEqual($('#mappa-svg [data-id="eshop"]').classList.contains("m-dim"), false);
});

test("percorsi: ognuno elenca i passaggi e un clic sul passaggio evidenzia i suoi nodi", () => {
  const { $, $$, click } = load();
  for (const f of ["acquisto", "fda", "api", "settimanale"]) {
    click($(`#mappa-tools [data-flow="${f}"]`));
    assert.strictEqual($(`#mappa-tools [data-flow="${f}"]`).getAttribute("aria-pressed"), "true");
    assert.ok($$("#mappa-panel li").length >= 4, f);
  }
  click($('#mappa-tools [data-flow="fda"]'));
  click($('#mappa-panel li[data-step="3"]'));
  assert.ok(!$('#mappa-svg [data-id="fda"]').classList.contains("m-dim"));
  assert.ok($('#mappa-svg [data-id="suite"]').classList.contains("m-dim"));
});

test("Mostra tutto azzera selezione e percorso", () => {
  const { $, $$, click } = load();
  click($('#mappa-tools [data-flow="api"]'));
  click($("#mappa-reset"));
  assert.strictEqual($$("#mappa-svg .m-dim").length, 0);
  assert.strictEqual($('#mappa-tools [data-flow="api"]').getAttribute("aria-pressed"), "false");
});

test("ogni dispositivo cliccabile ha una scheda informativa (nessun pannello vuoto)", () => {
  const { $, $$, click } = load();
  for (const g of $$("#mappa-svg g[tabindex]")) {
    click(g);
    assert.ok($("#mappa-panel h3").textContent.length > 2, g.getAttribute("data-id"));
    assert.ok($("#mappa-panel p").textContent.length > 10, g.getAttribute("data-id"));
  }
});

test("le schede sotto la mappa hanno link reali (letti dal controllo settimanale)", () => {
  const { $$ } = load();
  const hrefs = $$("#mappa-cards a").map((a) => a.getAttribute("href"));
  assert.strictEqual(hrefs.length, 7);
  for (const h of hrefs) assert.ok(/^https:\/\/touchandgo-[a-z]+\.netlify\.app/.test(h), h);
});
