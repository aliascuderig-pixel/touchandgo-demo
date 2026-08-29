// Netlify Function — endpoint di salute leggero per il sito principale.
// Unico consumatore: il router di continuità (repository stesso,
// sottocartella /router, deployato come sito Netlify separato — vedi
// MANUALE.md, "Router di continuità") lo interroga per decidere se
// reindirizzare automaticamente verso lo spazio ospite.
//
// Verifica RAPIDAMENTE e A COSTO MINIMO se la classificazione
// (classify.js) funzionerebbe: chiave presente, poi una chiamata
// all'endpoint Models dell'API Anthropic (GET /v1/models/{id}) — stessa
// autenticazione e stessa rete di una vera classificazione, ma senza
// generare nulla: nessun token di input/output, nessun costo. Non è una
// vera classificazione di immagine apposta: quella avrebbe un costo reale
// a ogni controllo del router.
const ANTHROPIC_MODEL = "claude-sonnet-5"; // stesso modello usato da classify.js
const TIMEOUT_MS = 4000;

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

exports.handler = async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return respond(503, { ok: false, reason: "missing_api_key" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.anthropic.com/v1/models/${ANTHROPIC_MODEL}`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
    });
    if (res.status === 200) {
      return respond(200, { ok: true });
    }
    if (res.status === 401 || res.status === 403) {
      return respond(503, { ok: false, reason: "anthropic_auth_failed", httpStatus: res.status });
    }
    return respond(503, { ok: false, reason: "anthropic_bad_status", httpStatus: res.status });
  } catch (err) {
    const reason = err.name === "AbortError" ? "anthropic_timeout" : "anthropic_unreachable";
    return respond(503, { ok: false, reason });
  } finally {
    clearTimeout(timeout);
  }
};
