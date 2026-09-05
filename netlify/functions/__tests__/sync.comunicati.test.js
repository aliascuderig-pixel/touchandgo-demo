// Verifica le due azioni aggiunte a sync.js per il lato partner dei
// "Comunicati" (creati/gestiti solo dal CRM interno, touchandgo-internal —
// store Blobs condiviso "partner-comunicati", stesse credenziali di
// produzione già usate per gli altri store condivisi).
//
// Il punto critico verificato qui è l'ISOLAMENTO tra partner: un partner
// deve vedere i comunicati broadcast e quelli indirizzati esplicitamente
// al proprio codice, MAI quelli indirizzati a un partner diverso — con
// almeno due partner distinti nello stesso store, per dimostrarlo davvero
// e non solo per assenza di controesempi.
//
// Stesso fake minimale di @netlify/blobs già usato in save-review.test.js
// e negli altri test di questo repository (nessuna rete/credenziale reale).
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

const handlerPath = path.join(__dirname, "..", "sync.js");
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

function seedPartners(map) {
  stores["partners"] = new Map(Object.entries(map).map(([code, record]) => [code, JSON.stringify(record)]));
}

function seedComunicati(list) {
  stores["partner-comunicati"] = new Map(list.map((c) => [c.id, JSON.stringify(c)]));
}

beforeEach(() => {
  resetStores();
});

test("list-comunicati: partner vede i broadcast + quelli indirizzati a lui, MAI quelli di un altro partner (2 partner distinti)", async () => {
  seedPartners({ P1: { code: "P1" }, P2: { code: "P2" } });
  seedComunicati([
    { id: "c-broadcast", categoria: "Assistenza", testo: "A tutti", destinatario: null, createdAt: "2026-09-06T00:00:00.000Z", readBy: [] },
    { id: "c-p1-only", categoria: "Tariffe", testo: "Solo per P1", destinatario: "P1", createdAt: "2026-09-06T01:00:00.000Z", readBy: [] },
    { id: "c-p2-only", categoria: "Regole doganali", testo: "Solo per P2", destinatario: "P2", createdAt: "2026-09-06T02:00:00.000Z", readBy: [] },
  ]);

  const handler = freshHandler();

  const resP1 = await handler(makeEvent({ action: "list-comunicati", code: "P1" }, "1.1.1.1"));
  assert.equal(resP1.statusCode, 200);
  const idsP1 = JSON.parse(resP1.body).comunicati.map((c) => c.id).sort();
  assert.deepEqual(idsP1, ["c-broadcast", "c-p1-only"], "P1 deve vedere il broadcast e il proprio, MAI c-p2-only");

  const resP2 = await handler(makeEvent({ action: "list-comunicati", code: "P2" }, "2.2.2.2"));
  assert.equal(resP2.statusCode, 200);
  const idsP2 = JSON.parse(resP2.body).comunicati.map((c) => c.id).sort();
  assert.deepEqual(idsP2, ["c-broadcast", "c-p2-only"], "P2 deve vedere il broadcast e il proprio, MAI c-p1-only");

  // Verifica esplicita, non solo per assenza: il testo dell'altro partner
  // non compare da nessuna parte nella risposta, nemmeno come sottostringa.
  assert.ok(!resP1.body.includes("Solo per P2"), "la risposta a P1 non deve contenere in alcuna forma il testo del comunicato di P2");
  assert.ok(!resP2.body.includes("Solo per P1"), "la risposta a P2 non deve contenere in alcuna forma il testo del comunicato di P1");
});

test("list-comunicati: readBy non viene mai esposto al client (solo readByMe, booleano)", async () => {
  seedPartners({ P1: { code: "P1" }, P2: { code: "P2" } });
  seedComunicati([
    {
      id: "c-broadcast", categoria: "Altro", testo: "A tutti", destinatario: null, createdAt: "2026-09-06T00:00:00.000Z",
      readBy: [{ partnerCode: "P2", readAt: "2026-09-06T03:00:00.000Z" }],
    },
  ]);
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "list-comunicati", code: "P1" }, "3.3.3.3"));
  assert.equal(res.statusCode, 200);
  const { comunicati } = JSON.parse(res.body);
  assert.equal(comunicati[0].readByMe, false, "P1 non ha letto -> readByMe false");
  assert.equal(comunicati[0].readBy, undefined, "il campo readBy grezzo non deve mai raggiungere il client");
  assert.ok(!res.body.includes("P2"), "il codice dell'altro partner che ha letto non deve comparire nella risposta a P1");
});

test("list-comunicati: codice partner mancante -> 400", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "list-comunicati" }, "4.4.4.4"));
  assert.equal(res.statusCode, 400);
});

test("list-comunicati: codice partner inesistente -> 404 \"Partner non trovato\", nessun dato restituito", async () => {
  seedComunicati([{ id: "c-1", categoria: "Altro", testo: "x", destinatario: null, createdAt: new Date().toISOString(), readBy: [] }]);
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "list-comunicati", code: "NON-ESISTE" }, "5.5.5.5"));
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "Partner non trovato");
});

test("mark-comunicato-letto: aggiunge {partnerCode, readAt} a readBy e riflette readByMe:true", async () => {
  seedPartners({ P1: { code: "P1" } });
  seedComunicati([{ id: "c-1", categoria: "Assistenza", testo: "Ciao", destinatario: null, createdAt: new Date().toISOString(), readBy: [] }]);
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "mark-comunicato-letto", code: "P1", id: "c-1" }, "6.6.6.6"));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).readByMe, true);
  const stored = JSON.parse(stores["partner-comunicati"].get("c-1"));
  assert.equal(stored.readBy.length, 1);
  assert.equal(stored.readBy[0].partnerCode, "P1");
  assert.ok(stored.readBy[0].readAt);
});

test("mark-comunicato-letto: chiamato due volte dallo stesso partner NON duplica la lettura", async () => {
  seedPartners({ P1: { code: "P1" } });
  seedComunicati([{ id: "c-1", categoria: "Assistenza", testo: "Ciao", destinatario: null, createdAt: new Date().toISOString(), readBy: [] }]);
  const handler = freshHandler();
  await handler(makeEvent({ action: "mark-comunicato-letto", code: "P1", id: "c-1" }, "7.7.7.7"));
  await handler(makeEvent({ action: "mark-comunicato-letto", code: "P1", id: "c-1" }, "7.7.7.7"));
  const stored = JSON.parse(stores["partner-comunicati"].get("c-1"));
  assert.equal(stored.readBy.length, 1, "una seconda lettura dello stesso partner non deve aggiungere una seconda voce");
});

test("mark-comunicato-letto: due partner diversi che leggono lo stesso broadcast producono due voci distinte", async () => {
  seedPartners({ P1: { code: "P1" }, P2: { code: "P2" } });
  seedComunicati([{ id: "c-1", categoria: "Assistenza", testo: "A tutti", destinatario: null, createdAt: new Date().toISOString(), readBy: [] }]);
  const handler = freshHandler();
  await handler(makeEvent({ action: "mark-comunicato-letto", code: "P1", id: "c-1" }, "8.8.8.8"));
  await handler(makeEvent({ action: "mark-comunicato-letto", code: "P2", id: "c-1" }, "9.9.9.9"));
  const stored = JSON.parse(stores["partner-comunicati"].get("c-1"));
  assert.equal(stored.readBy.length, 2);
  assert.deepEqual(stored.readBy.map((r) => r.partnerCode).sort(), ["P1", "P2"]);
});

test("mark-comunicato-letto: un comunicato indirizzato a un ALTRO partner risponde 404, come se non esistesse, e non tocca readBy", async () => {
  seedPartners({ P1: { code: "P1" }, P2: { code: "P2" } });
  seedComunicati([{ id: "c-p2-only", categoria: "Tariffe", testo: "Solo per P2", destinatario: "P2", createdAt: new Date().toISOString(), readBy: [] }]);
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "mark-comunicato-letto", code: "P1", id: "c-p2-only" }, "10.10.10.10"));
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "Comunicato non trovato");
  const stored = JSON.parse(stores["partner-comunicati"].get("c-p2-only"));
  assert.equal(stored.readBy.length, 0, "il tentativo di P1 non deve aver scritto nulla su un comunicato che non è suo");
});

test("mark-comunicato-letto: id inesistente -> stesso messaggio 404 \"Comunicato non trovato\" (nessuna differenza rilevabile dall'altro caso)", async () => {
  seedPartners({ P1: { code: "P1" } });
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "mark-comunicato-letto", code: "P1", id: "id-che-non-esiste" }, "11.11.11.11"));
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "Comunicato non trovato");
});

test("mark-comunicato-letto: codice partner inesistente -> 404 \"Partner non trovato\"", async () => {
  seedComunicati([{ id: "c-1", categoria: "Altro", testo: "x", destinatario: null, createdAt: new Date().toISOString(), readBy: [] }]);
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "mark-comunicato-letto", code: "NON-ESISTE", id: "c-1" }, "12.12.12.12"));
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "Partner non trovato");
});
