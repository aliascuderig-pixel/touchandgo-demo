// Netlify serverless function — centrally records every purchase/QR event
// into Netlify Blobs, so the CRM page can see data from every tourist's
// device, not just what's stored locally on each phone.

const { getStore } = require("@netlify/blobs");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti
const COMMISSION_RATE = 0.1; // stessa aliquota usata come commissione/credito partner (crm.js, partner-stats.js)

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
const BLOCKED_MESSAGE = "Non è possibile completare la richiesta. Contatta l'assistenza.";

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

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
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

    const blobsAuth = {
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    };
    const purchases = getStore({ name: "purchases", ...blobsAuth });
    const blocklist = getStore({ name: "blocklist", ...blobsAuth });

    const email = normalizeEmail(item.touristEmail);

    if (email) {
      const existingBlock = await blocklist.get(email, { type: "json" });
      if (existingBlock) {
        return { statusCode: 403, body: JSON.stringify({ error: BLOCKED_MESSAGE }) };
      }

      // Blocco automatico: un cliente che non ha mai avuto un acquisto
      // "abbonato" e tenta un secondo acquisto non-abbonato viene bloccato
      // per tutte le richieste future (il controllo sopra lo intercetterà
      // dal tentativo successivo in poi).
      const { blobs } = await purchases.list();
      const priorItems = (await Promise.all(blobs.map((b) => purchases.get(b.key, { type: "json" })))).filter(Boolean);
      // Esclude il record dell'item stesso: un acquisto già salvato che
      // viene semplicemente ri-sincronizzato (es. cambio status "in
      // sospeso" -> "in confezionamento" -> "ritiro richiesto" ->
      // "ritirato") non è un "secondo acquisto" e non deve auto-bloccare
      // il cliente al primo acquisto legittimo.
      const emailItems = priorItems.filter((it) => normalizeEmail(it.touristEmail) === email && it.id !== item.id);

      if (emailItems.length > 0 && item.pricingTier !== "abbonato") {
        const everSubscribed = emailItems.some((it) => it.pricingTier === "abbonato");
        if (!everSubscribed) {
          await blocklist.setJSON(email, {
            email,
            reason: "Automatico: secondo acquisto senza abbonamento",
            auto: true,
            blockedAt: new Date().toISOString(),
          });
          return { statusCode: 403, body: JSON.stringify({ error: BLOCKED_MESSAGE }) };
        }
      }
    }

    // Accredito partner al passaggio a "ritirato" — sincronizzato dal
    // turista stesso (es. ConcludeScreen) tramite un resync completo
    // dell'item, non tramite l'azione "update-status" del CRM. La copia
    // già in store (non il payload in arrivo) è l'unica fonte affidabile
    // per il flag creditIssued: un client che risincronizza più volte lo
    // stesso item non deve poter far accreditare due volte il partner.
    if (item.status === "ritirato" && item.partnerCode) {
      const previousItem = await purchases.get(item.id, { type: "json" });
      if (previousItem && previousItem.creditIssued) {
        // Già accreditato: questo salvataggio sovrascrive l'intero record
        // (non è un merge), quindi riporta qui i campi già presenti in
        // store — altrimenti un resync da un client con copia locale
        // "vecchia" li cancellerebbe, riaprendo la porta a un doppio
        // accredito al prossimo resync.
        item.creditIssued = true;
        item.creditIssuedAmount = previousItem.creditIssuedAmount;
        item.creditIssuedAt = previousItem.creditIssuedAt;
      } else {
        const commission = Math.round((item.price || 0) * COMMISSION_RATE * 100) / 100;
        item.creditIssued = true;
        item.creditIssuedAmount = commission;
        item.creditIssuedAt = new Date().toISOString();
        if (commission > 0) {
          const partners = getStore({ name: "partners", ...blobsAuth });
          const partner = await partners.get(item.partnerCode, { type: "json" });
          if (partner) {
            partner.creditBalance = Math.round(((partner.creditBalance || 0) + commission) * 100) / 100;
            partner.updatedAt = new Date().toISOString();
            await partners.setJSON(item.partnerCode, partner);
          }
        }
      }
    }

    await purchases.setJSON(item.id, item);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
