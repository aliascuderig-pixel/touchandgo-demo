// Netlify Function — router minimo per la continuità operativa di
// Touch&Go. Unico scopo: leggere ACTIVE_TARGET e rispondere con un
// redirect HTTP 302 verso il sito principale o lo spazio ospite.
//
// Deve restare la parte più semplice e affidabile di tutto il sistema:
// NESSUNA dipendenza da Netlify Blobs, dalla chiave ANTHROPIC_API_KEY o da
// qualunque altra risorsa che potrebbe essere lei stessa in crash. Zero
// pacchetti esterni, zero chiamate di rete: solo una variabile
// d'ambiente e una risposta HTTP.

const TARGETS = {
  main: "https://benevolent-longma-57c78a.netlify.app/",
  guest: "https://touchandgo-guest.netlify.app/",
};

exports.handler = async () => {
  const active = process.env.ACTIVE_TARGET;

  // Fallback sicuro: qualunque valore non riconosciuto (variabile assente,
  // vuota, refuso di battitura) punta sempre a "main" — mai un errore, mai
  // una pagina bianca, mai un redirect verso il nulla. Il comportamento di
  // default deve restare quello di produzione, non quello ospite.
  const url = TARGETS[active] || TARGETS.main;

  return {
    statusCode: 302,
    headers: {
      Location: url,
      // Il bersaglio del redirect cambia quando Giuseppe aggiorna
      // ACTIVE_TARGET su Netlify, senza un nuovo deploy — un browser o un
      // proxy che mettesse in cache questa risposta continuerebbe a
      // reindirizzare verso il sito sbagliato dopo il cambio, proprio nel
      // momento in cui contare su un link stabile è più importante.
      "Cache-Control": "no-store",
    },
    body: "",
  };
};
