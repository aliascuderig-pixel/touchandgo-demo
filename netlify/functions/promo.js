// Netlify serverless function — valida e consuma i codici invito per
// l'offerta "prima spedizione a prezzo breakeven" (fee di servizio
// azzerata, il turista paga solo il costo vivo del corriere).
//
// I codici sono creati dall'admin (crm.js, store "promo") per inviti
// mirati — non c'è distribuzione pubblica né generazione automatica.
// Ogni codice è single-use: una volta consumato con action "redeem",
// non è più valido per nessun altro turista.
//
// Endpoint pubblico (nessuna password): un turista deve solo conoscere
// il codice, ma non può enumerarli né vedere quali esistono — "check"
// e "redeem" rispondono sempre nello stesso formato per un codice
// inesistente o già usato, senza distinguere i due casi lato client.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

// Rate limiting — mancava fino a questa revisione di sicurezza, a
// differenza di quasi ogni altra function pubblica di questo repository
// (classify.js, save-purchase.js, save-review.js, save-shipment-group.js,
// sync.js, partner-discount.js, partner-stats.js, assistant.js). Il
// codice invito è generato dall'admin con un formato di ~17 milioni di
// combinazioni possibili (3 lettere + 3 cifre) — senza un limite di
// velocità, "check" da solo (che non consuma il codice) permetterebbe di
// enumerarle in sequenza senza mai lasciare traccia di un uso fallito,
// fino a trovarne uno valido e consumarlo prima del destinatario
// previsto.
//
// Stesso identico pattern (store Blobs "rate-limits", finestra scorrevole
// per IP) già usato in ogni altra function elencata sopra. STESSO limite
// (20 richieste/60 minuti) già scelto per save-review.js/classify.js/
// partner-stats.js/partner-discount.js: abbastanza permissivo per un
// turista reale che prova il proprio codice una o due volte anche con un
// typo (ben sotto 20 chiamate), ma abbastanza stretto da rendere un
// attacco automatizzato impraticabile — 20/ora per IP significa al
// massimo 480 tentativi/giorno, che su ~17 milioni di combinazioni
// richiederebbe secoli per esaurire lo spazio, altrettanto impraticabile
// quanto indovinare una password. Budget CONDIVISO tra "check" e "redeem"
// (stessa chiave `promo:IP` per entrambe le azioni, non una chiave
// separata per ciascuna): altrimenti alternare le due azioni
// raddoppierebbe il budget effettivo di un attaccante rispetto a quanto
// concesso a un IP onesto.
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
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Metodo non consentito" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { action, code } = body;
    const normalized = (code || "").trim().toUpperCase();

    if (!normalized) {
      return { statusCode: 400, body: JSON.stringify({ valid: false, error: "Codice mancante" }) };
    }

    // Applicato PRIMA di toccare lo store "promo" e per ENTRAMBE le
    // azioni (vedi commento sopra) — "check" da solo, senza mai chiamare
    // "redeem", è già sufficiente per enumerare i codici se non fosse
    // limitato allo stesso modo.
    const withinLimit = await checkRateLimit(`promo:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ valid: false, error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const promos = getStore({
      name: guestScopedStoreName("promo"),
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const record = await promos.get(normalized, { type: "json" });

    // Codice inesistente o disattivato dall'admin: stessa risposta di un
    // codice già usato, per non rivelare quali inviti esistono.
    if (!record || record.disabled) {
      return { statusCode: 200, body: JSON.stringify({ valid: false }) };
    }

    if (action === "check") {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: !record.redeemedAt, offer: "breakeven" }),
      };
    }

    if (action === "redeem") {
      if (record.redeemedAt) {
        return { statusCode: 200, body: JSON.stringify({ valid: false }) };
      }
      record.redeemedAt = new Date().toISOString();
      await promos.setJSON(normalized, record);
      return { statusCode: 200, body: JSON.stringify({ valid: true, offer: "breakeven" }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Azione non riconosciuta" }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "Errore interno" }) };
  }
};
