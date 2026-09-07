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

// CRM (repository interno, sito protetto a livello di dominio dalla
// "Password Protection"/Visitor Access di Netlify — piano a pagamento).
//
// *** ATTENZIONE — QUESTA SEZIONE CONTIENE ASSUNZIONI NON VERIFICATE ***
// Il tentativo precedente usava un header "Authorization: Basic", SBAGLIATO:
// la Visitor Access di Netlify non è Basic Auth, è un login con password
// che restituisce un cookie di sessione (da cui l'errore sempre presente
// "crm_visitor_auth_fallita"). Non è stato possibile, né dall'utente né da
// qui (questo ambiente ha l'intero dominio netlify.app/netlify.com bloccato
// dalla policy di rete — verificato esplicitamente su più sottodomini,
// inclusa la documentazione pubblica di Netlify: nessun modo di ispezionare
// la richiesta di login reale), catturare la POST di login effettiva.
//
// Quello che SAPPIAMO per certo (ispezione browser reale dell'utente, non
// documentazione generica): il cookie di sessione impostato dopo un login
// riuscito si chiama esattamente come il site ID del progetto Netlify
// (CRM_SITE_ID sotto) e il suo valore è un JWT.
//
// Quello che ASSUMIAMO, NON verificato, e va confermato manualmente prima
// di fidarsi ciecamente di questo codice in produzione (vedi MANUALE.md,
// sezione dedicata, con la checklist esatta da controllare nei DevTools):
// - Il form di login compare quando si richiede una pagina reale del sito
//   (qui usiamo CRM_LOGIN_URL = .../site/admin.html, la pagina vera del
//   CRM) e può contenere campi nascosti (es. token CSRF) oltre al campo
//   password — extractHiddenFields() li individua ed è un no-op innocuo se
//   non ce ne sono, quindi il codice non si rompe se questa parte
//   dell'assunzione è sbagliata (semplicemente non aggiunge nulla).
// - Il campo del form per la password si chiama "password".
// - Il form fa POST alla STESSA pagina (o all'action esplicita del form,
//   se presente e diversa) — extractFormAction() usa l'action se c'è,
//   altrimenti ricade sulla pagina stessa.
// - La risposta (200 con contenuto, o un redirect) porta il cookie di
//   sessione in un header Set-Cookie — per questo la POST di login usa
//   redirect:"manual": lato server Node/undici questo permette di leggere
//   Set-Cookie anche se Netlify rispondesse con un redirect 3xx invece che
//   con contenuto diretto (a differenza del comportamento "opaco" dei
//   redirect manuali nei browser, qui gli header restano leggibili).
//
// Se una di queste assunzioni è sbagliata, il login fallisce in modo
// ESPLICITO e DISTINGUIBILE da un problema di rete/sito down
// ("crm_visitor_login_fallito", mai confuso con "timeout"/"unreachable" —
// vedi timeoutOrUnreachable(), usato solo per veri errori di rete/timeout).
// Stessa cosa per una password sbagliata: nessun cookie valido nella
// risposta di login -> stesso errore esplicito, mai un falso "ok".
const CRM_SITE_ID = "81ef474e-77e4-4852-bfae-0e159f6a2931"; // = nome del cookie di sessione (confermato da ispezione browser reale, non un'assunzione)
const CRM_LOGIN_URL = TARGETS.crm + "site/admin.html"; // pagina reale del CRM, usata SOLO per il login — vedi ASSUNZIONI sopra

// Estrae { name, value } di ogni <input type="hidden" ...> nell'HTML del
// gate di login — se il form ne avesse (es. un token CSRF) vanno rimandati
// indietro nella POST di login insieme alla password. Se non ce ne sono
// (o se l'HTML non è nel formato atteso), restituisce un array vuoto: la
// POST di login prosegue comunque con la sola password, non si rompe.
function extractHiddenFields(html) {
  const fields = [];
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(html || "")) !== null) {
    const tag = m[0];
    if (!/type\s*=\s*["']hidden["']/i.test(tag)) continue;
    const nameMatch = tag.match(/name\s*=\s*["']([^"']+)["']/i);
    const valueMatch = tag.match(/value\s*=\s*["']([^"']*)["']/i);
    if (nameMatch) fields.push({ name: nameMatch[1], value: valueMatch ? valueMatch[1] : "" });
  }
  return fields;
}

// Estrae l'attributo action del primo <form> nell'HTML, risolto come URL
// assoluto rispetto a pageUrl. Se il form non ha un action esplicito (o è
// vuoto, il caso più comune: "posta sulla pagina corrente"), o se non è
// stato trovato nessun <form>, ricade su pageUrl stesso.
function extractFormAction(html, pageUrl) {
  const match = (html || "").match(/<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/i);
  if (!match || !match[1]) return pageUrl;
  try {
    return new URL(match[1], pageUrl).toString();
  } catch (e) {
    return pageUrl;
  }
}

// Estrae il valore del cookie CRM_SITE_ID da tutti gli header Set-Cookie di
// una risposta (login riuscito) — usa getSetCookie() se disponibile (Node
// 18.14+/20+, restituisce ogni Set-Cookie separatamente, corretto quando ce
// n'è più di uno), altrimenti ricade su un singolo header combinato.
function extractSessionCookie(res) {
  const setCookieHeaders = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`^${CRM_SITE_ID}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

// Esegue il login reale contro la Visitor Access di Netlify — vedi il
// commento sulle ASSUNZIONI sopra checkCrm() per ogni passaggio. Restituisce
// il valore del cookie di sessione se il login è riuscito, null altrimenti
// (password sbagliata, o una delle assunzioni sul formato della richiesta
// non corrisponde a quella reale — nessuna differenza visibile da qui tra
// i due casi, motivo per cui va verificato manualmente, vedi MANUALE.md).
async function loginToVisitorProtectedSite(password) {
  const gate = await fetch(CRM_LOGIN_URL, { redirect: "manual" });
  const gateHtml = gate.status < 400 ? await gate.text().catch(() => "") : "";
  const hiddenFields = extractHiddenFields(gateHtml);
  const loginUrl = extractFormAction(gateHtml, CRM_LOGIN_URL);

  const body = new URLSearchParams();
  body.set("password", password);
  for (const field of hiddenFields) body.set(field.name, field.value);

  const res = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
  return extractSessionCookie(res);
}

async function checkCrm() {
  const start = Date.now();
  const password = process.env.CRM_VISITOR_PASSWORD;
  if (!password) {
    return { status: "problem", responseTimeMs: Date.now() - start, error: "crm_visitor_password_non_configurata" };
  }

  let sessionCookie;
  try {
    sessionCookie = await loginToVisitorProtectedSite(password);
  } catch (err) {
    return timeoutOrUnreachable(err, start);
  }
  if (!sessionCookie) {
    // Password sbagliata, oppure una delle assunzioni sul formato del
    // login non corrisponde a quello reale — in entrambi i casi un errore
    // esplicito e distinto da timeout/unreachable, mai un falso "ok".
    return { status: "problem", responseTimeMs: Date.now() - start, error: "crm_visitor_login_fallito" };
  }

  const headers = { "Content-Type": "application/json", Cookie: `${CRM_SITE_ID}=${sessionCookie}` };
  try {
    const { res, responseTimeMs } = await timedFetch(TARGETS.crm + ".netlify/functions/crm", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "__daily_healthcheck_probe__" }),
    });
    if (res.status === 401 || res.status === 403) {
      return { status: "problem", responseTimeMs, error: "crm_visitor_login_fallito" };
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
exports.CRM_SITE_ID = CRM_SITE_ID;
exports.CRM_LOGIN_URL = CRM_LOGIN_URL;
exports.extractHiddenFields = extractHiddenFields;
exports.extractFormAction = extractFormAction;
exports.extractSessionCookie = extractSessionCookie;
exports.loginToVisitorProtectedSite = loginToVisitorProtectedSite;
