// Verifica l'endpoint di ripristino manuale (reset.js): stessa tecnica di
// go.test.js in questa stessa cartella.
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
    };
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@netlify/blobs") return fakeBlobsModule;
  return originalLoad.call(this, request, ...args);
};

const resetPath = path.join(__dirname, "..", "reset.js");
const stateLibPath = path.join(__dirname, "..", "..", "lib", "router-state.js");

function freshHandler() {
  delete require.cache[require.resolve(resetPath)];
  delete require.cache[require.resolve(stateLibPath)];
  return require(resetPath).handler;
}

beforeEach(() => {
  resetStores();
  delete process.env.ROUTER_ADMIN_PASSWORD;
});

test("password corretta: azzera failoverActive", async () => {
  process.env.ROUTER_ADMIN_PASSWORD = "segreta123";
  stores["router-state"] = new Map([["state", JSON.stringify({ failoverActive: true, since: "x", reason: "y", lastCheckAt: "z", lastCheckOk: false })]]);

  const handler = freshHandler();
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ password: "segreta123" }) });

  assert.equal(res.statusCode, 200);
  const state = JSON.parse(stores["router-state"].get("state"));
  assert.equal(state.failoverActive, false);
  assert.equal(state.lastCheckAt, null, "deve azzerare anche il debounce, così il prossimo giro ricontrolla davvero");
});

test("password errata: rifiutata, nessuna scrittura", async () => {
  process.env.ROUTER_ADMIN_PASSWORD = "segreta123";
  const handler = freshHandler();
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ password: "sbagliata" }) });

  assert.equal(res.statusCode, 401);
  assert.equal(stores["router-state"], undefined);
});

test("nessuna password inviata: rifiutata (non deve passare come undefined === undefined)", async () => {
  process.env.ROUTER_ADMIN_PASSWORD = "segreta123";
  const handler = freshHandler();
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({}) });
  assert.equal(res.statusCode, 401);
});

test("ROUTER_ADMIN_PASSWORD non configurata: fallisce chiuso (503), mai aperto", async () => {
  const handler = freshHandler();
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ password: "qualunque" }) });
  assert.equal(res.statusCode, 503);
});

test("metodo diverso da POST: rifiutato", async () => {
  process.env.ROUTER_ADMIN_PASSWORD = "segreta123";
  const handler = freshHandler();
  const res = await handler({ httpMethod: "GET" });
  assert.equal(res.statusCode, 405);
});
