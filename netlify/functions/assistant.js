// Netlify serverless function — assistente conversazionale Touch&Go
// ("Fase 1": disponibile a TUTTI i turisti, non vincolato a nessun piano —
// il pitch deck promette già un "assistente in 4 lingue" come parte del
// piano "Touch&Go Black", che però non esiste ancora come piano reale
// nell'app; questa function costruisce il servizio vero, per chiunque).
//
// Stesso pattern di classify.js: stessa ANTHROPIC_API_KEY, stesso schema
// di rate limiting. A differenza di classify.js (che inoltra i messaggi
// così come li costruisce il client), qui il system prompt con i fatti
// reali del servizio è costruito INTERAMENTE lato server — il client
// manda solo mode/message/lang, mai il prompt: un system prompt che
// arrivasse dal client sarebbe manipolabile.
//
// I fatti sotto sono presi da dist/assets/app.js (FULL_FEE, SUBSCRIBED_FEE,
// SHIPPING_RATES, SHIPPING_MARGIN, stati di un acquisto) — se quei valori
// cambiano, aggiornare anche qui.
const { getStore } = require("@netlify/blobs");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}

async function checkRateLimit(key) {
  const store = getStore({
    name: "rate-limits",
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

// Specchio di FULL_FEE/SUBSCRIBED_FEE in dist/assets/app.js.
const FULL_FEE = 39;
const SUBSCRIBED_FEE = 19;

// Specchio di SHIPPING_RATES in dist/assets/app.js — prezzi già
// comprensivi del margine Touch&Go del 25% (SHIPPING_MARGIN), come
// mostrato al turista in ogni preventivo. Qui espressi come range
// arrotondati per una risposta discorsiva, non come tabella a fasce.
const QUESTION_MODE_FACTS = `Sei l'assistente virtuale di Touch&Go, un servizio che permette a un turista in Italia di fotografare un acquisto in negozio, farlo classificare da un'AI (dogana, peso, dimensioni), lasciarlo in negozio con un QR e riceverlo spedito a casa — con esenzione IVA export gestita in automatico.

FATTI REALI DEL SERVIZIO — usa SOLO questi numeri, non inventarne altri:
- Fee di servizio Touch&Go: €${FULL_FEE} a tariffa piena, €${SUBSCRIBED_FEE} con abbonamento, per ogni spedizione — separata dal costo del corriere.
- Costo del corriere (già comprensivo del margine Touch&Go del 25%, nessun costo nascosto aggiuntivo), a fasce di peso/volume, tre zone:
  · Italia (spedizione domestica): da €11,25 (fino a 1kg) a €41,25 (fino a 30kg), +€1,38/kg oltre; consegna in 24–48 ore.
  · Unione Europea, Regno Unito, Svizzera (transfrontaliero): da €18,75 a €68,75, +€2,75/kg oltre; consegna in 2–4 giorni lavorativi.
  · Resto del mondo (worldwide): da €62,50 a €206,25, +€6,88/kg oltre; consegna in 4–8 giorni lavorativi.
- Esenzione IVA export: gestita automaticamente (Art. 8 DPR 633/72) — documentazione doganale generata senza pratiche aggiuntive in aeroporto.
- La primissima spedizione di un nuovo cliente è SEMPRE senza fee di servizio (paga solo il corriere, a tariffa piena) — un modo per provare il servizio prima di scegliere se abbonarsi. Codici invito o codici sconto partner, se il turista ne ha uno, possono azzerare o ridurre ulteriormente la fee.
- Stati di un acquisto, in ordine: "in sospeso" (lasciato in negozio, in attesa che qualcuno lo imballi) → "in confezionamento" (in preparazione) → "ritiro richiesto" (il turista ha chiesto il ritiro) → "ritirato" (il corriere è passato, la spedizione è avviata).
- Durante il soggiorno si possono lasciare più oggetti in negozi diversi: alla fine, tutti gli acquisti "in sospeso" verso la stessa destinazione vengono consolidati in un unico ordine di ritiro, invece di tante spedizioni separate.
- Non esiste ancora un piano "Touch&Go Black" o abbonamenti a più livelli nell'app reale (solo tariffa piena/abbonamento base come sopra) — se ti viene chiesto, di' semplicemente che oggi il servizio ha questi due livelli.
- Non sei un consulente fiscale o legale: per casi doganali molto specifici (soglie insolite, paesi con regole particolari) consiglia di verificare col supporto Touch&Go o un professionista, senza inventare una risposta.

Rispondi in modo semplice, diretto e breve (poche frasi, salvo quando servono i numeri sopra) — non serve un tono formale. Rispondi SEMPRE nella stessa lingua in cui è scritta la domanda del turista, indipendentemente dalla lingua di questo prompt.`;

const TRANSLATE_MODE_PROMPT = `Sei un traduttore per turisti che fanno acquisti in negozi italiani, nel contesto del servizio Touch&Go (che spedisce a casa loro ciò che comprano).

Regole:
- Se il messaggio dell'utente è già scritto in italiano, traducilo nella lingua del turista (indicazione di lingua preferita fornita più sotto, ma se il testo stesso contiene indizi più forti su quale lingua serva davvero, segui quelli) — è il negoziante che sta comunicando col turista.
- Se il messaggio è scritto in qualunque altra lingua, traducilo in italiano semplice e chiaro, pensato per essere letto o mostrato a un negoziante italiano che non parla altre lingue — è il turista che vuole comunicare col negoziante.
- Restituisci SOLO la traduzione, breve e naturale, senza spiegazioni, virgolette o premesse tipo "Ecco la traduzione:".`;

function buildSystemPrompt(mode, lang) {
  if (mode === "traduci_per_negoziante") {
    const langHint = lang === "en" ? "inglese" : lang === "it" ? "italiano" : lang || "quella più plausibile dal contesto";
    return `${TRANSLATE_MODE_PROMPT}\n\nLingua preferita del turista (usala quando devi tradurre DA italiano VERSO il turista): ${langHint}.`;
  }
  return QUESTION_MODE_FACTS;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: { message: "Method not allowed" } }) };
  }
  try {
    const { message, mode, lang } = JSON.parse(event.body || "{}");
    const trimmed = (message || "").trim();
    if (!trimmed) {
      return { statusCode: 400, body: JSON.stringify({ error: { message: "Messaggio mancante." } }) };
    }
    const normalizedMode = mode === "traduci_per_negoziante" ? "traduci_per_negoziante" : "domanda";

    const withinLimit = await checkRateLimit(`assistant:${getClientIp(event)}`);
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
        max_tokens: 500,
        system: buildSystemPrompt(normalizedMode, lang),
        messages: [{ role: "user", content: trimmed }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.error || { message: "Errore AI" } }) };
    }
    const reply = data.content && data.content[0] && data.content[0].text;
    if (!reply) {
      return { statusCode: 502, body: JSON.stringify({ error: { message: "Risposta vuota dall'AI." } }) };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: reply.trim() }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: { message: err.message } }) };
  }
};
