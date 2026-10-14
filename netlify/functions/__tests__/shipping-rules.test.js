// Base di conoscenza sulle regole di spedizione per Paese: contenuto, ricerca
// per destinazione e uso nei prompt dell'assistente e del classificatore.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const rules = require("../../lib/shipping-rules");

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@netlify/blobs") return { getStore: () => ({ list: async () => ({ blobs: [] }), get: async () => null, setJSON: async () => {} }) };
  return originalLoad.call(this, request, ...args);
};

test("ogni voce ha id, Paesi, riassunto e fonti https (tranne i Paesi non verificati)", () => {
  for (const r of rules.RULES) {
    assert.ok(r.id && r.countries.length && r.summary.length > 20, r.id);
    for (const u of r.sources) assert.match(u, /^https:\/\//, r.id);
    if (r.id !== "non-verificati") assert.ok(r.sources.length > 0, `${r.id} senza fonte`);
  }
  assert.match(rules.VERIFIED_AT, /^\d{4}-\d{2}-\d{2}$/);
});

test("rulesForDestination: trova per nome, anche in inglese e con maiuscole diverse", () => {
  assert.equal(rules.rulesForDestination("Stati Uniti")[0].id, "usa-prior-notice");
  assert.equal(rules.rulesForDestination("united states")[0].id, "usa-prior-notice");
  assert.equal(rules.rulesForDestination("Canada")[0].id, "canada-alimenti");
  assert.deepEqual(rules.rulesForDestination("Narnia"), []);
  assert.deepEqual(rules.rulesForDestination(""), []);
});

test("buildRulesContext: con destinazione nota solo le sue regole, altrimenti tutte", () => {
  const usa = rules.buildRulesContext("USA");
  assert.match(usa, /Prior Notice/);
  assert.doesNotMatch(usa, /Decreto 280/);
  const all = rules.buildRulesContext();
  assert.match(all, /Prior Notice/);
  assert.match(all, /Decreto 280/);
  assert.match(all, /non inventarne altre/);
  assert.match(all, /Reg\. UE 2019\/2122/);
});

test("le regole USA contengono i fatti chiave verificati (tempi, tracking, un avviso per prodotto)", () => {
  const t = rules.rulesForDestination("USA")[0].summary;
  for (const k of ["4 ore", "2 per strada", "8 per mare", "1/10/2026", "ogni prodotto diverso"]) assert.ok(t.includes(k), k);
});

test("l'assistente (modalità domanda) include le regole per Paese nel prompt", () => {
  const a = require(path.join(__dirname, "..", "assistant.js"));
  assert.match(a.QUESTION_MODE_FACTS, /REGOLE DI SPEDIZIONE PER PAESE/);
  assert.match(a.QUESTION_MODE_FACTS, /Prior Notice/);
});

test("il classificatore manda le regole nel system prompt", async () => {
  process.env.ANTHROPIC_API_KEY = "k";
  let sent;
  const orig = global.fetch;
  global.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return { status: 200, json: async () => ({ content: [{ text: "{}" }] }) }; };
  try {
    delete require.cache[require.resolve("../classify.js")];
    const h = require("../classify.js").handler;
    await h({ httpMethod: "POST", headers: {}, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
    assert.match(sent.system, /REGOLE DI SPEDIZIONE PER PAESE/);
  } finally {
    global.fetch = orig;
  }
});
