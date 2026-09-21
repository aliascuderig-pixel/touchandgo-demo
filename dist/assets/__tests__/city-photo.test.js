// Verifica la foto reale del punto di ritiro sulla schermata Cover
// (dist/assets/app.js) — vedi MANUALE.md. Copre:
// 1) cityPhoto()/loadLocation() chiamano SEMPRE la function server-side
//    /.netlify/functions/city-photo, mai Wikipedia/Wikimedia direttamente
//    dal client.
// 2) CoverScreen() mostra la foto reale (fotorealistica, nessun filtro
//    "schizzo architettonico" — rimosso: injectSketchFilter()/#sketchFilter
//    non esistono più in questo file).
// 3) Fallback onesto: città non trovata / chiamata fallita -> nessuna foto,
//    ricade sul placeholder a gradiente esistente (.no-photo), mai
//    un'immagine rotta.
// 4) Credito discreto mostrato SOLO quando la function lo restituisce,
//    con escaping corretto (payload malevolo nel nome dell'autore).
//
// Stessa tecnica già usata in questo repository (vedi
// real-country-city.test.js): app.js REALE caricato in una finestra jsdom
// isolata via vm.runInContext — le "function" top-level sono proprietà di
// window in questo contesto (non le "const"/"let").

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_JS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function bootApp(t, { fetchMock } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://touchandgo.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = fetchMock || (() => Promise.reject(new Error("network disabled in test")));
  window.localStorage.setItem("tg_lang", "it");

  const context = dom.getInternalVMContext();
  vm.runInContext(APP_JS_SOURCE, context, { filename: "app.js" });

  return { window, document: window.document, context };
}

function setState(context, patch) {
  vm.runInContext(`Object.assign(state, ${JSON.stringify(patch)});`, context, { filename: "set-state.js" });
}
function getState(context, expr) {
  return vm.runInContext(`state.${expr}`, context, { filename: "get-state.js" });
}
function callGlobal(context, expr) {
  return vm.runInContext(expr, context, { filename: "call-global.js" });
}

// ---------------------------------------------------------------------
// 1) cityPhoto() chiama SOLO la function server-side, mai Wikipedia/
//    Wikimedia direttamente.
// ---------------------------------------------------------------------

test("cityPhoto(): chiama /.netlify/functions/city-photo (POST, { city }), mai un dominio Wikipedia/Wikimedia", async (t) => {
  let capturedUrl = null;
  let capturedBody = null;
  const { context } = bootApp(t, {
    // Il bootstrap di app.js chiama loadLocation() -> locateTourist() ->
    // fetch("https://ipapi.co/json/") in modo indipendente da questo test
    // (vedi in fondo al file: "if (!manualPickupAtStartup) loadLocation()")
    // — instradato qui per URL così non interferisce con l'unica chiamata
    // che questo test vuole osservare.
    fetchMock: (url, opts) => {
      if (!String(url).includes("city-photo")) return Promise.reject(new Error("unrelated fetch in test: " + url));
      capturedUrl = String(url);
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ photoUrl: "https://upload.wikimedia.org/x.jpg", credit: null }) });
    },
  });
  const result = await callGlobal(context, `cityPhoto("Catania")`);
  assert.equal(capturedUrl, "/.netlify/functions/city-photo");
  assert.equal(capturedBody.city, "Catania");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { photoUrl: "https://upload.wikimedia.org/x.jpg", credit: null });
});

test("nessuna chiamata diretta a en.wikipedia.org o commons.wikimedia.org è presente nel codice sorgente del client", () => {
  assert.ok(!APP_JS_SOURCE.includes("en.wikipedia.org"), "il client non deve più contattare Wikipedia direttamente");
  assert.ok(!APP_JS_SOURCE.includes("commons.wikimedia.org"), "il client non deve mai contattare Wikimedia Commons direttamente (solo la function server-side lo fa)");
});

test("loadLocation(): propaga photoUrl/credit della function in state.locationPhoto/state.locationPhotoCredit", async (t) => {
  const { context } = bootApp(t, {
    fetchMock: (url) => {
      if (String(url).includes("city-photo")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ photoUrl: "https://upload.wikimedia.org/catania.jpg", credit: { text: "Mario Rossi — CC BY-SA 4.0", url: "https://commons.wikimedia.org/wiki/File:Catania.jpg" } }),
        });
      }
      return Promise.reject(new Error("network disabled in test: " + url));
    },
  });
  // locateByGPS()/locateTourist() falliscono entrambe di default (nessun
  // mock per geolocation/ipapi.co): loadLocation() esce subito con
  // `return` prima di chiamare cityPhoto(). Qui verifichiamo quindi solo
  // cityPhoto() in isolamento (già fatto sopra) più l'assegnazione diretta
  // in loadLocation() via una place già nota, iniettando locateByGPS.
  await callGlobal(
    context,
    `(async () => {
      locateByGPS = async () => ({ city: "Catania", country: "Italia" });
      await loadLocation();
    })()`
  );
  assert.equal(getState(context, "locationPhoto"), "https://upload.wikimedia.org/catania.jpg");
  assert.equal(getState(context, "locationPhotoCredit").text, "Mario Rossi — CC BY-SA 4.0");
  assert.equal(getState(context, "pickupPoint"), "Catania");
});

// ---------------------------------------------------------------------
// 2) CoverScreen(): foto reale, nessuna stilizzazione residua.
// ---------------------------------------------------------------------

test("il filtro 'schizzo architettonico' non esiste più: nessun elemento #sketchFilter iniettato all'avvio", (t) => {
  const { document } = bootApp(t);
  assert.equal(document.getElementById("sketchFilter"), null);
});

test("injectSketchFilter non è più una funzione globale (rimossa, non solo resa inerte)", (t) => {
  const { window } = bootApp(t);
  assert.equal(typeof window.injectSketchFilter, "undefined");
});

test("CoverScreen con una foto: classe has-photo, sfondo impostato, nessun filter inline residuo", (t) => {
  const { document, context } = bootApp(t);
  setState(context, { locationPhoto: "https://upload.wikimedia.org/catania.jpg", pickupPoint: "Catania", screen: "cover" });
  callGlobal(context, "render()");

  const cover = document.querySelector(".cover-screen");
  assert.ok(cover.classList.contains("has-photo"));
  const bg = document.querySelector(".cover-bg-photo");
  assert.ok(bg, "il layer di sfondo deve esistere quando una foto è disponibile");
  assert.match(bg.style.backgroundImage, /catania\.jpg/);
  assert.equal(bg.style.filter, "", "nessun filtro deve più essere applicato inline sulla foto");
});

// ---------------------------------------------------------------------
// 3) Fallback onesto.
// ---------------------------------------------------------------------

test("città sconosciuta / nessuna foto trovata: CoverScreen ricade su .no-photo, mai un'immagine rotta", (t) => {
  const { document, context } = bootApp(t);
  setState(context, { locationPhoto: null, pickupPoint: "Borgo Sconosciuto", screen: "cover" });
  callGlobal(context, "render()");

  const cover = document.querySelector(".cover-screen");
  assert.ok(cover.classList.contains("no-photo"));
  assert.equal(cover.classList.contains("has-photo"), false);
  assert.equal(document.querySelector(".cover-bg-photo"), null, "nessun layer di sfondo senza una foto reale");
  assert.equal(document.querySelector(".cover-photo-credit"), null, "nessun credito senza una foto");
});

test("cityPhoto(): la chiamata di rete fallisce (timeout/errore) -> { photoUrl:null, credit:null }, mai un'eccezione propagata", async (t) => {
  const { context } = bootApp(t, {
    fetchMock: () => Promise.reject(new Error("network down")),
  });
  const result = await callGlobal(context, `cityPhoto("Catania")`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { photoUrl: null, credit: null });
});

test("cityPhoto(): risposta non-200 dalla function -> fallback onesto, non un'eccezione", async (t) => {
  const { context } = bootApp(t, {
    fetchMock: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: "boom" } }) }),
  });
  const result = await callGlobal(context, `cityPhoto("Catania")`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { photoUrl: null, credit: null });
});

// ---------------------------------------------------------------------
// 4) Credito discreto: mostrato solo quando presente, con escaping.
// ---------------------------------------------------------------------

test("credito mostrato quando presente: testo, link, e non intercetta il tap sull'intera Cover", (t) => {
  const { document, context } = bootApp(t);
  setState(context, {
    locationPhoto: "https://upload.wikimedia.org/catania.jpg",
    locationPhotoCredit: { text: "Mario Rossi — CC BY-SA 4.0", url: "https://commons.wikimedia.org/wiki/File:Catania.jpg" },
    pickupPoint: "Catania",
    screen: "cover",
  });
  callGlobal(context, "render()");

  const credit = document.querySelector(".cover-photo-credit");
  assert.ok(credit, "il credito deve comparire quando presente");
  assert.match(credit.textContent, /Mario Rossi — CC BY-SA 4\.0/);
  assert.equal(credit.getAttribute("href"), "https://commons.wikimedia.org/wiki/File:Catania.jpg");
  assert.equal(credit.getAttribute("target"), "_blank");
  assert.equal(credit.getAttribute("rel"), "noopener noreferrer");
});

test("nessun credito quando la function non ne restituisce uno (es. licenza di pubblico dominio)", (t) => {
  const { document, context } = bootApp(t);
  setState(context, {
    locationPhoto: "https://upload.wikimedia.org/catania.jpg",
    locationPhotoCredit: null,
    pickupPoint: "Catania",
    screen: "cover",
  });
  callGlobal(context, "render()");
  assert.equal(document.querySelector(".cover-photo-credit"), null);
});

test("escapeHtml sul testo del credito: un payload malevolo nel nome autore non crea mai un elemento reale", (t) => {
  const { document, window, context } = bootApp(t);
  const evil = `<img src=x onerror="window.__xssFired=true">`;
  setState(context, {
    locationPhoto: "https://upload.wikimedia.org/catania.jpg",
    locationPhotoCredit: { text: evil, url: "https://commons.wikimedia.org/wiki/File:Catania.jpg" },
    pickupPoint: "Catania",
    screen: "cover",
  });
  callGlobal(context, "render()");

  const credit = document.querySelector(".cover-photo-credit");
  assert.ok(credit, "il credito deve comunque comparire, con il testo malevolo neutralizzato");
  assert.equal(credit.querySelectorAll("img").length, 0, "nessun elemento <img> reale deve comparire nel DOM");
  assert.equal(window.__xssFired, undefined);
  assert.match(credit.textContent, /img src=x onerror=/, "il testo letterale (escapato) resta visibile, solo non eseguibile");
});
