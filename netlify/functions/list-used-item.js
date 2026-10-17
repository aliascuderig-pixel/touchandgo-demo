// Netlify serverless function — «Mettilo in vendita» dall'app turista
// (17 ottobre 2026). Vedi MANUALE.md, sezione «Mettilo in vendita (Usato)».
//
// Con UN clic l'acquisto già consegnato diventa un annuncio nell'Usato
// dell'E-shop (sito separato touchandgo-eshop): scrive negli store condivisi
// "eshop-used" e "eshop-used-index" tramite netlify/lib/used-listing.js (copia
// IDENTICA di quella dell'E-shop e del gestionale). Nessuna chiamata tra siti.
//
// L'app turista non ha un vero login: la proprietà dell'acquisto si verifica
// con un passaggio in più — il turista deve indicare l'email usata
// all'acquisto, che deve coincidere con quella del record (insieme all'id
// dell'acquisto, che solo lui ha). Stesso esito d'errore per "non esiste" e
// "email diversa". Max 10 richieste/ora per IP.
//
// SOLA SCRITTURA sull'annuncio: questa function non modifica MAI "purchases".
const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");
const U = require("../lib/used-listing");

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const PURCHASE_ID_RE = /^TG-[A-Z0-9]{4,12}$/;

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}
function json(code, data) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

async function checkRateLimit(key, blobsAuth) {
  const store = getStore({ name: guestScopedStoreName("rate-limits"), ...blobsAuth });
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
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "JSON non valido" });
  }
  try {
    const blobsAuth = { siteID: process.env.NETLIFY_BLOBS_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN };
    if (!(await checkRateLimit(`list-used-item:${getClientIp(event)}`, blobsAuth))) {
      return json(429, { error: "Troppe richieste, riprova tra qualche minuto." });
    }
    const purchaseId = typeof body.purchaseId === "string" ? body.purchaseId.trim().toUpperCase() : "";
    const email = U.normalizeEmail(body.email);
    if (!PURCHASE_ID_RE.test(purchaseId)) return json(400, { error: "Acquisto non valido." });
    if (!email || !email.includes("@") || email.length > 200) return json(400, { error: "Indica l'email usata all'acquisto." });

    const g = (n) => getStore({ name: guestScopedStoreName(n), ...blobsAuth });
    const purchase = await g("purchases").get(purchaseId, { type: "json" });
    const notYours = { error: "Non riusciamo a verificare questo acquisto con l'email indicata." };
    if (!purchase) return json(404, notYours);
    const owner = U.normalizeEmail(purchase.touristEmail);
    if (!owner) {
      return json(409, { error: "Questo acquisto non ha un'email associata: per metterlo in vendita contatta l'assistenza Touch&Go." });
    }
    if (owner !== email) return json(404, notYours);

    const config = g(U.CONFIG_STORE);
    const result = await U.listPurchase({ listings: g(U.USED_STORE), index: g(U.INDEX_STORE), config }, purchase, {});
    if (result.error) return json(409, { error: result.error });
    const cfg = await U.getCommissionConfig(config);
    const l = result.listing;
    return json(200, {
      listed: l.status === "in vendita",
      created: result.created,
      status: l.status, // "bozza" = manca il prezzo: si indica dall'E-shop
      price: l.price,
      commissionRate: cfg.rate,
      promoActive: cfg.promoActive,
      effectiveRate: cfg.effectiveRate,
    });
  } catch (err) {
    return json(500, { error: "Errore interno, riprova." });
  }
};
