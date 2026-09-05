// Verifica il rate limiting aggiunto a promo.js in questa revisione di
// sicurezza (mancava, a differenza di quasi ogni altra function pubblica
// di questo repository). Il punto critico: senza limite, "check" da solo
// (che non consuma il codice, quindi non lascia traccia di un uso
// fallito) permetterebbe di enumerare i ~17 milioni di codici possibili
// in sequenza fino a trovarne uno valido.
//
// Copre esattamente i 4 punti richiesti: (1) le prime richieste sotto il
// limite funzionano normalmente; (2) oltre il limite, 429; (3) il limite
// è condiviso tra "check" e "redeem" (non doppio budget alternando le
// due azioni); (4) un turista che riprova il proprio codice un paio di
// volte non viene mai bloccato. Più un controllo che il limite è per IP
// (un altro IP non eredita il budget esaurito di un altro).
//
// Stesso fake minimale di @netlify/blobs già usato in save-review.test.js
// (nessuna rete/credenziale reale necessaria).
//
// Esecuzione: node --test  (dalla root del repository)

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

const handlerPath = path.join(__dirname, "..", "promo.js");
function freshHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath).handler;
}

function makeEvent(body, ip) {
  return {
    httpMethod: "POST",
    headers: { "x-nf-client-connection-ip": ip || "127.0.0.1" },
    body: JSON.stringify(body || {}),
  };
}

function seedPromoCode(code, overrides) {
  stores["promo"] = stores["promo"] || new Map();
  stores["promo"].set(code, JSON.stringify(Object.assign({ code, disabled: false }, overrides)));
}

beforeEach(() => {
  resetStores();
});

test("(1) le prime 20 richieste (sotto il limite) funzionano normalmente", async () => {
  seedPromoCode("ABC123");
  const handler = freshHandler();
  for (let i = 0; i < 20; i++) {
    const res = await handler(makeEvent({ action: "check", code: "ABC123" }, "1.1.1.1"));
    assert.equal(res.statusCode, 200, `richiesta ${i + 1}/20 non deve essere rifiutata`);
    assert.equal(JSON.parse(res.body).valid, true, `richiesta ${i + 1}/20 deve restare valida (codice mai consumato da "check")`);
  }
});

test("(2) oltre il limite (21esima richiesta), la richiesta viene rifiutata con 429", async () => {
  seedPromoCode("ABC123");
  const handler = freshHandler();
  let lastRes;
  for (let i = 0; i < 21; i++) {
    lastRes = await handler(makeEvent({ action: "check", code: "ABC123" }, "2.2.2.2"));
  }
  assert.equal(lastRes.statusCode, 429);
  const body = JSON.parse(lastRes.body);
  assert.equal(body.valid, false, "una risposta rate-limited non deve mai risultare valida lato client");
  assert.match(body.error, /Troppe richieste/);
});

test("(3) il limite è CONDIVISO tra \"check\" e \"redeem\" — alternarle non raddoppia il budget", async () => {
  // Codici diversi per ogni redeem così il "già usato" non si confonde con
  // il rate limit nell'interpretazione del test — quello che conta qui è
  // solo il conteggio delle richieste, non l'esito della validazione.
  for (let i = 0; i < 21; i++) seedPromoCode(`CODE${i}`);
  const handler = freshHandler();

  // 10 "check" (tutte sotto la soglia se il budget fosse per-azione).
  for (let i = 0; i < 10; i++) {
    const res = await handler(makeEvent({ action: "check", code: `CODE${i}` }, "3.3.3.3"));
    assert.equal(res.statusCode, 200, `check ${i + 1}/10 non deve essere rifiutata`);
  }
  // 10 "redeem" in più (totale 20 richieste combinate) — ancora sotto la
  // soglia CONDIVISA di 20.
  for (let i = 10; i < 20; i++) {
    const res = await handler(makeEvent({ action: "redeem", code: `CODE${i}` }, "3.3.3.3"));
    assert.equal(res.statusCode, 200, `redeem ${i + 1}/20 non deve essere rifiutata`);
  }
  // 21esima richiesta combinata (qualunque azione): se il budget fosse
  // separato per azione (20+20), questa passerebbe ancora — con un
  // budget condiviso, deve essere rifiutata.
  const res21 = await handler(makeEvent({ action: "redeem", code: "CODE20" }, "3.3.3.3"));
  assert.equal(res21.statusCode, 429, "la 21esima richiesta combinata (check+redeem) deve superare il budget CONDIVISO di 20");
});

test("(4) un turista che riprova il proprio codice un paio di volte (uso legittimo) non viene MAI bloccato", async () => {
  seedPromoCode("MIOCODICE");
  const handler = freshHandler();
  // Scenario realistico: check automatico al caricamento della pagina,
  // poi il turista lo ridigita a mano una o due volte (magari con un
  // typo nel mezzo) prima di procedere — ben sotto le 20 richieste/ora.
  const attempts = [
    { action: "check", code: "MIOCODICE" },
    { action: "check", code: "MIOCODIC" }, // typo
    { action: "check", code: "MIOCODICE" },
    { action: "redeem", code: "MIOCODICE" },
  ];
  for (const [i, body] of attempts.entries()) {
    const res = await handler(makeEvent(body, "4.4.4.4"));
    assert.notEqual(res.statusCode, 429, `tentativo legittimo ${i + 1} non deve mai essere bloccato dal rate limit`);
  }
});

test("il rate limit è per IP: un IP diverso non eredita il budget esaurito di un altro", async () => {
  seedPromoCode("ABC123");
  const handler = freshHandler();
  for (let i = 0; i < 21; i++) {
    await handler(makeEvent({ action: "check", code: "ABC123" }, "5.5.5.5"));
  }
  // L'IP "5.5.5.5" qui sopra ha già superato la soglia. Un IP diverso
  // deve comunque partire con un budget pieno.
  const resOtherIp = await handler(makeEvent({ action: "check", code: "ABC123" }, "6.6.6.6"));
  assert.equal(resOtherIp.statusCode, 200, "un IP diverso non deve essere penalizzato dal traffico di un altro IP");
});

test("il rate limit si applica PRIMA di leggere lo store \"promo\": un codice inesistente non aggira il limite", async () => {
  // Nessun seedPromoCode qui apposta — il codice non esiste in nessuno store.
  const handler = freshHandler();
  let lastRes;
  for (let i = 0; i < 21; i++) {
    lastRes = await handler(makeEvent({ action: "check", code: "NONESISTE" }, "7.7.7.7"));
  }
  assert.equal(lastRes.statusCode, 429, "anche un codice inesistente deve essere soggetto al rate limit, non solo uno valido");
});
