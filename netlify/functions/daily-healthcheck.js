// Netlify Scheduled Function — controllo giornaliero automatico di tutti i
// "dispositivi" del progetto (sito principale, spazio ospite, router di
// continuità, CRM interno) — vedi MANUALE.md, "Controllo giornaliero
// automatico". Esegue SOLO verifiche di raggiungibilità/salute a costo
// minimo (mai una vera classificazione: la stessa sonda a costo zero già
// usata da health.js per il sito principale/ospite, e per il CRM una
// action Blobs-free) e non modifica MAI stato reale: nessun failover del
// router, nessun acquisto/recensione fittizia.
//
// `schedule()` di @netlify/functions non fa altro, a runtime, che
// restituire l'handler invariato (v6.0.0: `schedule = (cron, handler) =>
// handler`) — l'espressione cron viene letta staticamente in fase di
// build da Netlify per registrare il trigger. Questo significa che
// chiamare l'URL della function anche manualmente (curl, test locale)
// esegue davvero l'handler e ne restituisce il risultato reale: è così
// che la "Verifica finale" richiesta viene fatta, senza dover aspettare
// lo scheduler.
const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");
const { isGuestMode, guestScopedStoreName } = require("../lib/guest-mode");

const TIMEOUT_MS = 4000;
const STORE_NAME = "system-reports";
const STATE_KEY_PREFIX = ""; // le chiavi sono direttamente la data "YYYY-MM-DD"

// Quanti report giornalieri tenere in archivio. Netlify Blobs non ha una
// TTL nativa per singola chiave, quindi la "pulizia" è fatta qui:
// dopo ogni scrittura, elenchiamo tutte le chiavi (sono stringhe
// "YYYY-MM-DD", quindi l'ordine lessicografico coincide con quello
// cronologico) e cancelliamo tutto tranne le più recenti KEEP_DAYS. Niente
// meccanismo di scadenza separato da orchestrare: si autopulisce ad ogni
// esecuzione, ed è la stessa function a scrivere e a fare pulizia, quindi
// non può mai "dimenticarsene". 30 giorni bastano per uno storico utile
// nel CRM (un mese) senza far crescere lo store indefinitamente.
const KEEP_DAYS = 30;

const TARGETS = {
  main: "https://benevolent-longma-57c78a.netlify.app/",
  guest: "https://touchandgo-guest.netlify.app/",
  router: "https://touchandgo-router.netlify.app/",
  crm: "https://cute-moxie-cd1e4b.netlify.app/",
};

function blobsAuth() {
  return {
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

// Fetch con timeout e tempo di risposta misurato — stesso pattern
// AbortController usato in tutto il repository (health.js, go.js). Non
// lancia mai: qualunque esito (rete, timeout, status inatteso) diventa un
// { status: "ok"|"problem", responseTimeMs, error? } ordinario, così un
// singolo dispositivo irraggiungibile non impedisce mai di controllare gli
// altri né di salvare comunque il report (parziale) — vedi vincoli in
// MANUALE.md.
async function timedFetch(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { res, responseTimeMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

function timeoutOrUnreachable(err, start) {
  return {
    status: "problem",
    responseTimeMs: Date.now() - start,
    error: err.name === "AbortError" ? "timeout" : err.message || "unreachable",
  };
}

// Sito principale e spazio ospite condividono lo stesso health.js (stesso
// repository, due deploy distinti — vedi MANUALE.md, "Spazio ospite"):
// stessa verifica per entrambi, cambia solo l'URL di base.
async function checkHealthEndpoint(baseUrl) {
  const start = Date.now();
  try {
    const { res, responseTimeMs } = await timedFetch(baseUrl + ".netlify/functions/health");
    if (res.status === 200) return { status: "ok", responseTimeMs };
    let error = "http_" + res.status;
    try {
      const data = await res.json();
      if (data && data.reason) error = data.reason;
    } catch (e) {
      // corpo non-JSON o vuoto — error resta il codice di stato HTTP
    }
    return { status: "problem", responseTimeMs, error };
  } catch (err) {
    return timeoutOrUnreachable(err, start);
  }
}

// Router: usa SOLO netlify/functions/status.js (sola lettura, non chiama
// mai checkMainHealth()/writeState() — vedi il file stesso), mai go.js.
// "Redirects correctly" viene verificato controllando che il target
// calcolato dal router sia effettivamente uno dei due siti noti, non solo
// che l'endpoint risponda 200.
async function checkRouter() {
  const start = Date.now();
  try {
    const { res, responseTimeMs } = await timedFetch(TARGETS.router + ".netlify/functions/status");
    if (res.status !== 200) return { status: "problem", responseTimeMs, error: "http_" + res.status };
    let data;
    try {
      data = await res.json();
    } catch (e) {
      return { status: "problem", responseTimeMs, error: "invalid_json" };
    }
    if (!data || data.ok !== true) {
      return { status: "problem", responseTimeMs, error: (data && data.reason) || "router_status_not_ok" };
    }
    if (data.redirectsTo !== TARGETS.main && data.redirectsTo !== TARGETS.guest) {
      return { status: "problem", responseTimeMs, error: "router_target_inatteso" };
    }
    return { status: "ok", responseTimeMs };
  } catch (err) {
    return timeoutOrUnreachable(err, start);
  }
}

// CRM (repository interno, sito protetto da password a livello di dominio
// — Netlify Visitor Access): la sonda è una POST a crm.js con una action
// sconosciuta, che risponde 400 "Unknown action" a costo zero (nessuna
// lettura/scrittura Blobs, nessuna azione reale) — vedi indagine
// preliminare (Parte 1) riportata all'utente. Se CRM_VISITOR_USER/
// CRM_VISITOR_PASSWORD non sono configurate, la richiesta parte comunque
// senza autenticazione: se il sito è protetto, verrà bloccata dalla
// Visitor Access stessa (401/403) e il problema viene riportato in modo
// esplicito ("non configurato"), MAI spacciato per "ok" — non possiamo
// verificare qui se il CRM applicativo è davvero raggiungibile finché
// quelle variabili non vengono impostate su Netlify.
async function checkCrm() {
  const start = Date.now();
  const user = process.env.CRM_VISITOR_USER;
  const pass = process.env.CRM_VISITOR_PASSWORD;
  const headers = { "Content-Type": "application/json" };
  if (user && pass) {
    headers.Authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }
  try {
    const { res, responseTimeMs } = await timedFetch(TARGETS.crm + ".netlify/functions/crm", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "__daily_healthcheck_probe__" }),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        status: "problem",
        responseTimeMs,
        error: user && pass ? "crm_visitor_auth_fallita" : "crm_visitor_auth_non_configurata",
      };
    }
    if (res.status === 400) {
      let body = null;
      try {
        body = await res.json();
      } catch (e) {
        // corpo non-JSON: trattato come risposta inattesa sotto
      }
      if (body && body.error === "Unknown action") return { status: "ok", responseTimeMs };
      return { status: "problem", responseTimeMs, error: "crm_risposta_inattesa" };
    }
    return { status: "problem", responseTimeMs, error: "http_" + res.status };
  } catch (err) {
    return timeoutOrUnreachable(err, start);
  }
}

async function runChecks() {
  // Promise.all e non Promise.allSettled: ogni check* sopra intercetta già
  // internamente qualunque errore e restituisce sempre un oggetto
  // { status, ... } — non può mai rifiutarsi. Se comunque uno dei quattro
  // rifiutasse per un bug imprevisto, il chiamante (handler sotto) ha
  // comunque un try/catch attorno a runChecks() per garantire che un
  // report parziale venga salvato lo stesso.
  const [main, guest, router, crm] = await Promise.all([
    checkHealthEndpoint(TARGETS.main),
    checkHealthEndpoint(TARGETS.guest),
    checkRouter(),
    checkCrm(),
  ]);
  return { main, guest, router, crm };
}

async function cleanupOldReports(store) {
  try {
    const { blobs } = await store.list();
    const keys = blobs.map((b) => b.key).sort();
    const toDelete = keys.slice(0, Math.max(0, keys.length - KEEP_DAYS));
    await Promise.all(toDelete.map((key) => store.delete(key).catch(() => {})));
  } catch (e) {
    // Best-effort: un errore nella pulizia non deve mai far fallire il
    // salvataggio del report del giorno, già avvenuto prima di chiamare
    // questa funzione.
  }
}

async function runDailyHealthcheck() {
  // Lo spazio ospite è lo STESSO repository deployato come secondo sito
  // Netlify (GUEST_MODE=true) — se non ci fermassimo qui, lo scheduler di
  // QUEL deploy eseguirebbe anch'esso questa stessa function ogni giorno,
  // producendo due report duplicati (e due tentativi di autenticazione al
  // CRM) invece di uno. Il controllo di sistema è un'unica responsabilità
  // di produzione: deve girare solo lì.
  if (isGuestMode()) {
    return { skipped: true, reason: "guest_mode" };
  }

  const devices = await runChecks();
  const overallStatus = Object.values(devices).every((d) => d.status === "ok") ? "ok" : "problem";
  const checkedAt = new Date().toISOString();
  const report = {
    date: checkedAt.slice(0, 10),
    checkedAt,
    overallStatus,
    devices,
  };

  const store = getStore({ name: guestScopedStoreName(STORE_NAME), ...blobsAuth() });
  await store.setJSON(STATE_KEY_PREFIX + report.date, report);
  await cleanupOldReports(store);

  return report;
}

exports.handler = schedule("0 6 * * *", async () => {
  try {
    const report = await runDailyHealthcheck();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(report),
    };
  } catch (err) {
    // Anche un errore imprevisto QUI (es. lo store "system-reports"
    // irraggiungibile in scrittura) non deve mai propagarsi come
    // eccezione non gestita: risponde comunque 200 con l'errore
    // descritto, così un'esecuzione manuale di test lo vede chiaramente
    // invece di un 500 generico.
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: err.message || "daily_healthcheck_error" }),
    };
  }
});

// Esportate per i test — vedi __tests__/daily-healthcheck.test.js.
exports.runDailyHealthcheck = runDailyHealthcheck;
exports.TARGETS = TARGETS;
