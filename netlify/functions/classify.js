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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 800,
        messages
      })
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
