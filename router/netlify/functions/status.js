// Netlify Function — stato del router in sola lettura, per monitoraggio
// esterno (netlify/functions/daily-healthcheck.js nel sito principale,
// vedi MANUALE.md, "Controllo giornaliero automatico").
//
// A differenza di go.js, questo endpoint NON chiama MAI checkMainHealth()
// né writeState(): legge solo lo stato già persistito (readState(), la
// stessa funzione pura usata da go.js per decidere se reindirizzare) e lo
// restituisce come JSON. Nessuna possibilità di innescare un failover o di
// alterare il debounce, qualunque sia il momento o la frequenza con cui
// questo endpoint viene chiamato.
const { readState } = require("../lib/router-state");

const TARGETS = {
  main: "https://benevolent-longma-57c78a.netlify.app/",
  guest: "https://touchandgo-guest.netlify.app/",
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

exports.handler = async () => {
  try {
    const active = process.env.ACTIVE_TARGET;
    if (active) {
      return respond(200, { ok: true, mode: "override", redirectsTo: TARGETS[active] || TARGETS.main, state: null });
    }
    const state = await readState();
    return respond(200, {
      ok: true,
      mode: "auto",
      redirectsTo: state.failoverActive ? TARGETS.guest : TARGETS.main,
      state,
    });
  } catch (err) {
    // Anche un errore imprevisto (es. store irraggiungibile) resta un 200
    // "ok:false" descrittivo, non un'eccezione: chi chiama questo endpoint
    // (il controllo giornaliero) deve poter distinguere "il router ha
    // risposto ma con un problema" da "il router non risponde affatto".
    return respond(200, { ok: false, reason: err.message || "router_status_error" });
  }
};
