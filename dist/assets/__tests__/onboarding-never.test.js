// Onboarding: «Non mostrare più» lo spegne per sempre su questo dispositivo.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function boot(t, onboarded) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  if (onboarded) dom.window.localStorage.setItem("tg_onboarded", "1");
  vm.runInContext(SRC, dom.getInternalVMContext(), { filename: "app.js" });
  return dom.window;
}

test("primo avvio: onboarding con «Non mostrare più»", (t) => {
  const w = boot(t, false);
  assert.equal(w.eval("state.screen"), "onboarding");
  assert.equal(w.document.querySelector(".ob-never-btn").textContent, "Non mostrare più");
});

test("«Non mostrare più»: va alla cover, segna il flag e al prossimo avvio non riparte", (t) => {
  const w = boot(t, false);
  w.document.querySelector(".ob-never-btn").click();
  assert.equal(w.eval("state.screen"), "cover");
  assert.equal(w.localStorage.getItem("tg_onboarded"), "1");
  const w2 = boot(t, true);
  assert.notEqual(w2.eval("state.screen"), "onboarding");
});

test("«Salta» da solo non segna il flag (ricompare al prossimo avvio)", (t) => {
  const w = boot(t, false);
  w.document.querySelector(".ob-skip-btn").click();
  assert.equal(w.localStorage.getItem("tg_onboarded"), null);
});

test("in inglese il pulsante è «Don't show again»", (t) => {
  const w = boot(t, false); w.localStorage.setItem("tg_lang", "en");
  w.eval('setLang("en")');
  assert.equal(w.document.querySelector(".ob-never-btn").textContent, "Don't show again");
});
