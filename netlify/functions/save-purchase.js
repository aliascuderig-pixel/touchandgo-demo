// Netlify serverless function — centrally records every purchase/QR event
// into Netlify Blobs, so the CRM page can see data from every tourist's
// device, not just what's stored locally on each phone.

const { getStore } = require("@netlify/blobs");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti

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

const VALID_PRICING_TIERS = ["pieno", "abbonato", "breakeven"];

// Rifiuta record palesemente inventati prima che finiscano nelle statistiche
// del CRM: id presente, prezzo e peso in un range plausibile, tier di
// prezzo tra i tre effettivamente usati dall'app.
function isValidPurchase(item) {
  if (!item || typeof item !== "object") return false;
  if (typeof item.id !== "string" || !item.id.trim()) return false;
  if (typeof item.price !== "number" || !isFinite(item.price) || item.price < 0 || item.price > 500) return false;
  const weight = typeof item.weightKg === "number" ? item.weightKg : item.weight_kg;
  if (typeof weight !== "number" || !isFinite(weight) || weight <= 0 || weight >= 50) return false;
  if (!VALID_PRICING_TIERS.includes(item.pricingTier)) return false;
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const item = JSON.parse(event.body || "{}");
    if (!isValidPurchase(item)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Dati spedizione non validi" }) };
    }

    const withinLimit = await checkRateLimit(`save-purchase:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const store = getStore({
      name: "purchases",
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    await store.setJSON(item.id, item);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
