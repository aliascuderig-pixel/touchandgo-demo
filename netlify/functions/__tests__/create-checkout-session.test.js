// Verifica create-checkout-session.js — vedi MANUALE.md, sezione "Pagamento
// reale con Stripe Checkout". Copre in particolare il punto (1) della
// verifica finale richiesta: il totale della sessione Checkout corrisponde
// ESATTAMENTE al prezzo consolidato ricalcolato server-side (netlify/lib/
// pricing.js), MAI un valore diverso — in particolare mai un "total"
// mandato dal client.
//
// Stesso pattern di mocking già usato in questo repository: @netlify/blobs
// finto (rate limit, come promo.test.js) + global.fetch finto (chiamata
// Stripe, come assistant.test.js/health.test.js) — nessuna rete reale.

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

const handlerPath = path.join(__dirname, "..", "create-checkout-session.js");
function freshModule() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath);
}

function makeEvent(body, { ip, origin } = {}) {
  return {
    httpMethod: "POST",
    headers: {
      "x-nf-client-connection-ip": ip || "127.0.0.1",
      origin: origin === undefined ? "https://touchandgo-suite.netlify.app" : origin,
    },
    body: JSON.stringify(body || {}),
  };
}

function item(overrides) {
  return Object.assign(
    {
      id: "TG-000001",
      addressLabel: "Casa — Via Test 1, Roma 00100, Italia",
      destinationCountry: "Italia",
      weightKg: 1,
      dims: { length_cm: 20, width_cm: 15, height_cm: 10 },
      pricingTier: "pieno",
      partnerDiscountAmount: 0,
    },
    overrides
  );
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

// Cattura l'ultima richiesta reale che l'handler avrebbe mandato a Stripe,
// senza chiamare nessuna rete davvero — body form-urlencoded, come lo
// vuole davvero l'API REST di Stripe.
function mockStripeCreateFetch({ status = 200, url = "https://checkout.stripe.com/c/pay/fake", id = "cs_test_fake" } = {}) {
  let lastCall = null;
  global.fetch = (fetchUrl, opts) => {
    lastCall = { url: fetchUrl, headers: opts.headers, body: new URLSearchParams(opts.body) };
    if (status >= 400) {
      return Promise.resolve({
        ok: false,
        status,
        json: async () => ({ error: { message: "carta rifiutata (simulata)" } }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ url, id }),
    });
  };
  return () => lastCall;
}

// ---------------------------------------------------------------------
// (1) Il totale corrisponde ESATTAMENTE al prezzo consolidato
//     server-side, mai un valore diverso da quello ricalcolato qui.
// ---------------------------------------------------------------------

test("il totale (unit_amount) della sessione Checkout corrisponde esattamente al prezzo consolidato ricalcolato server-side per un singolo oggetto", async () => {
  const mod = freshModule();
  const getLastCall = mockStripeCreateFetch();

  // Italia (zona "domestico"), 1kg reale, dims piccole (volumetrico
  // trascurabile): bracket <=1kg = 9€, margine 25% -> 11.25€ shipping,
  // + fee piena 39€ = 50.25€ -> 5025 centesimi.
  const res = await mod.handler(makeEvent({ items: [item({ weightKg: 1 })] }));
  assert.equal(res.statusCode, 200);

  const call = getLastCall();
  assert.equal(call.body.get("line_items[0][price_data][unit_amount]"), "5025");
  const data = JSON.parse(res.body);
  assert.equal(data.amountTotalCents, 5025);
});

test("il totale corrisponde esattamente al prezzo consolidato per un GRUPPO di più oggetti verso la stessa destinazione (una sola fee)", async () => {
  const mod = freshModule();
  const getLastCall = mockStripeCreateFetch();

  // Due oggetti, stessa destinazione (stesso addressLabel): peso reale
  // combinato 1+2=3kg -> bracket <=5kg = 14€, margine 25% -> 17.5€
  // shipping, + UNA sola fee piena 39€ = 56.5€ -> 5650 centesimi (non il
  // doppio di due fee separate).
  const dest = "Casa — Via Test 1, Roma 00100, Italia";
  const res = await mod.handler(
    makeEvent({
      items: [
        item({ id: "a", addressLabel: dest, weightKg: 1, dims: null }),
        item({ id: "b", addressLabel: dest, weightKg: 2, dims: null }),
      ],
    })
  );
  assert.equal(res.statusCode, 200);
  const call = getLastCall();
  assert.equal(call.body.get("line_items[0][price_data][unit_amount]"), "5650");
  assert.equal(call.body.get("line_items[1]"), null, "un solo line item per il gruppo consolidato, non uno per oggetto");
});

test("due destinazioni diverse generano DUE line item Stripe distinti, la cui somma è il totale complessivo", async () => {
  const mod = freshModule();
  const getLastCall = mockStripeCreateFetch();

  const res = await mod.handler(
    makeEvent({
      items: [
        item({ id: "a", addressLabel: "Dest A", destinationCountry: "Italia", weightKg: 1, dims: null }),
        item({ id: "b", addressLabel: "Dest B", destinationCountry: "Stati Uniti", weightKg: 1, dims: null }),
      ],
    })
  );
  assert.equal(res.statusCode, 200);
  const call = getLastCall();
  const amount0 = parseInt(call.body.get("line_items[0][price_data][unit_amount]"), 10);
  const amount1 = parseInt(call.body.get("line_items[1][price_data][unit_amount]"), 10);
  assert.ok(amount0 > 0 && amount1 > 0);
  assert.notEqual(amount0, amount1, "zone tariffarie diverse (Italia vs Stati Uniti) devono dare importi diversi");
  const data = JSON.parse(res.body);
  assert.equal(data.amountTotalCents, amount0 + amount1);
});

test("un 'total' o 'amount' mandato dal client viene sempre ignorato: il totale addebitato dipende SOLO dagli item ricalcolati", async () => {
  const mod = freshModule();
  const getLastCall = mockStripeCreateFetch();

  const res = await mod.handler(
    makeEvent({
      items: [item({ weightKg: 1 })],
      total: 1, // 1 centesimo — un client malevolo che prova a pagare quasi nulla
      amount: 1,
      amountTotalCents: 1,
    })
  );
  assert.equal(res.statusCode, 200);
  const call = getLastCall();
  // Lo stesso identico totale del primo test (5025), MAI 1.
  assert.equal(call.body.get("line_items[0][price_data][unit_amount]"), "5025");
});

test("uno sconto codice partner viene sottratto dalla fee, mai dal costo di spedizione", async () => {
  const mod = freshModule();
  const getLastCall = mockStripeCreateFetch();

  // Stesso caso del primo test (5025 centesimi) meno 10€ di sconto = 4025.
  const res = await mod.handler(makeEvent({ items: [item({ weightKg: 1, partnerDiscountAmount: 10 })] }));
  assert.equal(res.statusCode, 200);
  const call = getLastCall();
  assert.equal(call.body.get("line_items[0][price_data][unit_amount]"), "4025");
});

// ---------------------------------------------------------------------
// Validazione input — nessuna chiamata Stripe se gli item non sono validi.
// ---------------------------------------------------------------------

test("elenco item vuoto -> 400, nessuna chiamata Stripe", async () => {
  const mod = freshModule();
  let fetchCalled = false;
  global.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato"));
  };
  const res = await mod.handler(makeEvent({ items: [] }));
  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalled, false);
});

test("un item con peso fuori range (>=50kg) -> 400, nessuna chiamata Stripe", async () => {
  const mod = freshModule();
  let fetchCalled = false;
  global.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato"));
  };
  const res = await mod.handler(makeEvent({ items: [item({ weightKg: 60 })] }));
  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalled, false);
});

test("un item con pricingTier non riconosciuto -> 400, nessuna chiamata Stripe", async () => {
  const mod = freshModule();
  let fetchCalled = false;
  global.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato"));
  };
  const res = await mod.handler(makeEvent({ items: [item({ pricingTier: "gratis-per-me" })] }));
  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalled, false);
});

test("un item senza destinationCountry -> 400, nessuna chiamata Stripe", async () => {
  const mod = freshModule();
  let fetchCalled = false;
  global.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato"));
  };
  const res = await mod.handler(makeEvent({ items: [item({ destinationCountry: "" })] }));
  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalled, false);
});

// ---------------------------------------------------------------------
// Origine / URL di ritorno
// ---------------------------------------------------------------------

test("success_url/cancel_url usano l'origine della richiesta (header Origin), mai un dominio hardcoded", async () => {
  const mod = freshModule();
  const getLastCall = mockStripeCreateFetch();
  await mod.handler(makeEvent({ items: [item()] }, { origin: "https://deploy-preview-99--touchandgo-suite.netlify.app" }));
  const call = getLastCall();
  assert.equal(call.body.get("success_url"), "https://deploy-preview-99--touchandgo-suite.netlify.app/?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(call.body.get("cancel_url"), "https://deploy-preview-99--touchandgo-suite.netlify.app/");
});

test("nessun header Origin ma un Referer valido -> usa l'origine del Referer", async () => {
  const mod = freshModule();
  const getLastCall = mockStripeCreateFetch();
  const event = makeEvent({ items: [item()] }, { origin: null });
  delete event.headers.origin;
  event.headers.referer = "https://touchandgo-guest.netlify.app/qualche/pagina";
  await mod.handler(event);
  const call = getLastCall();
  assert.equal(call.body.get("success_url"), "https://touchandgo-guest.netlify.app/?session_id={CHECKOUT_SESSION_ID}");
});

test("nessun Origin né Referer -> 400, nessuna chiamata Stripe", async () => {
  const mod = freshModule();
  let fetchCalled = false;
  global.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato"));
  };
  const event = makeEvent({ items: [item()] }, { origin: null });
  delete event.headers.origin;
  const res = await mod.handler(event);
  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalled, false);
});

// ---------------------------------------------------------------------
// mode/currency fissi, come richiesto (Checkout, non un modulo custom)
// ---------------------------------------------------------------------

test("la sessione è sempre mode=payment, valuta eur, quantity 1 per riga", async () => {
  const mod = freshModule();
  const getLastCall = mockStripeCreateFetch();
  await mod.handler(makeEvent({ items: [item()] }));
  const call = getLastCall();
  assert.equal(call.body.get("mode"), "payment");
  assert.equal(call.body.get("line_items[0][price_data][currency]"), "eur");
  assert.equal(call.body.get("line_items[0][quantity]"), "1");
  assert.match(call.url, /^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions$/);
});

test("la chiave Stripe segreta è inviata come Bearer token, mai nel body/URL", async () => {
  const mod = freshModule();
  const getLastCall = mockStripeCreateFetch();
  await mod.handler(makeEvent({ items: [item()] }));
  const call = getLastCall();
  assert.equal(call.headers.Authorization, "Bearer sk_test_fake");
  assert.ok(!call.url.includes("sk_test_fake"));
  assert.equal(call.body.get("secret") || call.body.get("key"), null);
});

// ---------------------------------------------------------------------
// Altri comportamenti standard già in uso ovunque nel repository
// ---------------------------------------------------------------------

test("rate limit (20 richieste/60min per IP), stesso schema delle altre function del repository", async () => {
  const mod = freshModule();
  mockStripeCreateFetch();
  const ip = "9.9.9.9";
  let last;
  for (let i = 0; i < 21; i++) {
    last = await mod.handler(makeEvent({ items: [item()] }, { ip }));
  }
  assert.equal(last.statusCode, 429);
});

test("STRIPE_SECRET_KEY mancante -> 500, nessuna chiamata Stripe", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const mod = freshModule();
  let fetchCalled = false;
  global.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("non deve mai essere chiamato"));
  };
  const res = await mod.handler(makeEvent({ items: [item()] }));
  assert.equal(res.statusCode, 500);
  assert.equal(fetchCalled, false);
});

test("un errore Stripe (es. carta rifiutata) viene propagato con lo stesso status, senza far sembrare la sessione creata", async () => {
  const mod = freshModule();
  mockStripeCreateFetch({ status: 402 });
  const res = await mod.handler(makeEvent({ items: [item()] }));
  assert.equal(res.statusCode, 402);
  const data = JSON.parse(res.body);
  assert.ok(data.error);
  assert.equal(data.url, undefined);
});

test("un metodo diverso da POST viene rifiutato", async () => {
  const mod = freshModule();
  const res = await mod.handler({ httpMethod: "GET", headers: {} });
  assert.equal(res.statusCode, 405);
});
