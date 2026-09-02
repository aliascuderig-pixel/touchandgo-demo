// Helper condiviso da tutte le Netlify Functions di questo repository —
// vedi MANUALE.md, sezione "Spazio ospite (continuità operativa)".
//
// GUEST_MODE è una variabile d'ambiente Netlify impostata SOLO sul sito
// ospite (mai su produzione): quando vale "true", ogni store Blobs
// scritto o letto da queste function usa un nome distinto con suffisso
// "-guest", così i dati generati nello spazio ospite non si mescolano MAI
// con quelli di produzione — nemmeno per errore, anche se i due siti
// finissero per condividere per sbaglio le stesse credenziali
// NETLIFY_BLOBS_SITE_ID/NETLIFY_BLOBS_TOKEN.
//
// Confronto case-insensitive tramite String(): un valore impostato a mano
// nel pannello Netlify potrebbe avere maiuscole diverse ("True"); se la
// variabile non esiste proprio, process.env.GUEST_MODE è undefined —
// String(undefined) === "undefined", quindi il confronto fallisce in modo
// sicuro verso "produzione" (comportamento di oggi, invariato).
function isGuestMode() {
  return String(process.env.GUEST_MODE).toLowerCase() === "true";
}

// Nome dello store effettivamente da usare per una risorsa logica (es.
// "purchases"): invariato in produzione, con suffisso "-guest" nello
// spazio ospite. Usare SEMPRE questa funzione al posto di scrivere il
// nome dello store come stringa letterale in getStore({ name: ... }) — è
// l'unico punto che decide la separazione, quindi l'unico punto da
// aggiornare se la convenzione di naming cambiasse in futuro.
function guestScopedStoreName(baseName) {
  return isGuestMode() ? `${baseName}-guest` : baseName;
}

module.exports = { isGuestMode, guestScopedStoreName };
