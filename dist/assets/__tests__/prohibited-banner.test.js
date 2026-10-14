// Banner fisso sulle merci vietate: home, conclusione, area partner, chat assistente e assistenza.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function boot(t, lang, patch) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  dom.window.fetch = () => Promise.reject(new Error("network disabled"));
  dom.window.localStorage.setItem("tg_lang", lang);
  dom.window.localStorage.setItem("tg_onboarded", "1");
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, ctx);
  dom.window.render();
  return dom.window.document;
}

test("banner merci vietate in italiano e inglese sulla home", (t) => {
  assert.match(boot(t, "it", { mode: "turista", screen: "home" }).querySelector(".prohibited-banner").textContent, /Non spediamo merci vietate/);
  assert.match(boot(t, "en", { mode: "turista", screen: "home" }).querySelector(".prohibited-banner").textContent, /prohibited goods/);
});

test("banner presente dove si genera la spedizione (concludi)", (t) => {
  assert.ok(boot(t, "it", { mode: "turista", screen: "conclude" }).querySelector(".prohibited-banner"));
});

test("banner presente nella chat assistente e nella richiesta di assistenza", (t) => {
  const d1 = boot(t, "it", { mode: "turista", screen: "home", assistantChatOpen: true });
  assert.ok(d1.querySelector(".assistant-chat-modal .prohibited-banner"));
  const d2 = boot(t, "it", { mode: "turista", screen: "home", supportModalOpen: true });
  assert.ok(d2.querySelector(".assistant-chat-modal .prohibited-banner"));
});

test("avviso predittivo AI nel risultato: solo se rischio possibile/probabile, con motivo", (t) => {
  const base = { object_it: "x", object_en: "x", weight_kg: 1, category: "Alimentari", confidence: "alta" };
  const mk = (extra) => {
    const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
      url: "https://touchandgo.test/", runScripts: "outside-only", pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    dom.window.fetch = () => Promise.reject(new Error("off"));
    dom.window.localStorage.setItem("tg_lang", "it");
    dom.window.localStorage.setItem("tg_onboarded", "1");
    const ctx = dom.getInternalVMContext();
    vm.runInContext(SRC, ctx, { filename: "app.js" });
    return { dom, ctx, result: { ...base, ...extra } };
  };
  const probe = (extra) => {
    const m = mk(extra);
    return vm.runInContext(`(${m.dom.window.ProhibitedRiskNotice ? "ProhibitedRiskNotice" : "ProhibitedRiskNotice"})(${JSON.stringify(m.result)})`, m.ctx);
  };
  assert.equal(probe({ prohibited_risk: "nessuno" }), null);
  assert.equal(probe({}), null);
  const n = probe({ prohibited_risk: "probabile", prohibited_reason_it: "Salumi verso gli USA." });
  assert.match(n.textContent, /Salumi verso gli USA/);
});
