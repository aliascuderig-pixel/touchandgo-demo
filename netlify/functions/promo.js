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

    const promos = getStore({
      name: "promo",
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
