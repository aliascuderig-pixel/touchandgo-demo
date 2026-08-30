// Netlify serverless function — registra centralmente in Netlify Blobs UN
// record per ogni gruppo di spedizione consolidato (ConcludeScreen), così
// il CRM può vedere l'ordine di ritiro come un'unica entità (destinazione,
// oggetti inclusi, peso/volume combinato, prezzo finale) invece di doverlo
// ricostruire ogni volta dai singoli acquisti — vedi MANUALE.md, sezione
// "Prezzo consolidato per gruppo di spedizione".
//
// Stesso pattern di save-purchase.js: store Netlify Blobs con supporto
// GUEST_MODE (guestScopedStoreName), rate limiting per IP. Nessuna logica
// di commissione/blocklist qui: quella resta interamente su save-purchase.js,
// che continua a essere chiamato per ogni singolo oggetto del gruppo (con in
// più, da questa modifica, il riferimento shipmentGroupCode).

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

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

// Rifiuta record palesemente inventati prima che finiscano nel CRM: codice
// prenotazione presente, almeno un oggetto nel gruppo, prezzo/peso in un
// range plausibile (stesso ordine di grandezza dei limiti già usati in
// save-purchase.js per il singolo oggetto, qui semplicemente più ampi
// perché il gruppo può contenere più oggetti).
function isValidShipmentGroup(group) {
  if (!group || typeof group !== "object") return false;
  if (typeof group.code !== "string" || !group.code.trim()) return false;
  if (!Array.isArray(group.itemIds) || group.itemIds.length === 0) return false;
  if (!group.itemIds.every((id) => typeof id === "string" && id.trim())) return false;
  if (typeof group.total !== "number" || !isFinite(group.total) || group.total < 0 || group.total > 5000) return false;
  if (typeof group.weightKg !== "number" || !isFinite(group.weightKg) || group.weightKg <= 0 || group.weightKg >= 500) return false;
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const group = JSON.parse(event.body || "{}");
    if (!isValidShipmentGroup(group)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Dati gruppo di spedizione non validi" }) };
    }

    const withinLimit = await checkRateLimit(`save-shipment-group:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const shipmentGroups = getStore({
      name: guestScopedStoreName("shipment-groups"),
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    // Il bookingCode (generateBookingCode() lato client) è la chiave: è già
    // quello mostrato al turista e stampato nel QR/riepilogo, quindi è
    // anche l'id più naturale per il CRM da usare per risalire al gruppo.
    await shipmentGroups.setJSON(group.code, group);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
