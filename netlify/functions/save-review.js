// Netlify serverless function — salva la recensione dell'esperienza
// Touch&Go lasciata dal turista dopo la conferma di consegna
// (deliveryConfirmedAt, vedi confirmDelivery() in dist/assets/app.js e
// MANUALE.md, sezione "Conferma di consegna del turista"). Stesso pattern
// di save-purchase.js/save-shipment-group.js: store Netlify Blobs con
// supporto GUEST_MODE (guestScopedStoreName), rate limiting per IP,
// validazione stretta prima di scrivere.
//
// La recensione è SEMPRE privata: nessun endpoint pubblico la espone né
// la pubblica automaticamente da nessuna parte. Nasce con status
// "pending" — solo lo staff, dal CRM del repository privato
// touchandgo-internal, decide se e quando approvarla e pubblicarla a mano
// sui canali social di Touch&Go (nessuna integrazione social qui).
//
// Sanitizzazione: il testo NON viene alterato/escapato qui — solo
// validato (tipo, lunghezza). Encodarlo a riposo comprometterebbe il
// testo genuino (apostrofi, accenti...) e non è comunque il punto giusto
// per applicare la difesa: chi legge questi dati (il CRM, in
// touchandgo-internal) deve fare l'escaping al momento del rendering,
// stesso principio già usato lì per il fix XSS precedente — vedi la copia
// di MANUALE.md di quel repository.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti

// Cap "plausibile" per il testo libero — abbastanza per raccontare
// davvero un'esperienza, non abbastanza da diventare un vettore di abuso
// (payload enormi, spam). Stesso ordine di grandezza di un commento social
// tipico.
const REVIEW_TEXT_MAX_LENGTH = 600;

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

function generateReviewId() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RV-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

// Rifiuta qualunque dato palesemente inventato o fuori range prima che
// finisca nella coda di moderazione del CRM: rating intero 1-5 (mai 0, 6,
// decimali, stringhe), purchaseId presente, testo facoltativo ma
// comunque un tipo/lunghezza plausibile se presente.
function isValidReview(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.purchaseId !== "string" || !body.purchaseId.trim()) return false;
  if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) return false;
  if (body.text !== undefined && body.text !== null) {
    if (typeof body.text !== "string" || body.text.length > REVIEW_TEXT_MAX_LENGTH) return false;
  }
  if (body.shipmentGroupCode !== undefined && body.shipmentGroupCode !== null && typeof body.shipmentGroupCode !== "string")
    return false;
  if (body.partnerCode !== undefined && body.partnerCode !== null && typeof body.partnerCode !== "string") return false;
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const body = JSON.parse(event.body || "{}");
    if (!isValidReview(body)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Dati recensione non validi" }) };
    }

    const withinLimit = await checkRateLimit(`save-review:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const reviews = getStore({
      name: guestScopedStoreName("reviews"),
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });

    const id = generateReviewId();
    const review = {
      id,
      purchaseId: body.purchaseId.trim(),
      shipmentGroupCode:
        typeof body.shipmentGroupCode === "string" && body.shipmentGroupCode.trim() ? body.shipmentGroupCode.trim() : null,
      partnerCode: typeof body.partnerCode === "string" && body.partnerCode.trim() ? body.partnerCode.trim().toUpperCase() : null,
      rating: body.rating,
      text: typeof body.text === "string" ? body.text.trim().slice(0, REVIEW_TEXT_MAX_LENGTH) : "",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await reviews.setJSON(id, review);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, id }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
