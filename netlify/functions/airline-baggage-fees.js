// Netlify serverless function — restituisce il dataset di riferimento
// sulle tariffe di sovrappeso/bagaglio extra delle compagnie aeree (vedi
// ../lib/airline-baggage-fees), letto a runtime dal client
// (dist/assets/app.js, ConcludeScreen) invece di essere duplicato lì —
// stesso pattern già in uso in questo repository per category-averages.js
// (dati che un processo esterno aggiorna nel tempo: un solo file da
// toccare per aggiornarli, non due da tenere sincronizzati). Vedi
// MANUALE.md, sezione "Confronto costo bagaglio extra compagnia aerea".
//
// GET, non POST: nessun payload da inviare, risposta identica per tutti i
// chiamanti nello stesso istante (nessun dato specifico dell'utente) —
// stesso principio già applicato in category-averages.js.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");
const { AIRLINE_BAGGAGE_FEES, mostRecentVerifiedAt } = require("../lib/airline-baggage-fees");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}

async function checkRateLimit(key) {
  const store = getStore({
    name: guestScopedStoreName("rate-limits"),
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
  const now = Date.now();
  const record = (await store.get(key, { type: "json" })) || { count: 0, windowStart: now };
  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }
  record.count += 1;
  await store.setJSON(key, record);
  return record.count <= RATE_LIMIT_MAX;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const withinLimit = await checkRateLimit(`airline-baggage-fees:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fees: AIRLINE_BAGGAGE_FEES,
        verifiedAt: mostRecentVerifiedAt(AIRLINE_BAGGAGE_FEES),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
