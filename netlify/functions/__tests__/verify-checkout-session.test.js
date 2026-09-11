// Verifica verify-checkout-session.js — vedi MANUALE.md, sezione
// "Pagamento reale con Stripe Checkout". Copre in particolare i punti
// (2)/(3) della verifica finale richiesta:
//   (2) un session_id con payment_status diverso da "paid" NON deve mai
//       risultare paid:true (che è il segnale che il client usa per
//       decidere se marcare qualcosa come ritirato — vedi anche
//       checkout-payment.test.js per la verifica end-to-end lato client).
//   (3) SOLO un pagamento realmente verificato "paid" da Stripe restituisce
//       paid:true — mai sulla sola presenza di un session_id, mai su un
//       errore, mai su un'eccezione.
//
// Stesso pattern di mocking già usato in questo repository: @netlify/blobs
// finto (rate limit) + global.fetch finto (chiamata Stripe) — nessuna
// rete reale.

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

const handlerPath = path.join(__dirname, "..", "verify-checkout-session.js");
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
const originalKey = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  resetStores();
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.STRIPE_SECRET_KEY = originalKey;
});

function mockStripeGetFetch(sessionResponse, { status = 200 } = {}) {
  let lastUrl = null;
  let lastHeaders = null;
  global.fetch = (url, opts) => {
    lastUrl = url;
    lastHeaders = (opts && opts.headers) || {};
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => sessionResponse,
    });
  };
  return { getLastUrl: () => lastUrl, getLastHeaders: () => lastHeaders };
}

// ---------------------------------------------------------------------
// (3) SOLO payment_status === "paid" restituisce paid:true
// ---------------------------------------------------------------------

test('payment_status "paid" -> paid:true', async () => {
  const mod = freshModule();
  mockStripeGetFetch({ id: "cs_test_1", payment_status: "paid", amount_total: 5025, currency: "eur" });
  const res = await mod.handler(makeEvent({ sessionId: "cs_test_1" }));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.paid, true);
  assert.equal(data.sessionId, "cs_test_1");
  assert.equal(data.amountTotal, 5025);
});

test("la richiesta a Stripe è una GET verso /v1/checkout/sessions/{id}, con la secret key come Bearer token", async () => {
  const mod = freshModule();
  const { getLastUrl, getLastHeaders } = mockStripeGetFetch({ id: "cs_abc123", payment_status: "paid" });
  await mod.handler(makeEvent({ sessionId: "cs_abc123" }));
  assert.equal(getLastUrl(), "https://api.stripe.com/v1/checkout/sessions/cs_abc123");
  assert.equal(getLastHeaders().Authorization, "Bearer sk_test_fake");
});

test("il session_id viene URL-encoded prima di essere usato nel path (nessuna injection nel path Stripe)", async () => {
  const mod = freshModule();
  const { getLastUrl } = mockStripeGetFetch({ id: "x", payment_status: "paid" });
  await mod.handler(makeEvent({ sessionId: "cs_test/../../evil?x=1" }));
  assert.equal(getLastUrl(), `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent("cs_test/../../evil?x=1")}`);
});

// ---------------------------------------------------------------------
// (2) Qualunque payment_status diverso da "paid" -> paid:false, MAI true
// ---------------------------------------------------------------------

for (const status of ["unpaid", "no_payment_required", "", null, undefined, "PAID", "Paid"]) {
  test(`payment_status ${JSON.stringify(status)} -> paid:false (mai true su un valore diverso da esattamente "paid")`, async () => {
    const mod = freshModule();
    mockStripeGetFetch({ id: "cs_test_2", payment_status: status, amount_total: 5025 });
    const res = await mod.handler(makeEvent({ sessionId: "cs_test_2" }));
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.paid, false);
  });
}

test('sessione Stripe con mode "payment" ma status "open" (checkout non ancora completato) -> paid:false', async () => {
  const mod = freshModule();
  mockStripeGetFetch({ id: "cs_test_3", payment_status: "unpaid", status: "open" });
  const res = await mod.handler(makeEvent({ sessionId: "cs_test_3" }));
  const data = JSON.parse(res.body);
  assert.equal(data.paid, false);
});

// ---------------------------------------------------------------------
// Fail-closed su ogni tipo di errore/eccezione
// ---------------------------------------------------------------------

test("session_id inesistente (Stripe risponde 404) -> paid:false, mai un errore che blocchi il client", async () => {
  const mod = freshModule();
  mockStripeGetFetch({ error: { message: "No such checkout session" } }, { status: 404 });
  const res = await mod.handler(makeEvent({ sessionId: "cs_non_esiste" }));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.paid, false);
  assert.ok(data.error);
});

test("session_id mancante -> paid:false, nessuna chiamata Stripe", async () => {
  const mod = freshModule();
  let fetchCalled = false;
  global.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato"));
  };
  const res = await mod.handler(makeEvent({}));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.paid, false);
  assert.equal(fetchCalled, false);
});

test("session_id vuoto/spazi -> paid:false, nessuna chiamata Stripe", async () => {
  const mod = freshModule();
  let fetchCalled = false;
  global.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato"));
  };
  const res = await mod.handler(makeEvent({ sessionId: "   " }));
  const data = JSON.parse(res.body);
  assert.equal(data.paid, false);
  assert.equal(fetchCalled, false);
});

test("STRIPE_SECRET_KEY non configurata -> paid:false, nessuna chiamata Stripe (mai un 500 che il client non saprebbe interpretare come 'non pagato')", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const mod = freshModule();
  let fetchCalled = false;
  global.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato"));
  };
  const res = await mod.handler(makeEvent({ sessionId: "cs_test_1" }));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.paid, false);
  assert.equal(fetchCalled, false);
});

test("un'eccezione di rete verso Stripe -> paid:false, statusCode 200 (mai un crash che il client non gestirebbe)", async () => {
  const mod = freshModule();
  global.fetch = () => {
    throw new Error("connessione interrotta");
  };
  const res = await mod.handler(makeEvent({ sessionId: "cs_test_1" }));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.paid, false);
});

test("una risposta Stripe malformata (json() lancia) -> paid:false, mai un'eccezione propagata", async () => {
  const mod = freshModule();
  global.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json");
      },
    });
  const res = await mod.handler(makeEvent({ sessionId: "cs_test_1" }));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.paid, false);
});

// ---------------------------------------------------------------------
// Altri comportamenti standard già in uso ovunque nel repository
// ---------------------------------------------------------------------

test("rate limit (30 richieste/60min per IP), stesso schema delle altre function del repository", async () => {
  const mod = freshModule();
  mockStripeGetFetch({ id: "cs_test_1", payment_status: "paid" });
  const ip = "8.8.8.8";
  let last;
  for (let i = 0; i < 31; i++) {
    last = await mod.handler(makeEvent({ sessionId: "cs_test_1" }, ip));
  }
  assert.equal(last.statusCode, 429);
});

test("un metodo diverso da POST viene rifiutato", async () => {
  const mod = freshModule();
  const res = await mod.handler({ httpMethod: "GET", headers: {} });
  assert.equal(res.statusCode, 405);
});
