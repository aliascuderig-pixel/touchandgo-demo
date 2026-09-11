// Netlify serverless function — verifica DAVVERO, lato server, che una
// Stripe Checkout Session sia stata pagata (payment_status === "paid")
// prima che il client possa marcare qualunque oggetto come "ritirato" e
// sincronizzarlo col CRM — vedi verifyCheckoutSession()/
// finalizeShippedGroups() in app.js e MANUALE.md, sezione "Pagamento
// reale con Stripe Checkout".
//
// Il solo ritorno del browser sulla success_url NON è mai sufficiente: un
// session_id nell'URL può essere manomesso, riusato o semplicemente
// vecchio — va sempre riverificato qui interrogando Stripe direttamente
// (GET /v1/checkout/sessions/{id}), mai fidandosi del client.
//
// Fail-closed ovunque: qualunque errore (session_id mancante, chiave
// Stripe non configurata, sessione inesistente, eccezione di rete) risolve
// sempre con paid:false, MAI paid:true — l'unico modo di ottenere
// paid:true è una risposta 2xx di Stripe con payment_status === "paid".

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

const RATE_LIMIT_MAX = 30;
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
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const { sessionId } = JSON.parse(event.body || "{}");
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paid: false, error: "session_id mancante" }) };
    }

    const withinLimit = await checkRateLimit(`verify-checkout-session:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paid: false, error: "Chiave Stripe non configurata sul server (STRIPE_SECRET_KEY mancante)." }),
      };
    }

    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId.trim())}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const data = await res.json();

    if (!res.ok) {
      // Sessione inesistente/malformata/errore Stripe: MAI paid:true su un
      // errore — fail-closed, coerente con l'header sopra.
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paid: false, error: (data.error && data.error.message) || "Sessione di pagamento non trovata" }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paid: data.payment_status === "paid",
        sessionId: data.id,
        amountTotal: data.amount_total,
        currency: data.currency,
      }),
    };
  } catch (err) {
    // Qualunque eccezione imprevista -> mai paid:true.
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paid: false, error: err.message }) };
  }
};
