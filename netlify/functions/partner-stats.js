// Netlify serverless function — verifica un codice partner e restituisce
// vendite e commissioni REALI, aggregate lato server dallo store
// "purchases" (popolato da save-purchase.js su tutti i dispositivi) —
// non lo storico locale del singolo telefono.
//
// Il codice stesso funge da credenziale, come i codici invito in promo.js:
// nessuna password separata. Un codice inesistente o qualunque altro
// errore rispondono entrambi con { valid: false }, per non rivelare quali
// codici partner esistono.

const { getStore } = require("@netlify/blobs");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti
const COMMISSION_RATE = 0.1;

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}

async function checkRateLimit(key) {
  const store = getStore({
    name: "rate-limits",
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
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const withinLimit = await checkRateLimit(`partner-stats:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const { code } = JSON.parse(event.body || "{}");
    const normalized = (code || "").trim().toUpperCase();
    if (!normalized) {
      return { statusCode: 200, body: JSON.stringify({ valid: false }) };
    }

    const partners = getStore({
      name: "partners",
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const record = await partners.get(normalized, { type: "json" });
    if (!record) {
      return { statusCode: 200, body: JSON.stringify({ valid: false }) };
    }

    const purchases = getStore({
      name: "purchases",
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const { blobs } = await purchases.list();
    const items = (await Promise.all(blobs.map((b) => purchases.get(b.key, { type: "json" })))).filter(Boolean);
    const myItems = items.filter((it) => it.partnerCode === normalized);
    const salesCount = myItems.length;
    const rawSalesValue = myItems.reduce((sum, it) => sum + (it.price || 0), 0);
    const totalSalesValue = Math.round(rawSalesValue * 100) / 100;
    const totalCommission = Math.round(rawSalesValue * COMMISSION_RATE * 100) / 100;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        valid: true,
        partnerName: record.name || "",
        salesCount,
        totalSalesValue,
        totalCommission,
        creditBalance: Math.round((record.creditBalance || 0) * 100) / 100,
      }),
    };
  } catch (err) {
    // Stesso formato di un codice inesistente: non distinguere un errore
    // interno da un codice sbagliato lato client.
    return { statusCode: 200, body: JSON.stringify({ valid: false }) };
  }
};
