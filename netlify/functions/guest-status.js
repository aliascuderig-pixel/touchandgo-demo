// Netlify serverless function — espone al client (dist/assets/app.js) se
// questo deploy sta girando in "modalità ospite" (spazio di continuità
// operativa, vedi MANUALE.md). GUEST_MODE è una variabile d'ambiente
// Netlify: il client statico servito da dist/ non ha alcun modo di
// leggerla direttamente (nessun passaggio di build che la inietti — questo
// repository non ha build step), quindi serve un endpoint minimo che la
// legga lato server e la restituisca come booleano.
//
// Nessun dato sensibile qui dentro (solo true/false), nessuna scrittura su
// Blobs: niente rate limiting, coerente con le altre chiamate GET-like a
// bassissimo costo di questo repository.
const { isGuestMode } = require("../lib/guest-mode");

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guestMode: isGuestMode() }),
  };
};
