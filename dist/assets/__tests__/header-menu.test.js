// Header: i controlli secondari (agente, assistenza, sito, reset) stanno in un
// unico menu a tendina; nell'header restano marchio, lingua e pulsante Menu.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function boot(t, patch) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  dom.window.localStorage.setItem("tg_onboarded", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, ctx);
  dom.window.render();
  return dom.window;
}

test("fuori dalla cover: un solo pulsante Menu, voci dentro il menu, chiuso di default", (t) => {
  const w = boot(t, { mode: "turista", screen: "home" });
  const d = w.document;
  const btn = d.getElementById("header-menu-btn");
  const menu = d.getElementById("header-menu");
  assert.ok(btn && menu);
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.ok(!menu.classList.contains("open"));
  assert.equal(d.querySelectorAll(".header-actions > button, .header-actions > a").length, 1, "nell'header resta solo il pulsante Menu (più il selettore lingua)");
  for (const id of ["header-assistant-btn", "header-support-btn", "header-reset"]) assert.ok(menu.querySelector("#" + id), id + " nel menu");
  assert.ok(menu.querySelector(".header-site-link"));
});

test("click sul pulsante apre il menu, click su una voce o Esc lo chiude", (t) => {
  const w = boot(t, { mode: "turista", screen: "home" });
  const d = w.document;
  const btn = d.getElementById("header-menu-btn"), menu = d.getElementById("header-menu");
  btn.click();
  assert.ok(menu.classList.contains("open"));
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" }));
  assert.ok(!menu.classList.contains("open"));
  btn.click();
  d.getElementById("header-support-btn").click();
  assert.ok(true);
});

test("modalità partner: nel menu niente voci turista-only", (t) => {
  const w = boot(t, { mode: "partner", screen: "home" });
  const menu = w.document.getElementById("header-menu");
  assert.equal(menu.querySelector("#header-assistant-btn"), null);
  assert.equal(menu.querySelector("#header-support-btn"), null);
  assert.ok(menu.querySelector("#header-reset"));
});

test("sulla cover nessun menu: lingua e Reset diretti", (t) => {
  const w = boot(t, { mode: "turista", screen: "cover" });
  assert.equal(w.document.getElementById("header-menu-btn"), null);
  assert.ok(w.document.getElementById("header-reset"));
});
