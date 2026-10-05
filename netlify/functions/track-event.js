// Netlify serverless function — endpoint pubblico che riceve gli eventi di
// engagement del client (dist/assets/app.js) e li registra in forma
// aggregata tramite ../lib/usage-analytics (vedi MANUALE.md, "Analytics di
// engagement — Fase 2 EaaS"). Fire-and-forget dal lato client: la chiamata
// non blocca mai il flusso UI (nessun await nel chiamante, errori
// silenziosamente ignorati lì — vedi trackEvent() in app.js).
//
// POST, non GET: a differenza di airline-baggage-fees.js/category-averages.js
// (dati identici per tutti), qui ogni chiamata individua un evento preciso.
//
// Allowlist esplicita (DEMO_ALLOWED_EVENTS, sotto) — stesso principio già
// in usage-analytics.js: un evento non previsto è un errore di
// programmazione da far emergere subito (risposta 400), mai un evento
// silenzioso accettato e basta.
//
// role: questa è l'app turista pubblica — qui "turista" è l'unico ruolo
// plausibile per un visitatore di questo sito (il percorso "genera per
// conto di un cliente" nell'area partner di questo stesso repository non è
// ancora strumentato, resta fuori dallo scope v1 — vedi MANUALE.md).

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");
const { logEvent } = require("../lib/usage-analytics");

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti — più permissivo delle altre funzioni pubbliche: più eventi per sessione sono normali

const SOURCE = "demo";
const DEMO_ALLOWED_EVENTS = ["app_opened", "classification_completed", "purchase_saved", "agent_chat_opened"];
const ALLOWED_ROLES = ["turista"];

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}

function blobsAuth() {
  return {
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

async function checkRateLimit(key) {
  const store = getStore({ name: guestScopedStoreName("rate-limits"), ...blobsAuth() });
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
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const withinLimit = await checkRateLimit(`track-event:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "JSON non valido" }) };
    }

    const { event: eventName, role } = body || {};
    if (!DEMO_ALLOWED_EVENTS.includes(eventName)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Evento non riconosciuto" }) };
    }
    const safeRole = ALLOWED_ROLES.includes(role) ? role : "turista";

    await logEvent(eventName, { source: SOURCE, role: safeRole, allowedEvents: DEMO_ALLOWED_EVENTS });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

exports.DEMO_ALLOWED_EVENTS = DEMO_ALLOWED_EVENTS;
