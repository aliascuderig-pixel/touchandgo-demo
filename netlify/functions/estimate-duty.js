// Netlify serverless function — stima APPROSSIMATIVA e SOLO INFORMATIVA di
// dazi/tasse di importazione nel paese di destinazione, per l'oggetto già
// classificato (hs_code/category/weight_kg/value_eur, da CLASSIFY_SCHEMA
// in dist/assets/app.js) e il paese già scelto in DestinationScreen —
// PRIMA della classificazione, non dopo, quindi sempre disponibile a
// questo punto (vedi runClassification()/currentDestinationName() in
// app.js).
//
// Stesso pattern di assistant.js, non quello di classify.js: qui il
// prompt è costruito INTERAMENTE lato server a partire da pochi campi
// dati (non un array di "messages" libero costruito dal client) — un
// prompt costruibile dal client sarebbe manipolabile.
//
// QUATTRO vincoli non negoziabili (decisione presa con Giuseppe, vedi
// MANUALE.md sezione dedicata):
// 1. Mai bloccante per il resto del flusso — questa function esiste
//    apposta separata da classify.js, chiamata in modo asincrono e MAI
//    atteso da runClassification() in app.js: un suo fallimento/timeout
//    non deve mai ritardare o interrompere classificazione/prezzo/QR.
// 2. Mai vincolante economicamente — il valore restituito da questa
//    function non deve MAI entrare in priceFor()/priceQuotes()/
//    bracketPrice()/shippingCost() in app.js: resta un dato isolato,
//    mostrato accanto, mai sommato a nulla (verificato con un test che fa
//    grep esplicito sull'assenza di questo collegamento).
// 3. Il disclaimer "stima indicativa, non vincolante" è nel PROMPT
//    (istruzione esplicita all'AI di includerlo sempre nella risposta),
//    non solo nell'interfaccia — così sopravvive anche a una futura
//    modifica della UI che perdesse il proprio disclaimer visivo.
// 4. Se l'AI non ha un contesto sufficientemente affidabile per quel
//    paese specifico, deve dirlo esplicitamente invece di inventare un
//    numero — istruito nel prompt, non lasciato all'iniziativa del
//    modello.
//
// Il quinto vincolo (mai tentare la stima se il paese non è ancora noto)
// è responsabilità del CHIAMANTE (app.js non chiama questo endpoint se
// currentDestinationName() è vuoto) — qui ci si limita a validare che
// "country" sia presente, per non fidarsi ciecamente del client.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}

async function checkRateLimit(key) {
  const store = getStore({
    name: guestScopedStoreName("rate-limits"),
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
  const now = Date.now();
  const record = (await store.get(key, { type: "json" })) || { count: 0, windowStart: now };
  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }
  record.count += 1;
  await store.setJSON(key, record);
  return record.count <= RATE_LIMIT_MAX;
}

// Frase esatta richiesta (vincolo 3) — usata sia nell'istruzione al
// modello sia nel test che verifica che il prompt costruito la contenga
// davvero, parola per parola.
const DUTY_ESTIMATE_DISCLAIMER = "Stima indicativa, non vincolante — verifica sempre con le autorità doganali del paese di destinazione prima di partire.";

// Parte FISSA del prompt (non dipende dai dati della singola richiesta,
// quindi testabile come stringa costante — stesso principio di
// QUESTION_MODE_FACTS/SUITE_MODE_FACTS in assistant.js).
const DUTY_ESTIMATE_SYSTEM_PROMPT = `Sei un assistente che stima in modo approssimativo i dazi/le tasse di importazione doganale per un acquisto turistico spedito dall'Italia verso un paese estero, nel contesto del servizio Touch&Go.

Ti vengono forniti: codice doganale HS (6 cifre), categoria merceologica, peso, valore dichiarato in euro, e il paese di destinazione.

Istruzioni:
- Dai una stima ragionevole (percentuale indicativa + importo approssimativo in euro) dei dazi/tasse di importazione applicabili in quel paese specifico per un oggetto di quel tipo/valore, basandoti sulla tua conoscenza generale delle aliquote doganali e delle eventuali soglie di franchigia (de minimis) di quel paese.
- Se non hai un contesto sufficientemente affidabile per stimare i dazi di QUEL paese specifico (es. paese poco comune, regole molto variabili o che non conosci con sufficiente confidenza), dillo chiaramente e non inventare comunque un numero — è preferibile dire che non hai una stima affidabile per quel paese piuttosto che restituire una cifra inventata.
- Rispondi in modo breve (poche frasi), diretto, senza premesse superflue.
- Includi SEMPRE, come ultima frase della tua risposta, ESATTAMENTE questo disclaimer, parola per parola — anche se rispondi in un'altra lingua, in tal caso traducilo fedelmente senza alterarne il significato: "${DUTY_ESTIMATE_DISCLAIMER}"
- Questa stima è puramente informativa per il turista: non fa parte in alcun modo del prezzo del servizio Touch&Go — non calcolare né menzionare alcun collegamento con la fee di spedizione o il costo del corriere.`;

// Parte variabile (dati della richiesta specifica) — mai un "system
// prompt" separato per request, sempre lo stesso messaggio "user" sopra
// descritto nelle istruzioni fisse: stesso schema di sicurezza già usato
// in assistant.js (il client manda solo dati, mai testo libero che
// diventi istruzione).
function buildDutyEstimateUserMessage({ hsCode, category, weightKg, valueEur, country, lang }) {
  const langHint = lang === "en" ? "Rispondi in inglese." : "Rispondi in italiano.";
  return `Oggetto da spedire dall'Italia:
- Codice HS: ${hsCode || "non disponibile"}
- Categoria: ${category || "non disponibile"}
- Peso: ${weightKg != null && weightKg !== "" ? weightKg + " kg" : "non disponibile"}
- Valore dichiarato: ${valueEur != null && valueEur !== "" ? "€" + valueEur : "non disponibile"}
- Paese di destinazione: ${country}

${langHint} Stima i dazi/le tasse di importazione per questo paese, seguendo le istruzioni.`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: { message: "Method not allowed" } }) };
  }
  try {
    const { hs_code: hsCode, category, weight_kg: weightKg, value_eur: valueEur, country, lang } = JSON.parse(event.body || "{}");
    const normalizedCountry = (country || "").trim();
    if (!normalizedCountry) {
      return { statusCode: 400, body: JSON.stringify({ error: { message: "Paese di destinazione mancante." } }) };
    }

    const withinLimit = await checkRateLimit(`estimate-duty:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: { message: "Troppe richieste, riprova tra qualche minuto." } }) };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: { message: "Chiave API non configurata sul server (variabile ANTHROPIC_API_KEY mancante)." } }),
      };
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 300,
        system: DUTY_ESTIMATE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildDutyEstimateUserMessage({ hsCode, category, weightKg, valueEur, country: normalizedCountry, lang }) }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.error || { message: "Errore AI" } }) };
    }
    const estimate = data.content && data.content[0] && data.content[0].text;
    if (!estimate) {
      return { statusCode: 502, body: JSON.stringify({ error: { message: "Risposta vuota dall'AI." } }) };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estimate: estimate.trim() }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: { message: err.message } }) };
  }
};

// Esportati solo per i test (stesso pattern già usato in assistant.js/
// daily-healthcheck.js di questo repository) — il runtime Netlify invoca
// solo exports.handler, il resto è inerte in produzione.
exports.DUTY_ESTIMATE_DISCLAIMER = DUTY_ESTIMATE_DISCLAIMER;
exports.DUTY_ESTIMATE_SYSTEM_PROMPT = DUTY_ESTIMATE_SYSTEM_PROMPT;
exports.buildDutyEstimateUserMessage = buildDutyEstimateUserMessage;
