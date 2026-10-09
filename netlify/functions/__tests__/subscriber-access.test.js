// Verifica netlify/functions/subscriber-access.js — codice personale
// "ABB-…" dell'abbonato a Touchandgo-app per accedere dal PC a "Genera
// spedizione". Esecuzione: node --test  (dalla root del repository)
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
      async delete(key) {
        store.delete(key);
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

const handlerPath = path.join(__dirname, "..", "subscriber-access.js");
function freshModule() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath);
}
let ipCounter = 0;
function call(handler, body, ip) {
  return handler({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip || `10.0.0.${++ipCounter}` }, body: JSON.stringify(body) });
}
const parse = (res) => JSON.parse(res.body);

beforeEach(() => {
  stores = {};
  ipCounter = 0;
});

test("register: emette un codice ABB-XXXXXXXX senza caratteri ambigui, salvato nello store subscribers", async () => {
  const { handler, isSubscriberCode } = freshModule();
  const res = await call(handler, { action: "register" });
  assert.equal(res.statusCode, 200);
  const { code } = parse(res);
  assert.match(code, /^ABB-[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(isSubscriberCode(code), true);
  const rec = JSON.parse(stores["subscribers"].get(code));
  assert.equal(rec.code, code);
  assert.equal(rec.source, "app-simulated");
});

test("register: ogni chiamata emette un codice diverso", async () => {
  const { handler } = freshModule();
  const codes = new Set();
  for (let i = 0; i < 8; i++) codes.add(parse(await call(handler, { action: "register" })).code);
  assert.equal(codes.size, 8);
});

test("verify: codice emesso valido (anche con minuscole/spazi), inesistente o malformato -> valid:false, mai altro", async () => {
  const { handler } = freshModule();
  const { code } = parse(await call(handler, { action: "register" }));
  assert.deepEqual(parse(await call(handler, { action: "verify", code })), { valid: true });
  assert.deepEqual(parse(await call(handler, { action: "verify", code: "  " + code.toLowerCase() + " " })), { valid: true });
  assert.deepEqual(parse(await call(handler, { action: "verify", code: "ABB-AAAAAAAA" })), { valid: false });
  assert.deepEqual(parse(await call(handler, { action: "verify", code: "NDP924" })), { valid: false }, "un codice partner non è un codice abbonato");
  assert.deepEqual(parse(await call(handler, { action: "verify" })), { valid: false });
});

test("un codice partner esistente non diventa mai valido come abbonato (e viceversa un ABB- non è in 'partners')", async () => {
  stores["partners"] = new Map([["NDP924", JSON.stringify({ code: "NDP924" })]]);
  const { handler } = freshModule();
  assert.deepEqual(parse(await call(handler, { action: "verify", code: "NDP924" })), { valid: false });
  const { code } = parse(await call(handler, { action: "register" }));
  assert.equal(stores["partners"].has(code), false);
});

test("azione non valida -> 400; metodo diverso da POST -> 405", async () => {
  const { handler } = freshModule();
  assert.equal((await call(handler, { action: "boh" })).statusCode, 400);
  assert.equal((await handler({ httpMethod: "GET", headers: {} })).statusCode, 405);
});

test("rate limit: oltre 10 register/h per IP -> 429; oltre 30 verify/h per IP -> 429", async () => {
  const { handler } = freshModule();
  let last;
  for (let i = 0; i < 11; i++) last = await call(handler, { action: "register" }, "9.9.9.9");
  assert.equal(last.statusCode, 429);
  for (let i = 0; i < 31; i++) last = await call(handler, { action: "verify", code: "ABB-AAAAAAAA" }, "8.8.8.8");
  assert.equal(last.statusCode, 429);
});

test("register con email: la salva normalizzata; email non valida -> ignorata (codice emesso comunque, email null)", async () => {
  const { handler } = freshModule();
  const a = parse(await call(handler, { action: "register", email: "  Mario@Example.COM " })).code;
  assert.equal(JSON.parse(stores["subscribers"].get(a)).email, "mario@example.com");
  const b = parse(await call(handler, { action: "register", email: "non-una-email" })).code;
  assert.equal(JSON.parse(stores["subscribers"].get(b)).email, null);
});

test("attach-email: associa l'email UNA volta sola (mai sovrascritta); codice inesistente o email non valida -> attached:false", async () => {
  const { handler } = freshModule();
  const { code } = parse(await call(handler, { action: "register" }));
  assert.deepEqual(parse(await call(handler, { action: "attach-email", code, email: "a@b.it" })), { attached: true });
  assert.equal(JSON.parse(stores["subscribers"].get(code)).email, "a@b.it");
  assert.deepEqual(parse(await call(handler, { action: "attach-email", code, email: "altra@b.it" })), { attached: false });
  assert.equal(JSON.parse(stores["subscribers"].get(code)).email, "a@b.it", "l'email già associata non si cambia");
  const { code: c2 } = parse(await call(handler, { action: "register" }));
  assert.deepEqual(parse(await call(handler, { action: "attach-email", code: c2, email: "no" })), { attached: false });
  assert.deepEqual(parse(await call(handler, { action: "attach-email", code: "ABB-AAAAAAAA", email: "a@b.it" })), { attached: false });
});

test("un codice REVOCATO dallo staff (revoked:true) non è più valido e non accetta email", async () => {
  const { handler } = freshModule();
  const { code } = parse(await call(handler, { action: "register" }));
  const rec = JSON.parse(stores["subscribers"].get(code));
  rec.revoked = true;
  stores["subscribers"].set(code, JSON.stringify(rec));
  assert.deepEqual(parse(await call(handler, { action: "verify", code })), { valid: false });
  assert.deepEqual(parse(await call(handler, { action: "attach-email", code, email: "a@b.it" })), { attached: false });
  rec.revoked = false;
  stores["subscribers"].set(code, JSON.stringify(rec));
  assert.deepEqual(parse(await call(handler, { action: "verify", code })), { valid: true }, "riattivato: torna valido");
});
