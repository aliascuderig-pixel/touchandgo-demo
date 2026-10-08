// Verifica la musica dell'onboarding (MANUALE.md, "Onboarding animato"):
// sempre spenta all'avvio (i browser vietano l'audio automatico), si accende
// e si spegne col pulsante, si ferma uscendo dall'onboarding, e il file
// audio esiste davvero nel deploy. Stessa tecnica di support-trail.test.js:
// app.js reale in una finestra jsdom isolata.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function bootOnboarding(t, { playRejects } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error("network disabled in test"));
  window.localStorage.setItem("tg_lang", "it");
  // Nessun "tg_onboarded": l'app parte dall'onboarding.
  const audios = [];
  window.Audio = function (url) {
    this.url = url;
    this.volume = 1;
    this.paused = true;
    this.play = () => {
      this.paused = false;
      return playRejects ? Promise.reject(new Error("NotAllowed")) : Promise.resolve();
    };
    this.pause = () => {
      this.paused = true;
    };
    audios.push(this);
  };
  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });
  return { window, document: window.document, context, audios };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("il file audio dell'onboarding esiste ed è referenziato dal codice", () => {
  const m = APP_JS_SOURCE.match(/ONBOARDING_MUSIC_URL = "\/assets\/([^"]+)"/);
  assert.ok(m, "ONBOARDING_MUSIC_URL non trovato");
  assert.ok(fs.statSync(path.join(__dirname, "..", m[1])).size > 50000, "file audio vuoto o troppo piccolo");
});

test("all'avvio l'onboarding è muto: nessun Audio creato, pulsante spento", (t) => {
  const { document, audios } = bootOnboarding(t);
  const btn = document.querySelector(".ob-sound-btn");
  assert.ok(btn, "il pulsante musica deve esserci nell'onboarding");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.equal(btn.getAttribute("aria-label"), "Attiva la musica");
  assert.equal(audios.length, 0, "nessun audio deve partire senza un tap");
});

test("un tap accende la musica, un secondo tap la spegne con dissolvenza", async (t) => {
  const { document, audios } = bootOnboarding(t);
  const btn = document.querySelector(".ob-sound-btn");
  btn.click();
  assert.equal(audios.length, 1);
  assert.equal(audios[0].paused, false);
  assert.match(audios[0].url, /onboarding-music\.m4a$/);
  assert.equal(document.querySelector(".ob-sound-btn").getAttribute("aria-pressed"), "true");
  document.querySelector(".ob-sound-btn").click();
  await wait(600);
  assert.equal(audios[0].paused, true, "dopo la dissolvenza la musica è in pausa");
  assert.equal(document.querySelector(".ob-sound-btn").getAttribute("aria-pressed"), "false");
});

test("'Salta' ferma la musica e porta fuori dall'onboarding", async (t) => {
  const { document, audios } = bootOnboarding(t);
  document.querySelector(".ob-sound-btn").click();
  assert.equal(audios[0].paused, false);
  document.querySelector(".ob-skip-btn").click();
  await wait(600);
  assert.equal(audios[0].paused, true, "uscendo dall'onboarding la musica deve fermarsi davvero");
  assert.equal(document.querySelector(".ob-sound-btn"), null, "il pulsante non esiste fuori dall'onboarding");
});

test("cambiando lingua la musica già accesa continua e il pulsante resta acceso", (t) => {
  const { document, audios } = bootOnboarding(t);
  document.querySelector(".ob-sound-btn").click();
  document.querySelector('[data-lang="en"]').click();
  assert.equal(audios.length, 1, "nessun secondo audio dopo il cambio lingua");
  assert.equal(audios[0].paused, false, "la musica non si interrompe");
  const btn = document.querySelector(".ob-sound-btn");
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  assert.equal(btn.getAttribute("aria-label"), "Turn music off");
});

test("se l'audio non può partire (offline/bloccato) il pulsante torna spento, senza errori", async (t) => {
  const { document } = bootOnboarding(t, { playRejects: true });
  document.querySelector(".ob-sound-btn").click();
  await wait(20);
  assert.equal(document.querySelector(".ob-sound-btn").getAttribute("aria-pressed"), "false");
});
