// Verifica email di benvenuto (lead-signup + lead-mail) e disiscrizione
// (lead-unsubscribe): invio solo se configurato e solo alla prima iscrizione,
// errore di invio non rompe l'iscrizione, link firmato, GET non disiscrive.

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


const ENV = ["RESEND_API_KEY", "LEAD_MAIL_FROM", "LEAD_UNSUB_SECRET", "LEAD_SITE_URL"];
let sent;
const realFetch = global.fetch;
function path_(f) { return path.join(__dirname, "..", f); }
function fresh(f) { delete require.cache[require.resolve(path_(f))]; return require(path_(f)).handler; }
function freshAll() {
  delete require.cache[require.resolve(path_("../lib/lead-mail.js"))];
  return { signup: fresh("lead-signup.js"), unsub: fresh("lead-unsubscribe.js") };
}
function ev(body, ip) { return { httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip || "1.1.1.1" }, body: JSON.stringify(body) }; }
const lead = (o) => Object.assign({ email: "Maria@Example.com", consent: true }, o);
function configure() {
  process.env.RESEND_API_KEY = "k"; process.env.LEAD_MAIL_FROM = "Touch&Go <a@b.it>";
  process.env.LEAD_UNSUB_SECRET = "segreto-di-test"; process.env.LEAD_SITE_URL = "https://sito.test/";
}
beforeEach(() => {
  stores = {}; sent = [];
  ENV.forEach((k) => delete process.env[k]);
  global.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
});
test.after(() => { global.fetch = realFetch; });

test("senza configurazione: iscrizione ok, nessuna email", async () => {
  const { signup } = freshAll();
  assert.equal((await signup(ev(lead()))).statusCode, 200);
  assert.equal(sent.length, 0);
});

test("configurato: una email di benvenuto con link firmato e header List-Unsubscribe", async () => {
  configure();
  const { signup } = freshAll();
  assert.equal((await signup(ev(lead()))).statusCode, 200);
  assert.equal(sent.length, 1);
  const m = sent[0].body;
  assert.deepEqual(m.to, ["maria@example.com"]);
  assert.match(m.text, /https:\/\/sito\.test\/\.netlify\/functions\/lead-unsubscribe\?id=LD-[0-9a-f]+&t=[0-9a-f]{32}/);
  assert.match(m.headers["List-Unsubscribe"], /^<https:\/\/sito\.test/);
  assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const s = fakeBlobsModule.getStore("leads");
  const [{ key }] = (await s.list()).blobs;
  assert.ok((await s.get(key, { type: "json" })).welcomeSentAt);
});

test("seconda iscrizione con la stessa email: nessuna seconda email", async () => {
  configure();
  const { signup } = freshAll();
  await signup(ev(lead())); await signup(ev(lead()));
  assert.equal(sent.length, 1);
});

test("il servizio email risponde errore o lancia: l'iscrizione resta salvata e risponde 200", async () => {
  configure();
  const { signup } = freshAll();
  global.fetch = async () => { throw new Error("rete giù"); };
  assert.equal((await signup(ev(lead()))).statusCode, 200);
  const s = fakeBlobsModule.getStore("leads");
  const [{ key }] = (await s.list()).blobs;
  assert.equal((await s.get(key, { type: "json" })).welcomeSentAt, undefined);
  global.fetch = async () => ({ ok: false });
  assert.equal((await signup(ev(lead({ email: "x@y.it" })))).statusCode, 200);
});

async function savedLead() {
  const { signup } = freshAll();
  await signup(ev(lead()));
  const s = fakeBlobsModule.getStore("leads");
  const [{ key }] = (await s.list()).blobs;
  return { s, key };
}
function tokenFor(key) { return require(path_("../lib/lead-mail.js")).unsubToken(key); }

test("disiscrizione: GET mostra solo la conferma, POST disiscrive", async () => {
  configure();
  const { s, key } = await savedLead();
  const { unsub } = freshAll();
  const q = { id: key, t: tokenFor(key) };
  const g = await unsub({ httpMethod: "GET", queryStringParameters: q });
  assert.equal(g.statusCode, 200);
  assert.equal((await s.get(key, { type: "json" })).status, "new");
  const p = await unsub({ httpMethod: "POST", queryStringParameters: q });
  assert.equal(p.statusCode, 200);
  const after = await s.get(key, { type: "json" });
  assert.equal(after.status, "unsubscribed");
  assert.ok(after.unsubscribedAt);
});

test("disiscrizione con firma sbagliata o mancante: 400, nulla cambia", async () => {
  configure();
  const { s, key } = await savedLead();
  const { unsub } = freshAll();
  for (const t of ["", "0".repeat(32), "x"]) {
    const r = await unsub({ httpMethod: "POST", queryStringParameters: { id: key, t } });
    assert.equal(r.statusCode, 400);
  }
  assert.equal((await unsub({ httpMethod: "POST" })).statusCode, 400);
  assert.equal((await s.get(key, { type: "json" })).status, "new");
});

test("disiscrizione senza segreto configurato: sempre 400", async () => {
  const { unsub } = freshAll();
  assert.equal((await unsub({ httpMethod: "POST", queryStringParameters: { id: "LD-1", t: "a".repeat(32) } })).statusCode, 400);
});

test("disiscrizione: metodo PUT rifiutato", async () => {
  configure();
  const { unsub } = freshAll();
  assert.equal((await unsub({ httpMethod: "PUT", queryStringParameters: {} })).statusCode, 405);
});
