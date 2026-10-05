// Infrastruttura di analytics di engagement — Fase 2 EaaS (vedi
// MANUALE.md, "Analytics di engagement"). Decisione presa con Giuseppe il
// 5/10: validare l'adozione reale dei pezzi Fase 1 EaaS e, più in
// generale, l'engagement su tutta la suite (turisti, partner, staff).
//
// PRINCIPIO DI PRIVACY NON NEGOZIABILE, verificato prima di scrivere
// codice: questo store contiene SOLO CONTEGGI aggregati per
// giorno/fonte/ruolo/evento — mai un singolo evento con dettagli, mai un
// payload utente (nessun touristEmail/partnerCode/nome qui dentro). Lo
// stesso principio già applicato ovunque in questo ecosistema per i dati
// sensibili (es. anti-frode: segnalazione mai raccolta dati extra).
//
// Store Blobs CONDIVISO ("usage-analytics", stesse credenziali
// NETLIFY_BLOBS_SITE_ID/TOKEN già condivise da tutti i repository della
// suite) — stesso identico file (stesso principio di duplicazione
// deliberata già in uso ovunque: nessun modulo condiviso tra repository)
// copiato anche in touchandgo-internal/gestionale/eshop. Questa copia
// SCRIVE SOLO — la lettura/aggregazione avviene solo in
// touchandgo-internal (CRM, tab "Engagement", azione "list-engagement" in
// netlify/functions/crm.js), quindi qui non esportiamo listRollups().
//
// Guest-scoped con lo stesso principio già in uso per tutti gli altri
// store condivisi di questo repository (guestScopedStoreName, suffisso
// "-guest"): un evento generato durante un'esecuzione in modalità ospite
// finisce in "usage-analytics-guest", MAI mescolato con i conteggi reali
// mostrati allo staff.
//
// Rollup giornaliero, non un log per evento: una chiave per
// giorno+fonte+ruolo+evento (es. "2026-10-05__demo__turista__app_opened"),
// valore { count, lastAt }, incrementato ad ogni chiamata — non atomico
// (get poi setJSON, stessa tolleranza già accettata per il rate limiting
// in questo repository: un conteggio leggermente impreciso in caso di
// scritture concorrenti nello stesso istante non è un problema per uno
// strumento di stima di gradimento, mai usato per decisioni di
// fatturazione/sicurezza).
const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("./guest-mode");

const STORE_NAME = "usage-analytics";
const MAX_METADATA_KEYS = 4; // difesa in profondità: anche se un chiamante passasse metadata, ne limitiamo l'ampiezza

function blobsAuth() {
  return {
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

function todayKey(now) {
  return (now || new Date()).toISOString().slice(0, 10);
}

function rollupKey(date, source, role, event) {
  return `${date}__${source}__${role}__${event}`;
}

// metadata: SOLO valori primitivi corti, mai un oggetto/array annidato —
// pensato per un'etichetta facoltativa, mai per dati identificativi. Ogni
// chiamante passa comunque il proprio allowedEvents: un evento non
// nell'allowlist di quella fonte è un errore di programmazione da far
// emergere subito (mai un evento silenzioso non previsto), non un dato
// malformato da scartare in silenzio.
function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return undefined;
  const entries = Object.entries(metadata)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, MAX_METADATA_KEYS);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 60) : v]));
}

async function logEvent(event, { source, role, allowedEvents, metadata, now } = {}) {
  if (!source || typeof source !== "string") throw new Error("usage-analytics: 'source' obbligatorio");
  if (!role || typeof role !== "string") throw new Error("usage-analytics: 'role' obbligatorio");
  if (Array.isArray(allowedEvents) && !allowedEvents.includes(event)) {
    throw new Error(`usage-analytics: evento "${event}" non nell'allowlist della fonte "${source}"`);
  }
  const store = getStore({ name: guestScopedStoreName(STORE_NAME), ...blobsAuth() });
  const date = todayKey(now);
  const key = rollupKey(date, source, role, event);
  const existing = (await store.get(key, { type: "json" })) || { date, source, role, event, count: 0 };
  existing.count += 1;
  existing.lastAt = (now || new Date()).toISOString();
  const cleanMetadata = sanitizeMetadata(metadata);
  if (cleanMetadata) existing.lastMetadata = cleanMetadata;
  await store.setJSON(key, existing);
  return existing;
}

module.exports = { logEvent, STORE_NAME, todayKey, rollupKey };
