// Netlify serverless function — centrally records every purchase/QR event
// into Netlify Blobs, so the CRM page can see data from every tourist's
// device, not just what's stored locally on each phone.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti
const COMMISSION_RATE = 0.1; // stessa aliquota usata come commissione/credito partner (crm.js, partner-stats.js)

// Numero massimo di esempi recenti tenuti per ogni voce dell'archivio
// doganale (store "customs-reference", sotto) — evita che un bucket
// categoria+materiale molto comune (es. "Accessori Moda / pelle") cresca
// senza limite: bastano pochi esempi reali recenti come riferimento.
const CUSTOMS_REFERENCE_MAX_EXAMPLES = 5;

// Chiave dell'archivio doganale: categoria+materiale normalizzati, non il
// codice HS (che è l'output che vogliamo aiutare a prevedere, non un
// input disponibile prima della classificazione) e non l'oggetto singolo
// (troppo specifico per essere un riferimento utile ad altri oggetti).
// Categoria+materiale è il punto di equilibrio: abbastanza ampio da
// accumulare più esempi nello stesso bucket, abbastanza specifico perché
// quegli esempi siano davvero pertinenti tra loro (es. "borsa in pelle" e
// "portafoglio in pelle" finiscono nello stesso bucket "Accessori Moda /
// pelle", con codici HS tipicamente vicini).
function customsReferenceKey(category, material) {
  return `${String(category).trim().toLowerCase()}::${String(material).trim().toLowerCase()}`;
}

// Registra/aggiorna una voce dell'archivio doganale con i dati REALI di
// una classificazione andata a buon fine — mai un valore stimato o
// inventato: se uno dei tre campi manca, semplicemente non si scrive
// nulla. Chiamata solo al primo salvataggio di un acquisto (non ad ogni
// risincronizzazione di stato), altrimenti lo stesso acquisto
// gonfierebbe il conteggio a ogni "in sospeso" -> "in confezionamento" ->
// "ritiro richiesto" -> "ritirato". Best-effort: un errore qui non deve
// mai far fallire il salvataggio vero e proprio dell'acquisto.
async function recordCustomsReference(item, blobsAuth) {
  if (!item.category || !item.hsCode || item.hsCode === "—" || !item.material) return;
  try {
    const store = getStore({ name: guestScopedStoreName("customs-reference"), ...blobsAuth });
    const key = customsReferenceKey(item.category, item.material);
    const existing = (await store.get(key, { type: "json" })) || {
      category: item.category,
      material: item.material,
      count: 0,
      hsCodeCounts: {},
      recentExamples: [],
    };
    existing.count += 1;
    existing.hsCodeCounts[item.hsCode] = (existing.hsCodeCounts[item.hsCode] || 0) + 1;
    existing.mostCommonHsCode = Object.keys(existing.hsCodeCounts).reduce((best, code) =>
      existing.hsCodeCounts[code] > (existing.hsCodeCounts[best] || 0) ? code : best
    , item.hsCode);
    existing.recentExamples.unshift({
      objectName: item.objectName || null,
      hsCode: item.hsCode,
      weightKg: typeof item.weightKg === "number" ? item.weightKg : null,
      recordedAt: new Date().toISOString(),
    });
    existing.recentExamples = existing.recentExamples.slice(0, CUSTOMS_REFERENCE_MAX_EXAMPLES);
    existing.updatedAt = new Date().toISOString();
    await store.setJSON(key, existing);
  } catch (e) {
    // Archivio di riferimento: mai bloccante. L'acquisto è già stato (o
    // sta per essere) salvato correttamente indipendentemente da questo.
  }
}

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

const VALID_PRICING_TIERS = ["pieno", "abbonato", "breakeven"];
const BLOCKED_MESSAGE = "Non è possibile completare la richiesta. Contatta l'assistenza.";

// Rifiuta record palesemente inventati prima che finiscano nelle statistiche
// del CRM: id presente, prezzo e peso in un range plausibile, tier di
// prezzo tra i tre effettivamente usati dall'app.
function isValidPurchase(item) {
  if (!item || typeof item !== "object") return false;
  if (typeof item.id !== "string" || !item.id.trim()) return false;
  if (typeof item.price !== "number" || !isFinite(item.price) || item.price < 0 || item.price > 500) return false;
  const weight = typeof item.weightKg === "number" ? item.weightKg : item.weight_kg;
  if (typeof weight !== "number" || !isFinite(weight) || weight <= 0 || weight >= 50) return false;
  if (!VALID_PRICING_TIERS.includes(item.pricingTier)) return false;
  return true;
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const item = JSON.parse(event.body || "{}");
    if (!isValidPurchase(item)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Dati spedizione non validi" }) };
    }

    const withinLimit = await checkRateLimit(`save-purchase:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const blobsAuth = {
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    };
    const purchases = getStore({ name: guestScopedStoreName("purchases"), ...blobsAuth });
    const blocklist = getStore({ name: guestScopedStoreName("blocklist"), ...blobsAuth });

    const email = normalizeEmail(item.touristEmail);

    if (email) {
      const existingBlock = await blocklist.get(email, { type: "json" });
      if (existingBlock) {
        return { statusCode: 403, body: JSON.stringify({ error: BLOCKED_MESSAGE }) };
      }

      // Segnalazione (non più blocco automatico — verificato dal vivo il
      // 1° settembre 2026: bloccava permanentemente anche clienti con due
      // acquisti del tutto legittimi). Un cliente che ha già almeno un
      // acquisto registrato e non è mai stato abbonato, se effettua un
      // acquisto aggiuntivo non-abbonato, NON viene più bloccato — procede
      // come un acquisto qualunque. Viene solo flaggato sul record stesso
      // (flaggedReason/flaggedAt), per revisione manuale dello staff dal
      // CRM — mai una scrittura automatica in blocklist: quello store resta
      // riservato al solo blocco manuale ("Blocca cliente" dal CRM).
      const { blobs } = await purchases.list();
      const priorItems = (await Promise.all(blobs.map((b) => purchases.get(b.key, { type: "json" })))).filter(Boolean);
      // Esclude il record dell'item stesso: un acquisto già salvato che
      // viene semplicemente ri-sincronizzato (es. cambio status "in
      // sospeso" -> "in confezionamento" -> "ritiro richiesto" ->
      // "ritirato") non è un "secondo acquisto" e non deve flaggare il
      // primo acquisto legittimo del cliente.
      const emailItems = priorItems.filter((it) => normalizeEmail(it.touristEmail) === email && it.id !== item.id);

      // Ricalcolato ad ogni salvataggio (non letto/preservato dal record
      // precedente né dal payload in arrivo, che non lo contiene mai): resta
      // sempre coerente con lo stato reale degli acquisti del cliente in
      // questo istante, senza bisogno di logica di merge aggiuntiva.
      if (emailItems.length > 0 && item.pricingTier !== "abbonato") {
        const everSubscribed = emailItems.some((it) => it.pricingTier === "abbonato");
        if (!everSubscribed) {
          item.flaggedReason = "Secondo acquisto senza abbonamento";
          item.flaggedAt = new Date().toISOString();
        }
      }
    }

    // Accredito partner al passaggio a "ritirato" — sincronizzato dal
    // turista stesso (es. ConcludeScreen) tramite un resync completo
    // dell'item, non tramite l'azione "update-status" del CRM. La copia
    // già in store (non il payload in arrivo) è l'unica fonte affidabile
    // per il flag creditIssued: un client che risincronizza più volte lo
    // stesso item non deve poter far accreditare due volte il partner.
    if (item.status === "ritirato" && item.partnerCode) {
      const previousItem = await purchases.get(item.id, { type: "json" });
      if (previousItem && previousItem.creditIssued) {
        // Già accreditato: questo salvataggio sovrascrive l'intero record
        // (non è un merge), quindi riporta qui i campi già presenti in
        // store — altrimenti un resync da un client con copia locale
        // "vecchia" li cancellerebbe, riaprendo la porta a un doppio
        // accredito al prossimo resync.
        item.creditIssued = true;
        item.creditIssuedAmount = previousItem.creditIssuedAmount;
        item.creditIssuedAt = previousItem.creditIssuedAt;
      } else {
        // Il partner va recuperato PRIMA di calcolare la commissione: il
        // piano gratuito non genera commissione (coerente col sito —
        // "Gratuito — nessuna commissione"), quindi l'aliquota del 10% si
        // applica solo se il partner esiste ed è su un piano a pagamento.
        // Un partner senza campo "plan" (record storico, creato prima
        // della distinzione piani) è trattato come a pagamento —
        // comportamento invariato per quei record. Un partnerCode che non
        // corrisponde a nessun partner reale non genera commissione: non
        // c'è nessuno a cui accreditarla.
        const partners = getStore({ name: guestScopedStoreName("partners"), ...blobsAuth });
        const partner = await partners.get(item.partnerCode, { type: "json" });
        const commission =
          partner && partner.plan !== "free" ? Math.round((item.price || 0) * COMMISSION_RATE * 100) / 100 : 0;
        item.creditIssued = true;
        item.creditIssuedAmount = commission;
        item.creditIssuedAt = new Date().toISOString();
        if (commission > 0 && partner) {
          partner.creditBalance = Math.round(((partner.creditBalance || 0) + commission) * 100) / 100;
          partner.updatedAt = new Date().toISOString();
          await partners.setJSON(item.partnerCode, partner);
        }
      }
    }

    // Solo al primo salvataggio di questo id: le risincronizzazioni di
    // stato successive (in sospeso -> in confezionamento -> ...) portano
    // sempre la stessa classificazione, quindi non devono contare di
    // nuovo nell'archivio doganale. Lettura indipendente da quella usata
    // sopra per il credito partner (quella è scoped al solo caso
    // "ritirato" + partnerCode) per non toccarne la logica.
    const alreadySaved = await purchases.get(item.id, { type: "json" });
    if (!alreadySaved) {
      await recordCustomsReference(item, blobsAuth);
    }

    // Conferma di consegna del turista (deliveryConfirmedAt): come per
    // creditIssued sopra, questo salvataggio sovrascrive l'intero record.
    // Se il client che sta sincronizzando ora non porta il campo (es. un
    // altro dispositivo, o un resync innescato da un'azione diversa) ma lo
    // store ce l'ha già, va preservato — altrimenti una conferma già data
    // sparirebbe al prossimo salvataggio da quel dispositivo.
    if (!item.deliveryConfirmedAt && alreadySaved && alreadySaved.deliveryConfirmedAt) {
      item.deliveryConfirmedAt = alreadySaved.deliveryConfirmedAt;
    }

    await purchases.setJSON(item.id, item);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
