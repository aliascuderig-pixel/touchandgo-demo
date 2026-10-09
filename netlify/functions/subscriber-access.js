// Netlify serverless function — codice personale per l'ABBONATO a
// Touchandgo-app, per accedere dal PC alla stessa area di "Genera
// spedizione" già usata dai partner (vedi PartnerGenerateShipmentScreen in
// dist/assets/app.js). Due azioni:
//   - "register": emette un codice nuovo "ABB-XXXXXXXX" (8 caratteri senza
//     simboli ambigui) e lo salva nello store "subscribers". Chiamata
//     dall'app quando l'utente si abbona.
//   - "verify": dato un codice, risponde { valid: true|false }. Mai altro
//     (nessuna enumerazione dei codici esistenti).
//
// LIMITE NOTO: l'abbonamento all'app è ancora SIMULATO (state.isSubscribed,
// come i pagamenti dell'app), quindi "register" non può verificare un
// pagamento reale: chiunque può ottenere un codice. Quando l'abbonamento
// sarà reale, l'emissione va agganciata alla conferma del pagamento. Il
// registro porta source:"app-simulated" proprio per poter distinguere i
// codici emessi prima di allora. Frenano l'abuso un tetto di richieste per
// IP e il fatto che il codice dà SOLO accesso a "Genera spedizione" (mai a
// commissioni, crediti o dati di altri).
//
// I codici abbonato non sono codici partner: prefisso "ABB-" riservato,
// mai in "partners", mai usati per commissioni (vedi save-purchase.js).

const crypto = require("node:crypto");
const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

const CODE_PREFIX = "ABB-";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente I, O, 0, 1
const CODE_RE = /^ABB-[A-HJ-NP-Z2-9]{8}$/;
const RATE_LIMITS = { register: 10, verify: 30 };
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}

function blobs(name) {
  return getStore({
    name: guestScopedStoreName(name),
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

async function checkRateLimit(key, max) {
  const store = blobs("rate-limits");
  const now = Date.now();
  const record = (await store.get(key, { type: "json" })) || { count: 0, windowStart: now };
  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }
  record.count += 1;
  await store.setJSON(key, record);
  return record.count <= max;
}

function generateCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return CODE_PREFIX + s;
}

function isSubscriberCode(code) {
  return typeof code === "string" && CODE_RE.test(code);
}

const json = (statusCode, obj) => ({ statusCode, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  try {
    const { action, code } = JSON.parse(event.body || "{}");
    if (action !== "register" && action !== "verify") return json(400, { error: "Azione non valida" });

    const within = await checkRateLimit(`subscriber-${action}:${getClientIp(event)}`, RATE_LIMITS[action]);
    if (!within) return json(429, { error: "Troppe richieste, riprova tra qualche minuto." });

    const subscribers = blobs("subscribers");

    if (action === "register") {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateCode();
        if (await subscribers.get(candidate, { type: "json" })) continue;
        await subscribers.setJSON(candidate, { code: candidate, createdAt: new Date().toISOString(), source: "app-simulated" });
        return json(200, { code: candidate });
      }
      return json(500, { error: "Impossibile generare il codice, riprova." });
    }

    const normalized = String(code || "").trim().toUpperCase();
    if (!isSubscriberCode(normalized)) return json(200, { valid: false });
    const record = await subscribers.get(normalized, { type: "json" });
    return json(200, record ? { valid: true } : { valid: false });
  } catch (e) {
    return json(200, { valid: false });
  }
};

exports.isSubscriberCode = isSubscriberCode;
