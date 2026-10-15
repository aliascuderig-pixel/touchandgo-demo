// Verifica lead-signup.js: iscrizione valida salvata con consenso
// registrato; email non valida o consenso mancante rifiutati senza
// scrivere; honeypot silenzioso; nessun duplicato; rate limiting.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

let stores = {};
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

const handlerPath = path.join(__dirname, "..", "lead-signup.js");
function freshHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath).handler;
}
function makeEvent(body, ip) {
  return { httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip || "127.0.0.1" }, body: JSON.stringify(body) };
}
const ok = (o) => Object.assign({ email: "Maria@Example.com ", consent: true, profile: "turista", source: "video" }, o);
const count = async () => (await fakeBlobsModule.getStore("leads").list()).blobs.length;

beforeEach(() => {
  stores = {};
});

test("iscrizione valida: salvata con consenso, email normalizzata", async () => {
  const res = await freshHandler()(makeEvent(ok()));
  assert.equal(res.statusCode, 200);
  const leads = fakeBlobsModule.getStore("leads");
  const [{ key }] = (await leads.list()).blobs;
  const saved = await leads.get(key, { type: "json" });
  assert.equal(saved.email, "maria@example.com");
  assert.equal(saved.consent, true);
  assert.ok(saved.consentVersion);
  assert.equal(saved.status, "new");
  assert.equal(saved.profile, "turista");
  assert.ok(saved.createdAt);
});

test("metodo GET: 405", async () => {
  assert.equal((await freshHandler()({ httpMethod: "GET" })).statusCode, 405);
});

test("email non valida: 400, nessuna scrittura", async () => {
  for (const email of ["", "abc", "a@b", "a b@c.it", 42, null]) {
    const res = await freshHandler()(makeEvent(ok({ email })));
    assert.equal(res.statusCode, 400, String(email));
  }
  assert.equal(await count(), 0);
});

test("consenso mancante o non true: 400", async () => {
  for (const consent of [false, undefined, "true", 1]) {
    const res = await freshHandler()(makeEvent(ok({ consent })));
    assert.equal(res.statusCode, 400);
  }
  assert.equal(await count(), 0);
});

test("profilo o fonte fuori elenco: 400", async () => {
  assert.equal((await freshHandler()(makeEvent(ok({ profile: "hacker" })))).statusCode, 400);
  assert.equal((await freshHandler()(makeEvent(ok({ source: "x" })))).statusCode, 400);
});

test("honeypot compilato: 200 ma niente salvato", async () => {
  const res = await freshHandler()(makeEvent(ok({ website: "http://spam" })));
  assert.equal(res.statusCode, 200);
  assert.equal(await count(), 0);
});

test("stessa email due volte: un solo record, data del primo consenso intatta", async () => {
  const h = freshHandler();
  await h(makeEvent(ok()));
  const leads = fakeBlobsModule.getStore("leads");
  const [{ key }] = (await leads.list()).blobs;
  const first = await leads.get(key, { type: "json" });
  const res = await h(makeEvent(ok({ email: "MARIA@example.com" })));
  assert.equal(res.statusCode, 200);
  assert.equal(await count(), 1);
  assert.equal((await leads.get(key, { type: "json" })).createdAt, first.createdAt);
});

test("rate limit: dalla 21ª richiesta stesso IP 429", async () => {
  const h = freshHandler();
  let last;
  for (let i = 0; i < 21; i++) last = await h(makeEvent(ok({ email: `u${i}@example.com` }), "9.9.9.9"));
  assert.equal(last.statusCode, 429);
});

test("JSON malformato: nessun crash, 500 generico", async () => {
  const res = await freshHandler()({ httpMethod: "POST", headers: {}, body: "{" });
  assert.equal(res.statusCode, 500);
});
