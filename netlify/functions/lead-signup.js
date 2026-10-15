// Netlify serverless function — iscrizione dalla pagina pubblica
// dist/site/iscrizione.html (destinazione del pulsante «Iscriviti» del
// video promozionale). Raccoglie l'email di chi vuole ricevere
// informazioni gratuite su Touch&Go, con consenso esplicito e
// registrato (testo + versione + data/ora).
//
// Le iscrizioni finiscono nello store Blobs "leads" (via
// guestScopedStoreName), da cui il CRM di touchandgo-internal le legge
// (tab "Iscrizioni", vedi MANUALE.md). Nessun invio di email da qui.
// Il testo email NON viene escapato a riposo: chi lo mostra (il CRM)
// deve fare l'escaping al rendering.
//
// Difese: validazione stretta, honeypot "website" (se compilato
// rispondiamo 200 ma non salviamo: il bot non impara nulla), rate
// limiting per IP (stessa copia per-file delle altre function).

const crypto = require("node:crypto");
const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// Versione del testo di consenso mostrato in pagina: se cambia il testo
// in iscrizione.html va incrementata anche questa.
const CONSENT_VERSION = "2026-10-15-v1";
const EMAIL_MAX_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ALLOWED_PROFILES = ["turista", "negoziante", "agenzia", "tour-operator", "altro"];
const ALLOWED_SOURCES = ["video", "sito", "altro"];

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

// Chiave = hash dell'email normalizzata: la stessa email non crea
// duplicati e non serve mettere l'indirizzo nel nome del blob.
function leadKey(email) {
  return "LD-" + crypto.createHash("sha256").update(email).digest("hex").slice(0, 24);
}

function isValid(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.email !== "string") return false;
  const email = body.email.trim();
  if (!email || email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) return false;
  if (body.consent !== true) return false;
  if (body.profile !== undefined && body.profile !== null && !ALLOWED_PROFILES.includes(body.profile)) return false;
  if (body.source !== undefined && body.source !== null && !ALLOWED_SOURCES.includes(body.source)) return false;
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const body = JSON.parse(event.body || "{}");

    // Honeypot: campo invisibile agli umani.
    if (body && typeof body.website === "string" && body.website.trim()) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
    }

    if (!isValid(body)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Inserisci un'email valida e spunta il consenso." }) };
    }

    const withinLimit = await checkRateLimit(`lead-signup:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const email = body.email.trim().toLowerCase();
    const leads = getStore({
      name: guestScopedStoreName("leads"),
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const id = leadKey(email);

    // Già iscritto: risposta identica (non riveliamo se l'email esisteva)
    // e il record originale — con la data del primo consenso — resta.
    const existing = await leads.get(id, { type: "json" });
    if (!existing) {
      await leads.setJSON(id, {
        id,
        email,
        profile: body.profile || null,
        source: body.source || "video",
        consent: true,
        consentVersion: CONSENT_VERSION,
        status: "new",
        createdAt: new Date().toISOString(),
      });
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "Errore temporaneo, riprova." }) };
  }
};

exports.CONSENT_VERSION = CONSENT_VERSION;
