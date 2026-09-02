// Netlify Function — router per la continuità operativa di Touch&Go.
//
// 1) ACTIVE_TARGET impostata esplicitamente -> vince sempre, bypassando
//    tutta la logica automatica sotto (override manuale per test o
//    emergenza — comportamento più forte, invariato rispetto a prima).
// 2) ACTIVE_TARGET assente (caso normale in produzione) -> failover
//    automatico verso lo spazio ospite quando la classificazione del sito
//    principale smette di funzionare (verificato tramite
//    netlify/functions/health.js del sito principale), con RIPRISTINO
//    SOLO MANUALE (mai automatico anche se il sito principale torna su da
//    solo) — vedi reset.js/dist/admin.html in questa stessa cartella e
//    MANUALE.md, "Router di continuità", per il perché: evitare che il
//    sistema "sbatta" avanti e indietro se il sito principale torna su e
//    giù ripetutamente.
//
// Principio del file originale, preservato per quanto possibile
// aggiungendo lo stato persistente richiesto dal punto 2: qualunque errore
// IMPREVISTO nella logica sotto (es. lo store del router irraggiungibile)
// deve risolvere sempre verso "main", mai verso "guest" — un guasto nel
// meccanismo di failover stesso non deve mai bloccare l'accesso al sito
// principale quando quello in realtà funziona. Vedi il catch-all in fondo.
const { readState, writeState } = require("../lib/router-state");

const TARGETS = {
  main: "https://benevolent-longma-57c78a.netlify.app/",
  guest: "https://touchandgo-guest.netlify.app/",
};

const HEALTH_CHECK_TIMEOUT_MS = 4000;

// Intervallo minimo tra due controlli di salute reali quando tutto va bene
// (evita di richiamare health.js — e quindi l'API Anthropic — a ogni
// singola visita). 45s: abbastanza breve da accorgersi di un'interruzione
// reale in meno di un minuto, abbastanza lungo da tagliare drasticamente
// le chiamate durante traffico continuo (al più ~80/ora invece di una per
// visitatore). Vedi MANUALE.md per il ragionamento completo.
const HEALTH_DEBOUNCE_MS = 45 * 1000;

function redirectTo(url) {
  return {
    statusCode: 302,
    headers: {
      Location: url,
      // Stesso motivo di sempre (vedi commento storico): il bersaglio può
      // cambiare senza un nuovo deploy, una risposta cacheata punterebbe
      // al sito sbagliato proprio quando serve di più un link affidabile.
      "Cache-Control": "no-store",
    },
    body: "",
  };
}

// Non lancia MAI eccezioni: qualunque esito (rete, timeout, status non-200)
// diventa un { ok:false, reason } ordinario — è il segnale di design per
// far scattare il failover, non un errore imprevisto del meccanismo.
async function checkMainHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(TARGETS.main + ".netlify/functions/health", {
      method: "GET",
      signal: controller.signal,
    });
    if (res.status === 200) return { ok: true };
    let reason = "http_" + res.status;
    try {
      const data = await res.json();
      if (data && data.reason) reason = data.reason;
    } catch (e) {
      // corpo non-JSON o vuoto — reason resta il codice di stato HTTP
    }
    return { ok: false, reason };
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" ? "health_check_timeout" : "health_check_unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

exports.handler = async () => {
  const active = process.env.ACTIVE_TARGET;
  if (active) {
    return redirectTo(TARGETS[active] || TARGETS.main);
  }

  // Da qui in poi: logica automatica. Qualunque eccezione non gestita
  // esplicitamente sotto (store irraggiungibile in lettura o scrittura,
  // bug imprevisto) arriva al catch in fondo -> sempre "main".
  try {
    const state = await readState();

    if (state.failoverActive) {
      // Già in failover: NESSUN nuovo controllo di salute (evita di
      // martellare health.js a ogni visita) e nessuna scrittura — se ne
      // esce solo con il ripristino manuale (reset.js).
      return redirectTo(TARGETS.guest);
    }

    const lastCheckRecent =
      state.lastCheckAt && Date.now() - new Date(state.lastCheckAt).getTime() < HEALTH_DEBOUNCE_MS;
    if (lastCheckRecent && state.lastCheckOk === true) {
      // Controllo recente e riuscito: ci fidiamo dell'ultimo esito, niente
      // nuova chiamata a health.js e nessuna scrittura.
      return redirectTo(TARGETS.main);
    }

    const health = await checkMainHealth();

    if (health.ok) {
      // Best-effort: solo il timestamp/esito per il debounce. Un
      // fallimento qui non deve MAI cambiare la destinazione — il sito
      // principale funziona comunque, quindi si va lì indipendentemente
      // dal fatto che questa scrittura riesca o meno (per questo è in un
      // try/catch locale, non nel catch-all generale).
      try {
        await writeState({
          failoverActive: false,
          since: null,
          reason: null,
          lastCheckAt: new Date().toISOString(),
          lastCheckOk: true,
        });
      } catch (e) {
        // ignorato di proposito — vedi commento sopra
      }
      return redirectTo(TARGETS.main);
    }

    // Controllo di salute fallito per davvero: NON è un errore imprevisto
    // del meccanismo, è il segnale di design che il failover deve
    // scattare (vedi checkMainHealth sopra). Se questa scrittura fallisce
    // (es. store irraggiungibile), l'eccezione arriva al catch in fondo ->
    // "main" comunque: mai mandare qualcuno su "guest" senza aver potuto
    // registrare in modo affidabile che ci si è finiti.
    await writeState({
      failoverActive: true,
      since: new Date().toISOString(),
      reason: health.reason,
      lastCheckAt: new Date().toISOString(),
      lastCheckOk: false,
    });
    return redirectTo(TARGETS.guest);
  } catch (e) {
    return redirectTo(TARGETS.main);
  }
};
