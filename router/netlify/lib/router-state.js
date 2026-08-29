// Helper condiviso da go.js e reset.js — unico punto che sa come leggere e
// scrivere lo stato persistente del router (store Netlify Blobs dedicato
// "router-state", un solo record). Non dentro netlify/functions/ apposta,
// stesso motivo di netlify/lib/guest-mode.js nel sito principale: evitare
// che il discovery automatico delle function di Netlify lo scambi per un
// endpoint.
//
// Credenziali dedicate al SITO ROUTER (NETLIFY_BLOBS_SITE_ID/TOKEN
// impostate sul deploy del router, distinte da quelle del sito
// principale/ospite) — vedi MANUALE.md, "Router di continuità".
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "router-state";
const STATE_KEY = "state";

const DEFAULT_STATE = {
  failoverActive: false,
  since: null,
  reason: null,
  lastCheckAt: null,
  lastCheckOk: null,
};

function store() {
  return getStore({
    name: STORE_NAME,
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

// Nessun record ancora scritto (primo avvio) -> stato di default, non un
// errore: equivale a "nessun failover mai scattato, nessun controllo
// ancora fatto".
async function readState() {
  const record = await store().get(STATE_KEY, { type: "json" });
  return record || DEFAULT_STATE;
}

async function writeState(record) {
  await store().setJSON(STATE_KEY, record);
}

module.exports = { readState, writeState, DEFAULT_STATE, STORE_NAME, STATE_KEY };
