// Restyle A: nella home l'azione principale precede i banner informativi.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("home: la capture-card viene prima di fiducia, merci vietate e promemoria posizione", (t) => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, { url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("off"));
  dom.window.localStorage.setItem("tg_lang", "it");
  dom.window.localStorage.setItem("tg_onboarded", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, {mode:"turista", screen:"home", pickupSource:"manual", locationReminderDismissed:false});`, ctx);
  dom.window.render();
  const d = dom.window.document;
  const cap = d.querySelector(".capture-card");
  const info = d.querySelector(".home-info");
  assert.ok(cap && info);
  assert.ok(cap.compareDocumentPosition(info) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "i banner informativi stanno dopo la fotocamera");
  assert.ok(info.querySelector(".location-reminder"), "il promemoria posizione è nel blocco informativo");
});
