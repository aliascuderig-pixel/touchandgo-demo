// Verifica netlify/functions/status.js: endpoint di sola lettura per il
// controllo giornaliero automatico (touchandgo-demo,
// netlify/functions/daily-healthcheck.js). Deve SOLO leggere lo stato già
// persistito (mai chiamare checkMainHealth()/writeState()) — qui lo si
// verifica assicurandosi che, qualunque sia lo stato in store, non venga
// mai scritto nulla e non venga mai chiamato fetch.
//
// Stessa tecnica di go.test.js: store Blobs finto in memoria.

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
    };
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@netlify/blobs") return fakeBlobsModule;
  return originalLoad.call(this, request, ...args);
};

const statusPath = path.join(__dirname, "..", "status.js");
const stateLibPath = path.join(__dirname, "..", "..", "lib", "router-state.js");

function freshHandler() {
  delete require.cache[require.resolve(statusPath)];
  delete require.cache[require.resolve(stateLibPath)];
  return require(statusPath).handler;
}

const originalFetch = global.fetch;

beforeEach(() => {
  resetStores();
  delete process.env.ACTIVE_TARGET;
  global.fetch = () => {
    throw new Error("status.js non deve MAI chiamare fetch (nessun health-check reale)");
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

test("nessuno stato ancora scritto: default (nessun failover), redirectsTo main", async () => {
  const handler = freshHandler();
  const res = await handler();
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "auto");
  assert.equal(body.redirectsTo, "https://benevolent-longma-57c78a.netlify.app/");
  assert.equal(body.state.failoverActive, false);
  assert.equal(stores["router-state"].size, 0, "non deve aver scritto nulla nello store");
});

test("failover già attivo in store: redirectsTo guest, nessuna scrittura", async () => {
  stores["router-state"] = new Map([
    ["state", JSON.stringify({ failoverActive: true, since: "2026-01-01T00:00:00.000Z", reason: "x", lastCheckAt: null, lastCheckOk: false })],
  ]);
  const handler = freshHandler();
  const res = await handler();
  const body = JSON.parse(res.body);
  assert.equal(body.redirectsTo, "https://touchandgo-guest.netlify.app/");
  assert.equal(body.state.failoverActive, true);
  // Ancora una sola chiave, invariata: nessuna scrittura aggiuntiva.
  assert.equal(stores["router-state"].size, 1);
});

test("ACTIVE_TARGET impostata: bypassa lo stato, come go.js", async () => {
  process.env.ACTIVE_TARGET = "guest";
  const handler = freshHandler();
  const res = await handler();
  const body = JSON.parse(res.body);
  assert.equal(body.mode, "override");
  assert.equal(body.redirectsTo, "https://touchandgo-guest.netlify.app/");
  assert.equal(body.state, null);
  delete process.env.ACTIVE_TARGET;
});

test("store irraggiungibile: 200 con ok:false descrittivo, non un'eccezione", async () => {
  const originalGetStore = fakeBlobsModule.getStore;
  fakeBlobsModule.getStore = () => ({
    async get() {
      throw new Error("store down");
    },
  });
  const handler = freshHandler();
  const res = await handler();
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  fakeBlobsModule.getStore = originalGetStore;
});
