// La prima schermata presenta l'app (come lo spot): cos'è, cosa fa, cosa NON è.
// Non mostra più la città/foto del punto di ritiro.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function boot(t, lang, patch) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", lang);
  dom.window.localStorage.setItem("tg_onboarded", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, ctx);
  dom.window.render();
  return dom.window.document;
}

test("cover IT: presentazione dell'app, nessuna città né foto", (t) => {
  const d = boot(t, "it", { screen: "cover", pickupPoint: "Catania", locationPhoto: "https://x/catania.jpg" });
  const txt = d.querySelector(".cover-screen").textContent;
  assert.match(txt, /UTILITY APP PER IL TURISTA/);
  assert.match(txt, /a portata di mano/);
  assert.match(txt, /Non siamo un corriere/);
  assert.equal(d.querySelectorAll(".cover-points li").length, 3);
  assert.doesNotMatch(txt, /Catania/);
  assert.equal(d.querySelector(".cover-caption"), null);
  assert.equal(d.querySelector(".cover-bg-photo"), null);
  assert.equal(d.querySelector(".cover-photo-credit"), null);
});

test("cover EN tradotta; il tap porta alla home", (t) => {
  const d = boot(t, "en", { screen: "cover", pickupPoint: "Catania" });
  assert.match(d.querySelector(".cover-screen").textContent, /We are not a courier/);
  d.querySelector(".cover-screen").click();
  assert.equal(d.querySelector(".cover-screen"), null);
});
