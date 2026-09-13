// Verifica category-averages.js: media reale per categoria quando il
// campione è sufficiente, fallback dichiarato (CATEGORY_DEFAULTS) quando
// non lo è, e che tutte e 10 le categorie siano sempre presenti nella
// risposta. Stesso fake minimale di @netlify/blobs già usato altrove in
// questa cartella. Esecuzione: node --test

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

const handlerPath = path.join(__dirname, "..", "category-averages.js");
function freshHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath).handler;
}

function makeEvent() {
  return { httpMethod: "GET", headers: { "x-nf-client-connection-ip": "127.0.0.1" } };
}

let idCounter = 0;
async function seedPurchase(overrides) {
  idCounter += 1;
  const purchases = fakeBlobsModule.getStore("purchases");
  const item = Object.assign(
    {
      id: "seed-" + idCounter,
      status: "in sospeso",
    },
    overrides
  );
  await purchases.setJSON(item.id, item);
  return item;
}

beforeEach(() => {
  resetStores();
  idCounter = 0;
});

test("metodo diverso da GET: rifiutato", async () => {
  const handler = freshHandler();
  const res = await handler({ httpMethod: "POST" });
  assert.equal(res.statusCode, 405);
});

test("nessun acquisto in store: tutte e 10 le categorie presenti, tutte con il default dichiarato", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const names = Object.keys(body.categories);
  assert.equal(names.length, 10, "devono esserci sempre tutte e 10 le categorie");
  assert.ok(names.includes("Attrezzatura sportiva"));
  for (const name of names) {
    const entry = body.categories[name];
    assert.equal(entry.sampleSize, 0);
    assert.equal(entry.usedFallback, true);
    assert.ok(entry.weightKg > 0, `${name}: il default deve avere un peso positivo`);
    assert.ok(entry.dims.length_cm > 0 && entry.dims.width_cm > 0 && entry.dims.height_cm > 0);
  }
});

test("campione sufficiente (>=5) in una categoria: usa la media reale, non il default", async () => {
  const handler = freshHandler();
  for (let i = 0; i < 5; i++) {
    await seedPurchase({
      category: "Ceramica",
      weightKg: 2,
      dims: { length_cm: 30, width_cm: 30, height_cm: 30 },
    });
  }
  const res = await handler(makeEvent());
  const body = JSON.parse(res.body);
  const ceramica = body.categories["Ceramica"];
  assert.equal(ceramica.sampleSize, 5);
  assert.equal(ceramica.usedFallback, false);
  assert.equal(ceramica.weightKg, 2);
  assert.equal(ceramica.dims.length_cm, 30);
});

test("campione insufficiente (<5) in una categoria: usa il default dichiarato, mai una media su un campione troppo piccolo", async () => {
  const handler = freshHandler();
  for (let i = 0; i < 4; i++) {
    await seedPurchase({ category: "Gioielleria", weightKg: 50, dims: { length_cm: 90, width_cm: 90, height_cm: 90 } });
  }
  const res = await handler(makeEvent());
  const body = JSON.parse(res.body);
  const gioielleria = body.categories["Gioielleria"];
  assert.equal(gioielleria.sampleSize, 4);
  assert.equal(gioielleria.usedFallback, true);
  assert.notEqual(gioielleria.weightKg, 50, "con un campione sotto soglia non deve mai riflettere la media reale");
  assert.equal(gioielleria.weightKg, 0.2, "deve usare esattamente il default dichiarato per Gioielleria");
});

test("categorie diverse restano indipendenti: un campione grande in una categoria non influenza le altre", async () => {
  const handler = freshHandler();
  for (let i = 0; i < 10; i++) {
    await seedPurchase({ category: "Attrezzatura sportiva", weightKg: 8, dims: { length_cm: 80, width_cm: 40, height_cm: 30 } });
  }
  const res = await handler(makeEvent());
  const body = JSON.parse(res.body);
  assert.equal(body.categories["Attrezzatura sportiva"].weightKg, 8);
  assert.equal(body.categories["Attrezzatura sportiva"].usedFallback, false);
  assert.equal(body.categories["Ceramica"].usedFallback, true, "nessun acquisto in Ceramica: resta sul default");
});

test("acquisti senza category valorizzata non contano per nessuna categoria (nessun crash)", async () => {
  const handler = freshHandler();
  for (let i = 0; i < 6; i++) {
    await seedPurchase({ category: null, weightKg: 100 });
  }
  const res = await handler(makeEvent());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  for (const name of Object.keys(body.categories)) {
    assert.equal(body.categories[name].sampleSize, 0);
  }
});

test("peso e una singola dimensione mancante non si influenzano a vicenda: ciascun campo usa il proprio default indipendentemente", async () => {
  const handler = freshHandler();
  for (let i = 0; i < 5; i++) {
    await seedPurchase({ category: "Artigianato", weightKg: 3, dims: null });
  }
  const res = await handler(makeEvent());
  const body = JSON.parse(res.body);
  const artigianato = body.categories["Artigianato"];
  assert.equal(artigianato.weightKg, 3, "il peso ha campione sufficiente: deve usare la media reale");
  assert.equal(artigianato.dims.length_cm, 25, "dims assente su tutto il campione: deve usare il default");
});

test("computedAt è un timestamp ISO valido", async () => {
  const handler = freshHandler();
  const res = await handler(makeEvent());
  const body = JSON.parse(res.body);
  assert.ok(!isNaN(new Date(body.computedAt).getTime()));
});

test("rate limit: oltre la soglia, 429", async () => {
  const handler = freshHandler();
  for (let i = 0; i < 20; i++) {
    const res = await handler(makeEvent());
    assert.equal(res.statusCode, 200);
  }
  const res = await handler(makeEvent());
  assert.equal(res.statusCode, 429);
});
