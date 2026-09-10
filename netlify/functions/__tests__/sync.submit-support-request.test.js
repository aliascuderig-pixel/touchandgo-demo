// Verifica la nuova azione "submit-support-request" aggiunta a sync.js —
// primo pezzo separato del sistema di ticket assistenza predittivo (vedi
// MANUALE.md, sezione "Contatta assistenza"). Scrive sullo store condiviso
// "support-requests" GIÀ letto dal CRM interno (touchandgo-internal,
// crm.js, azioni "list-support-requests"/"update-support-request-status") —
// il punto critico verificato qui è che i nomi di campo scritti
// corrispondano ESATTAMENTE a quelli già attesi da quel lato (verificato
// leggendo il codice reale del CRM prima di scrivere questa function), e
// che il nuovo campo "trail" sia scritto senza ALCUNA trasformazione.
//
// Stesso fake minimale di @netlify/blobs già usato in
// sync.generated-shipments.test.js/sync.comunicati.test.js (nessuna
// rete/credenziale reale).
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

const SAMPLE_TRAIL = [
  { type: "screen", label: "Home", at: "2026-09-10T08:00:00.000Z" },
  { type: "action", label: "Foto caricata/scattata", at: "2026-09-10T08:00:05.000Z" },
  { type: "screen", label: "Destinazione", at: "2026-09-10T08:00:06.000Z" },
  { type: "action", label: "Errore: Connessione assente, riprova.", at: "2026-09-10T08:00:07.000Z" },
];

beforeEach(() => {
  resetStores();
});

test("submit-support-request: un invio valido scrive nello store un record con TUTTI i campi attesi dal CRM, nomi esatti", async () => {
  const handler = freshHandler();
  const res = await handler(
    makeEvent(
      {
        action: "submit-support-request",
        message: "Il QR non si genera dopo aver scelto l'indirizzo.",
        contactEmail: "turista@example.com",
        context: "Scegli indirizzo",
        trail: SAMPLE_TRAIL,
      },
      "10.0.0.1"
    )
  );
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.ok(data.request, "la risposta deve includere il record creato");
  assert.ok(data.request.id, "deve avere un id");

  const store = stores["support-requests"];
  assert.ok(store, "lo store 'support-requests' deve essere stato scritto");
  const saved = JSON.parse(store.get(data.request.id));

  // Nomi esatti già attesi dal CRM (verificati leggendo netlify/functions/
  // crm.js e dist/site/admin.js in touchandgo-internal, azioni
  // list-support-requests/update-support-request-status):
  assert.equal(typeof saved.id, "string");
  assert.equal(typeof saved.createdAt, "string");
  assert.ok(!Number.isNaN(Date.parse(saved.createdAt)), "createdAt deve essere un ISO valido");
  assert.equal(saved.message, "Il QR non si genera dopo aver scelto l'indirizzo.");
  assert.equal(saved.contactEmail, "turista@example.com");
  assert.equal(saved.context, "Scegli indirizzo");

  // status: volutamente ASSENTE alla creazione (coerente con "nuova" nel
  // CRM, che tratta qualunque status !== "gestita" — incluso assente —
  // come "Nuova").
  assert.ok(!("status" in saved), "status deve restare assente alla creazione, non un valore esplicito tipo 'nuova'");
});

test("submit-support-request: il campo 'trail' è scritto ESATTAMENTE come ricevuto, nessuna trasformazione", async () => {
  const handler = freshHandler();
  const res = await handler(
    makeEvent(
      {
        action: "submit-support-request",
        message: "Test trail",
        trail: SAMPLE_TRAIL,
      },
      "10.0.0.2"
    )
  );
  const data = JSON.parse(res.body);
  const saved = JSON.parse(stores["support-requests"].get(data.request.id));
  assert.deepEqual(saved.trail, SAMPLE_TRAIL, "il trail salvato deve essere identico, voce per voce, campo per campo, a quello inviato");
});

test("submit-support-request: contactEmail e context sono opzionali -> null se assenti, mai un motivo di rifiuto", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent({ action: "submit-support-request", message: "Solo il messaggio, nient'altro." }, "10.0.0.3"));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  const saved = JSON.parse(stores["support-requests"].get(data.request.id));
  assert.equal(saved.contactEmail, null);
  assert.equal(saved.context, null);
  assert.deepEqual(saved.trail, [], "trail assente dal payload -> array vuoto, mai un errore");
});

test("submit-support-request: trail non-array (client difettoso) -> sostituito con [] (garanzia di tipo, non un rifiuto)", async () => {
  const handler = freshHandler();
  const res = await handler(
    makeEvent({ action: "submit-support-request", message: "Messaggio valido", trail: "non è un array" }, "10.0.0.4")
  );
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  const saved = JSON.parse(stores["support-requests"].get(data.request.id));
  assert.deepEqual(saved.trail, []);
});

test("submit-support-request: un messaggio vuoto (anche solo spazi) viene rifiutato con 400", async () => {
  const handler = freshHandler();
  const resEmpty = await handler(makeEvent({ action: "submit-support-request", message: "" }, "10.0.0.5"));
  assert.equal(resEmpty.statusCode, 400);
  const resSpaces = await handler(makeEvent({ action: "submit-support-request", message: "    " }, "10.0.0.6"));
  assert.equal(resSpaces.statusCode, 400);
  const resMissing = await handler(makeEvent({ action: "submit-support-request" }, "10.0.0.7"));
  assert.equal(resMissing.statusCode, 400);
  assert.equal(stores["support-requests"] ? stores["support-requests"].size : 0, 0, "nessuna scrittura deve avvenire per un messaggio vuoto/mancante");
});

test("submit-support-request: rate limit (20 richieste/60min per IP), stesso schema delle altre azioni pubbliche", async () => {
  const handler = freshHandler();
  let lastStatus = 200;
  for (let i = 0; i < 21; i++) {
    const res = await handler(makeEvent({ action: "submit-support-request", message: `Messaggio numero ${i}` }, "9.9.9.10"));
    lastStatus = res.statusCode;
  }
  assert.equal(lastStatus, 429, "la 21esima richiesta dallo stesso IP nella stessa finestra deve essere rifiutata");
});

test("submit-support-request: due richieste distinte ottengono id distinti", async () => {
  const handler = freshHandler();
  const res1 = await handler(makeEvent({ action: "submit-support-request", message: "Prima richiesta" }, "10.0.0.8"));
  const res2 = await handler(makeEvent({ action: "submit-support-request", message: "Seconda richiesta" }, "10.0.0.8"));
  const id1 = JSON.parse(res1.body).request.id;
  const id2 = JSON.parse(res2.body).request.id;
  assert.notEqual(id1, id2);
});
