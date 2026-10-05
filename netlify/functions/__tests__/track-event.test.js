// Verifica track-event.js: endpoint pubblico per gli eventi di engagement
// del client (vedi MANUALE.md, "Analytics di engagement"). Copre: rifiuto
// metodo diverso da POST, rifiuto JSON malformato, rifiuto evento fuori
// allowlist (comportamento voluto di usage-analytics.js: un evento non
// previsto non deve mai passare silenzioso), ruolo sconosciuto riportato a
// "turista" invece di essere rifiutato, incremento corretto del rollup
// giornaliero per chiamate ripetute dello stesso evento, e rispetto del
// rate limiting (stesso fake minimale di @netlify/blobs già usato altrove
// in questa cartella). Esecuzione: node --test

const { test, beforeEach } = require("node:test");
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

const handlerPath = path.join(__dirname, "..", "track-event.js");
function freshHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath).handler;
}

function makeEvent(body, ip) {
  return {
    httpMethod: "POST",
    headers: { "x-nf-client-connection-ip": ip || "127.0.0.1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

beforeEach(() => {
  resetStores();
});

test("metodo diverso da POST: rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler(Object.assign(makeEvent({ event: "app_opened" }), { httpMethod: "GET" }));
  assert.equal(res.statusCode, 405);
});

test("JSON malformato: 400, nessun crash", async () => {
  const handler = freshHandler();
  const res = await handler({ httpMethod: "POST", headers: {}, body: "{non-json" });
  assert.equal(res.statusCode, 400);
});

test("evento fuori allowlist: rifiutato con 400, mai registrato silenziosamente", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent({ event: "evento_mai_previsto" }));
  assert.equal(res.statusCode, 400);
});

test("evento valido: 200, registrato nello store usage-analytics con ruolo turista", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent({ event: "app_opened", role: "turista" }));
  assert.equal(res.statusCode, 200);
  const store = stores["usage-analytics"];
  assert.ok(store, "lo store usage-analytics deve esistere dopo un evento valido");
  const keys = Array.from(store.keys());
  assert.equal(keys.length, 1);
  assert.match(keys[0], /__demo__turista__app_opened$/);
  const value = JSON.parse(store.get(keys[0]));
  assert.equal(value.count, 1);
});

test("ruolo assente o non riconosciuto: riportato a 'turista', mai rifiutato (questa è l'app pubblica)", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent({ event: "app_opened", role: "qualcosa-di-inatteso" }));
  assert.equal(res.statusCode, 200);
  const store = stores["usage-analytics"];
  const keys = Array.from(store.keys());
  assert.match(keys[0], /__demo__turista__app_opened$/);
});

test("due chiamate dello stesso evento nello stesso giorno: un solo rollup, count a 2", async () => {
  const handler = freshHandler();
  await handler(makeEvent({ event: "classification_completed", role: "turista" }));
  await handler(makeEvent({ event: "classification_completed", role: "turista" }));
  const store = stores["usage-analytics"];
  const keys = Array.from(store.keys());
  assert.equal(keys.length, 1);
  const value = JSON.parse(store.get(keys[0]));
  assert.equal(value.count, 2);
});

test("ogni evento della allowlist viene accettato (purchase_saved, agent_chat_opened)", async () => {
  const handler = freshHandler();
  for (const event of ["purchase_saved", "agent_chat_opened"]) {
    const res = await handler(makeEvent({ event }));
    assert.equal(res.statusCode, 200, `${event} deve essere accettato`);
  }
});

test("rate limit: 429 oltre la soglia, stesso IP", async () => {
  const handler = freshHandler();
  let last;
  for (let i = 0; i < 61; i++) {
    last = await handler(makeEvent({ event: "app_opened" }, "9.9.9.9"));
  }
  assert.equal(last.statusCode, 429);
});

test("rate limit: IP diversi hanno contatori indipendenti", async () => {
  const handler = freshHandler();
  for (let i = 0; i < 60; i++) {
    await handler(makeEvent({ event: "app_opened" }, "1.1.1.1"));
  }
  const res = await handler(makeEvent({ event: "app_opened" }, "2.2.2.2"));
  assert.equal(res.statusCode, 200);
});
