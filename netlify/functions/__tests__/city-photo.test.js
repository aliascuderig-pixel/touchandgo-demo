// Verifica netlify/functions/city-photo.js — foto reale del punto di
// ritiro via Wikipedia/Wikimedia Commons, con caching su Netlify Blobs
// (mai una chiamata diretta dal client, vedi MANUALE.md). Copre:
// (1) foto recuperata correttamente per città reali del progetto, con
//     attribuzione quando la licenza reale la richiede;
// (2) fallback onesto quando la città non ha una foto disponibile;
// (3) fallback onesto quando la chiamata a Wikipedia fallisce/va in
//     timeout — mai un 500, mai propagato al client come errore bloccante;
// (4) caching: una seconda richiesta per la stessa città non richiama
//     affatto Wikipedia/Commons;
// (5) unità: extractCommonsFileTitle()/licenseRequiresCredit();
// (6) nessuna regressione: rate limit, validazione, metodo.
//
// Stesso pattern di mocking già usato in questo repository (vedi
// estimate-duty.test.js): @netlify/blobs finto (rate limit + cache) +
// global.fetch finto (Wikipedia + Commons).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

let stores = {};
function resetStores() {
  stores = {};
}
const fakeBlobsModule = {
  getStore(opts) {
    const name = typeof opts === "string" ? opts : opts.name;
    if (!stores[name]) stores[name] = new Map();
    const store = stores[name];
    return {
      async get(key, { type } = {}) {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      async setJSON(key, value) {
        store.set(key, JSON.stringify(value));
      },
      async list() {
        return { blobs: Array.from(store.keys()).map((key) => ({ key })) };
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@netlify/blobs") return fakeBlobsModule;
  return originalLoad.call(this, request, ...args);
};

const handlerPath = path.join(__dirname, "..", "city-photo.js");
function freshModule() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath);
}

function makeEvent(body, ip) {
  return {
    httpMethod: "POST",
    headers: { "x-nf-client-connection-ip": ip || "127.0.0.1" },
    body: JSON.stringify(body || {}),
  };
}

const originalFetch = global.fetch;

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  global.fetch = originalFetch;
});

// Risposta page/summary tipo per una città con foto reale.
function wikipediaSummaryReply({ hasImage = true } = {}) {
  return {
    ok: true,
    json: async () =>
      hasImage
        ? {
            originalimage: { source: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Catania_-_panorama.jpg/1200px-Catania_-_panorama.jpg" },
            thumbnail: { source: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Catania_-_panorama.jpg/300px-Catania_-_panorama.jpg" },
          }
        : { extract: "Nessuna immagine per questa pagina." },
  };
}

function commonsImageInfoReply({ licenseShortName = "CC BY-SA 4.0", artist = "Mario Rossi" } = {}) {
  return {
    ok: true,
    json: async () => ({
      query: {
        pages: {
          "123": {
            imageinfo: [
              {
                extmetadata: {
                  LicenseShortName: { value: licenseShortName },
                  Artist: { value: `<a href="//example.org/u/MarioRossi">${artist}</a>` },
                },
              },
            ],
          },
        },
      },
    }),
  };
}

function mockFetchRouter({ wikipedia, commons } = {}) {
  const calls = { wikipedia: 0, commons: 0 };
  global.fetch = (url) => {
    if (String(url).includes("en.wikipedia.org")) {
      calls.wikipedia += 1;
      return wikipedia ? wikipedia() : Promise.resolve(wikipediaSummaryReply());
    }
    if (String(url).includes("commons.wikimedia.org")) {
      calls.commons += 1;
      return commons ? commons() : Promise.resolve(commonsImageInfoReply());
    }
    return Promise.reject(new Error("unexpected fetch: " + url));
  };
  return calls;
}

// ---------------------------------------------------------------------
// (1) Foto recuperata correttamente per città reali del progetto (Catania
// è il punto di ritiro di default — state.pickupPoint — Parigi e Londra
// compaiono come destinazioni reali nei test esistenti di questo
// repository), con attribuzione quando la licenza la richiede.
// ---------------------------------------------------------------------

for (const city of ["Catania", "Parigi", "Londra"]) {
  test(`foto recuperata per una città reale (${city}), con credito quando la licenza lo richiede (CC BY-SA)`, async () => {
    const mod = freshModule();
    mockFetchRouter();
    const res = await mod.handler(makeEvent({ city }, `1.1.1.${city.length}`));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.match(body.photoUrl, /upload\.wikimedia\.org/);
    assert.ok(body.credit, "una licenza CC BY-SA deve produrre un credito");
    assert.match(body.credit.text, /Mario Rossi/);
    assert.match(body.credit.text, /CC BY-SA 4\.0/);
    assert.match(body.credit.url, /commons\.wikimedia\.org\/wiki\/File:/);
  });
}

test("licenza di pubblico dominio: nessun credito mostrato, ma la foto resta presente", async () => {
  const mod = freshModule();
  mockFetchRouter({ commons: () => Promise.resolve(commonsImageInfoReply({ licenseShortName: "Public domain", artist: "" })) });
  const res = await mod.handler(makeEvent({ city: "Catania" }, "1.1.1.10"));
  const body = JSON.parse(res.body);
  assert.ok(body.photoUrl);
  assert.equal(body.credit, null, "pubblico dominio non richiede credito");
});

// ---------------------------------------------------------------------
// (2) Fallback onesto: città senza foto disponibile.
// ---------------------------------------------------------------------

test("città senza immagine su Wikipedia -> photoUrl:null, 200 (non un errore), Commons mai interrogato", async () => {
  const mod = freshModule();
  const calls = mockFetchRouter({ wikipedia: () => Promise.resolve(wikipediaSummaryReply({ hasImage: false })) });
  const res = await mod.handler(makeEvent({ city: "Borgo Sconosciuto Senza Pagina" }, "2.2.2.2"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.photoUrl, null);
  assert.equal(body.credit, null);
  assert.equal(calls.commons, 0, "senza una foto non ha senso interrogare Commons per l'attribuzione");
});

test("Wikipedia risponde 404 (pagina inesistente) -> fallback onesto, non un errore bloccante", async () => {
  const mod = freshModule();
  mockFetchRouter({ wikipedia: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) });
  const res = await mod.handler(makeEvent({ city: "CittàCheNonEsiste" }, "2.2.2.3"));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).photoUrl, null);
});

// ---------------------------------------------------------------------
// (3) Fallback onesto: la chiamata a Wikipedia fallisce/va in timeout.
// ---------------------------------------------------------------------

test("Wikipedia irraggiungibile (fetch rifiutata) -> 200 con photoUrl:null, mai un 500", async () => {
  const mod = freshModule();
  global.fetch = (url) => {
    if (String(url).includes("en.wikipedia.org")) return Promise.reject(new Error("network unreachable"));
    return Promise.reject(new Error("unexpected fetch: " + url));
  };
  const res = await mod.handler(makeEvent({ city: "Catania" }, "3.3.3.3"));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).photoUrl, null);
});

test("un fallimento su Wikipedia non viene messo in cache (si ritenta alla richiesta successiva)", async () => {
  const mod = freshModule();
  let attempt = 0;
  global.fetch = (url) => {
    if (String(url).includes("en.wikipedia.org")) {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("timeout"));
      return Promise.resolve(wikipediaSummaryReply());
    }
    if (String(url).includes("commons.wikimedia.org")) return Promise.resolve(commonsImageInfoReply());
    return Promise.reject(new Error("unexpected fetch: " + url));
  };
  const first = await mod.handler(makeEvent({ city: "Catania" }, "3.3.3.4"));
  assert.equal(JSON.parse(first.body).photoUrl, null, "primo tentativo fallito -> fallback");
  const second = await mod.handler(makeEvent({ city: "Catania" }, "3.3.3.4"));
  assert.ok(JSON.parse(second.body).photoUrl, "secondo tentativo (non cachato il fallimento) deve ritentare e riuscire");
});

test("Commons irraggiungibile per l'attribuzione non fa perdere la foto già trovata", async () => {
  const mod = freshModule();
  mockFetchRouter({ commons: () => Promise.reject(new Error("commons down")) });
  const res = await mod.handler(makeEvent({ city: "Catania" }, "3.3.3.5"));
  const body = JSON.parse(res.body);
  assert.ok(body.photoUrl, "la foto deve restare presente anche se l'attribuzione non è recuperabile");
  assert.equal(body.credit, null);
});

// ---------------------------------------------------------------------
// (4) Caching: una seconda richiesta per la stessa città non richiama
// Wikipedia/Commons.
// ---------------------------------------------------------------------

test("caching: la seconda richiesta per la stessa città (case-insensitive) non richiama affatto Wikipedia/Commons", async () => {
  const mod = freshModule();
  const calls = mockFetchRouter();
  const first = await mod.handler(makeEvent({ city: "Catania" }, "4.4.4.4"));
  assert.equal(calls.wikipedia, 1);
  assert.equal(calls.commons, 1);

  const second = await mod.handler(makeEvent({ city: "CATANIA" }, "4.4.4.5"));
  assert.equal(calls.wikipedia, 1, "nessuna nuova chiamata a Wikipedia per una città già in cache");
  assert.equal(calls.commons, 1, "nessuna nuova chiamata a Commons per una città già in cache");
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
});

test("caching: città diverse restano cache separate", async () => {
  const mod = freshModule();
  const calls = mockFetchRouter();
  await mod.handler(makeEvent({ city: "Catania" }, "4.4.4.6"));
  await mod.handler(makeEvent({ city: "Parigi" }, "4.4.4.7"));
  assert.equal(calls.wikipedia, 2, "due città distinte devono generare due chiamate reali");
});

// ---------------------------------------------------------------------
// (5) Unità: extractCommonsFileTitle() / licenseRequiresCredit().
// ---------------------------------------------------------------------

test("extractCommonsFileTitle: URL di thumbnail -> nome file originale (non l'ultimo segmento, che è il thumbnail ridimensionato)", () => {
  const mod = freshModule();
  const title = mod.extractCommonsFileTitle(
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Catania_-_panorama.jpg/1200px-Catania_-_panorama.jpg"
  );
  assert.equal(title, "Catania_-_panorama.jpg");
});

test("extractCommonsFileTitle: URL diretto (non thumbnail) -> ultimo segmento", () => {
  const mod = freshModule();
  const title = mod.extractCommonsFileTitle("https://upload.wikimedia.org/wikipedia/commons/a/ab/Catania_-_panorama.jpg");
  assert.equal(title, "Catania_-_panorama.jpg");
});

test("extractCommonsFileTitle: URL non valido -> null, nessuna eccezione", () => {
  const mod = freshModule();
  assert.equal(mod.extractCommonsFileTitle("non-un-url"), null);
  assert.equal(mod.extractCommonsFileTitle(""), null);
});

test("licenseRequiresCredit: pubblico dominio/CC0 -> false", () => {
  const mod = freshModule();
  assert.equal(mod.licenseRequiresCredit("Public domain"), false);
  assert.equal(mod.licenseRequiresCredit("CC0 1.0"), false);
  assert.equal(mod.licenseRequiresCredit(null), false);
});

test("licenseRequiresCredit: CC BY / CC BY-SA / GFDL / licenza sconosciuta -> true (default sicuro: richiede credito)", () => {
  const mod = freshModule();
  assert.equal(mod.licenseRequiresCredit("CC BY-SA 4.0"), true);
  assert.equal(mod.licenseRequiresCredit("CC BY 3.0"), true);
  assert.equal(mod.licenseRequiresCredit("GFDL"), true);
  assert.equal(mod.licenseRequiresCredit("Qualche licenza mai vista prima"), true);
});

// ---------------------------------------------------------------------
// (6) Nessuna regressione: rate limit, validazione, metodo.
// ---------------------------------------------------------------------

test("città mancante -> 400, nessuna chiamata a Wikipedia", async () => {
  const mod = freshModule();
  let called = false;
  global.fetch = () => { called = true; return Promise.reject(new Error("non deve mai essere chiamato")); };
  const res = await mod.handler(makeEvent({}, "5.5.5.5"));
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test("metodo diverso da POST -> 405", async () => {
  const mod = freshModule();
  const res = await mod.handler({ httpMethod: "GET", headers: {} });
  assert.equal(res.statusCode, 405);
});

test("rate limiting: oltre 20 richieste/ora dallo stesso IP -> 429", async () => {
  const mod = freshModule();
  mockFetchRouter();
  let lastRes;
  for (let i = 0; i < 21; i++) {
    lastRes = await mod.handler(makeEvent({ city: `Città${i}` }, "6.6.6.6"));
  }
  assert.equal(lastRes.statusCode, 429);
});
