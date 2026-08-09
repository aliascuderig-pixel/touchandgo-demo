// Netlify serverless function — valida e consuma i codici sconto partner
// generati dall'area riservata partner (crm.js, action
// "generate-partner-discount-code"). Un codice applica il 10% di sconto
// sulla fee di servizio Touch&Go (non sul corriere) e scala esattamente
// quell'importo dal creditBalance del partner — mai "a debito": se il
// partner non ha credito sufficiente in quel momento, il codice resta
// inutilizzato e la richiesta fallisce con un errore chiaro.
//
// Stesso stile di promo.js: endpoint pubblico, nessuna password. Un
// codice inesistente o già usato risponde con lo stesso formato generico
// (per non rivelare quali codici esistono); il caso "credito partner
// insufficiente" invece risponde con un messaggio distinto, perché chi fa
// la richiesta possiede già legittimamente quel codice (ricevuto dal
// partner) — non è un'enumerazione.

const { getStore } = require("@netlify/blobs");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti
const COMMISSION_RATE = 0.1;

// Fee di servizio realmente applicabili lato app (dist/assets/app.js,
// FULL_FEE / SUBSCRIBED_FEE) — un client non può inventare una fee
// arbitraria per gonfiare lo sconto e prosciugare il credito del partner.
const VALID_FEES = [39, 19];

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

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const withinLimit = await checkRateLimit(`partner-discount:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const body = JSON.parse(event.body || "{}");
    const { action, code, fee, touristEmail } = body;
    const normalized = (code || "").trim().toUpperCase();

    if (!normalized) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, error: "Codice mancante" }) };
    }
    if (action !== "redeem") {
      return { statusCode: 400, body: JSON.stringify({ error: "Azione non riconosciuta" }) };
    }
    if (!VALID_FEES.includes(fee)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Fee non valida" }) };
    }

    const blobsAuth = {
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    };
    const discountCodes = getStore({ name: "partner-discount-codes", ...blobsAuth });
    const record = await discountCodes.get(normalized, { type: "json" });

    // Codice inesistente o già usato: stessa risposta generica, per non
    // rivelare quali codici esistono.
    if (!record || record.usedAt) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, error: "Codice non valido o già utilizzato." }) };
    }

    const partners = getStore({ name: "partners", ...blobsAuth });
    const partner = await partners.get(record.partnerCode, { type: "json" });
    if (!partner) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, error: "Codice non valido o già utilizzato." }) };
    }

    const discountAmount = Math.round(fee * COMMISSION_RATE * 100) / 100;
    const available = Math.round((partner.creditBalance || 0) * 100) / 100;
    if (available < discountAmount) {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: false, error: "Il partner non ha credito sufficiente per applicare questo codice in questo momento." }),
      };
    }

    record.usedAt = new Date().toISOString();
    record.usedByEmail = normalizeEmail(touristEmail) || null;
    await discountCodes.setJSON(normalized, record);

    partner.creditBalance = Math.round((available - discountAmount) * 100) / 100;
    partner.updatedAt = new Date().toISOString();
    await partners.setJSON(record.partnerCode, partner);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ valid: true, discountAmount, partnerCode: record.partnerCode }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "Errore interno" }) };
  }
};
