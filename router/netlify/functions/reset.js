// Netlify Function — ripristino manuale del router dopo un failover
// automatico verso lo spazio ospite. Vedi MANUALE.md, "Router di
// continuità" -> "Ripristino manuale (solo umano)".
//
// Fa UNA SOLA cosa: azzera failoverActive a false (e cancella il timestamp
// dell'ultimo controllo, così la richiesta successiva a go.js torna a
// controllare davvero la salute del sito principale invece di fidarsi di
// un esito vecchio). Nessun'altra funzione, apposta — deve restare la
// parte più semplice e indipendente di tutto il sistema: dipende solo dal
// proprio store Blobs dedicato, quindi funziona anche se il sito
// principale o il CRM sono giù.
const { writeState } = require("../lib/router-state");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const configuredPassword = process.env.ROUTER_ADMIN_PASSWORD;
  if (!configuredPassword) {
    return {
      statusCode: 503,
      body: JSON.stringify({ error: "ROUTER_ADMIN_PASSWORD non configurata su questo sito." }),
    };
  }

  let password;
  try {
    password = JSON.parse(event.body || "{}").password;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Richiesta non valida." }) };
  }

  // Confronto esplicito con typeof: se la password configurata esiste ma
  // il body non ne manda una (campo assente/undefined), la richiesta deve
  // fallire — mai un confronto "undefined === undefined" che passerebbe
  // per sbaglio.
  if (typeof password !== "string" || password !== configuredPassword) {
    return { statusCode: 401, body: JSON.stringify({ error: "Password errata." }) };
  }

  try {
    await writeState({
      failoverActive: false,
      since: null,
      reason: null,
      lastCheckAt: null,
      lastCheckOk: null,
    });
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Impossibile scrivere lo stato: " + e.message }) };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  };
};
