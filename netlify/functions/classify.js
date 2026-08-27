// Netlify serverless function — keeps the Anthropic API key on the server,
// never exposed to visitors' browsers.
const { getStore } = require("@netlify/blobs");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}

// Finestra scorrevole per IP: al massimo RATE_LIMIT_MAX richieste ogni
// RATE_LIMIT_WINDOW_MS, altrimenti l'endpoint diventa un proxy gratuito
// verso l'API Anthropic pagata dalla nostra chiave.
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

// Archivio di riferimento doganale (store Blobs "customs-reference",
// popolato da save-purchase.js con categoria/codice HS/materiale di ogni
// classificazione andata a buon fine). Arricchimento del prompt, NON un
// matching per l'oggetto specifico che si sta classificando ora: a
// questo punto non conosciamo ancora categoria/materiale dell'oggetto in
// foto/descrizione (sono l'output della classificazione, non un input
// disponibile prima) — cercare una corrispondenza "simile" richiederebbe
// o un secondo giro di classificazione (costo/latenza doppi) o indovinare
// la categoria da un'euristica sul testo/nome file, entrambe fragili e
// fuori scope qui. Quello che si può fare in modo affidabile ORA è dare
// all'AI un contesto generale reale — un digest per categoria dei codici
// HS più frequenti — invece di farla indovinare da zero. Limitato a poche
// categorie/righe per non appesantire il prompt, e mai bloccante: un
// errore qui non deve mai impedire la classificazione.
//
// Cosa servirebbe per un matching davvero mirato in un secondo momento:
// una classificazione preliminare leggera (anche solo parole chiave nella
// descrizione testuale, quando l'input è testo e non foto) per scegliere
// QUALE bucket categoria+materiale interrogare prima della chiamata
// principale, oppure un secondo passaggio AI a due stadi (1: categoria
// approssimativa, 2: classificazione arricchita con gli esempi di quella
// categoria) — entrambi comportano una chiamata AI aggiuntiva, quindi
// costo/latenza da valutare con Giuseppe prima di implementarli.
const CUSTOMS_REFERENCE_MAX_CATEGORIES = 8;

async function buildCustomsReferenceContext(blobsAuth) {
  try {
    const store = getStore({ name: "customs-reference", ...blobsAuth });
    const { blobs } = await store.list();
    if (!blobs.length) return null;
    const entries = (
      await Promise.all(blobs.slice(0, CUSTOMS_REFERENCE_MAX_CATEGORIES).map((b) => store.get(b.key, { type: "json" })))
    ).filter((e) => e && e.mostCommonHsCode);
    if (!entries.length) return null;
    const lines = entries.map(
      (e) => `- ${e.category} / ${e.material}: codice HS più usato in passato ${e.mostCommonHsCode} (su ${e.count} classificazioni reali precedenti)`
    );
    return (
      "Riferimento da classificazioni precedenti realmente registrate su Touch&Go (contesto generale, non l'oggetto che stai classificando ora — usalo solo se pertinente, non forzare una corrispondenza):\n" +
      lines.join("\n")
    );
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: { message: "Method not allowed" } }) };
  }
  try {
    const { messages } = JSON.parse(event.body || "{}");
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: { message: "Richiesta non valida: 'messages' mancante o vuoto." } }),
      };
    }

    const withinLimit = await checkRateLimit(`classify:${getClientIp(event)}`);
    if (!withinLimit) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: { message: "Troppe richieste, riprova tra qualche minuto." } }),
      };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: { message: "Chiave API non configurata sul server (variabile ANTHROPIC_API_KEY mancante)." } })
      };
    }
    const blobsAuth = {
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    };
    const referenceContext = await buildCustomsReferenceContext(blobsAuth);
    const requestBody = {
      model: "claude-sonnet-5",
      max_tokens: 800,
      messages
    };
    if (referenceContext) requestBody.system = referenceContext;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(requestBody)
    });
    const data = await res.json();
    return {
      statusCode: res.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: { message: err.message } }) };
  }
};
