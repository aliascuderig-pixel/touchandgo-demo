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
//
// Limite prezzo: 5000 (non più 500) — bug reale trovato dal vivo il 3
// settembre 2026 (vedi MANUALE.md, "Limite di prezzo per acquisto"): 500
// era troppo basso perché "price" include anche il costo di spedizione
// oltre alla fee di servizio, e per un oggetto pesante o una destinazione
// lontana lo supera facilmente in modo del tutto legittimo (caso reale:
// sedia a dondolo, 15kg, verso il Giappone, €1078,50 — rifiutata). A
// differenza di un errore transitorio, questo rifiuto è permanente: la
// coda di ritentativo lato client (vedi "Coda di ritentativo per la
// sincronizzazione col CRM") continua a riprovare per sempre senza mai
// riuscire, perché il motivo del rifiuto non cambia da solo. Nuovo limite
// allineato a quello già usato per il totale del gruppo consolidato in
// save-shipment-group.js (group.total > 5000) — un singolo acquisto non
// dovrebbe mai poter superare quello che il gruppo consentirebbe.
function isValidPurchase(item) {
  if (!item || typeof item !== "object") return false;
  if (typeof item.id !== "string" || !item.id.trim()) return false;
  if (typeof item.price !== "number" || !isFinite(item.price) || item.price < 0 || item.price > 5000) return false;
  const weight = typeof item.weightKg === "number" ? item.weightKg : item.weight_kg;
  if (typeof weight !== "number" || !isFinite(weight) || weight <= 0 || weight >= 50) return false;
  if (!VALID_PRICING_TIERS.includes(item.pricingTier)) return false;
  return true;
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

// ---------------------------------------------------------------------
// Regole anti-frode (settembre 2026) — vedi il blocco più esteso più sotto,
// dentro l'handler, per il principio "solo segnalazione, mai blocco" e per
// la spiegazione del formato flaggedReasons (array). Qui solo le soglie e
// le due funzioni riutilizzabili condivise da più regole.
// ---------------------------------------------------------------------

// Finestra usata dalla regola "Acquisti ravvicinati" (regola 2).
const CLOSE_PURCHASE_WINDOW_MS = 60 * 60 * 1000; // 1 ora

// Soglie condivise dalle due regole statistiche "valore anomalo" (3) e
// "peso anomalo" (6) — stessa funzione per entrambe: nessun motivo tecnico
// per differenziare soglia/campione minimo tra un valore in euro e un peso
// in kg, la variabilità tra oggetti affini della stessa categoria turistica
// è paragonabile per i due campi. 3x la media evita falsi positivi sulla
// normale variazione tra oggetti simili (es. "Elettronica" include sia
// auricolari che fotocamere) restando comunque sensibile a un valore/peso
// dichiarato palesemente fuori scala. Campione minimo di 5 evita di
// giudicare "anomalo" qualunque cosa quando la categoria ha ancora troppo
// pochi acquisti perché una media sia un riferimento significativo.
const CATEGORY_ANOMALY_MULTIPLIER = 3;
const CATEGORY_ANOMALY_MIN_SAMPLE = 5;

// Regole 3./6.: `currentValue` è anomalo se supera CATEGORY_ANOMALY_MULTIPLIER
// volte la media di `field` calcolata sugli ALTRI acquisti della stessa
// categoria (mai includendo l'acquisto corrente, che altrimenti
// sposterebbe la propria stessa media di riferimento) — nessun flag se il
// campione è sotto CATEGORY_ANOMALY_MIN_SAMPLE.
function isCategoryOutlier(categoryItems, field, currentValue) {
  if (typeof currentValue !== "number" || !isFinite(currentValue)) return false;
  const values = categoryItems.map((it) => it[field]).filter((v) => typeof v === "number" && isFinite(v));
  if (values.length < CATEGORY_ANOMALY_MIN_SAMPLE) return false;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return currentValue > avg * CATEGORY_ANOMALY_MULTIPLIER;
}

// Regole 4./7.: `value` del campo `field` (match esatto) è già usato da
// almeno un altro acquisto con un'email normalizzata diversa da `ownEmail`
// — un altro acquisto senza email propria non conta mai come "account
// diverso" (non c'è un'identità reale da confrontare).
function usedByDifferentEmail(otherItems, field, value, ownEmail) {
  return otherItems.some((it) => {
    const otherEmail = normalizeEmail(it.touristEmail);
    return it[field] === value && otherEmail && otherEmail !== ownEmail;
  });
}

// ---------------------------------------------------------------------
// Persistenza della stima dazi mostrata al turista (dutyEstimateShown,
// settembre 2026) — vedi MANUALE.md, "Stima dazi doganali". Fino a questa
// modifica state.dutyEstimate (dist/assets/app.js) era solo stato
// client, mai salvato sul record dell'acquisto — primo passo per poter
// eventualmente confrontarlo in futuro con un dazio reale riportato.
//
// Nessuna modifica obbligatoria qui per accettarlo: come già per
// country/city (vedi sotto, "Paese e città reali della spedizione") e per
// objectName/category/material/hsCode, isValidPurchase() sopra non valida
// questo campo — non lo ha mai validato, accetta già qualunque campo
// extra nel payload, e questo handler scrive l'intero oggetto item così
// com'è arrivato (setJSON(item.id, item) più sotto). Il client
// (ChooseAddressScreen/submitPartnerGeneratedShipment in app.js) manda
// sempre o il testo esatto della stima o null — mai un valore inventato
// qui, mai bloccante se assente.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Attribuzione partner persistente per touristEmail (settembre 2026) —
// vedi MANUALE.md, sezione "Attribuzione partner persistente per
// touristEmail". Un'agenzia/tour operator che genera la prima spedizione
// di un turista tramite il "gestionale" partner (generatedByPartnerCode,
// vedi PartnerGenerateShipmentScreen in app.js), o un turista che usa un
// codice partner esplicito (QR/link ?partner=, salvato come
// state.activePartnerCode -> item.partnerCode) NON deve perdere
// l'attribuzione se quel turista passa poi al percorso self-service senza
// alcun codice: l'ultimo codice usato esplicitamente resta "noto" per
// quel touristEmail e viene riapplicato in automatico.
//
// Store dedicato, keyed per email normalizzata (stesso schema di
// "blocklist" sopra) — non un campo sull'item stesso, perché deve essere
// consultabile PRIMA di sapere quale sarà il prossimo acquisto di quel
// cliente, e deve sopravvivere anche se quell'acquisto specifico viene
// eliminato/mai più risincronizzato.
//
// "Codice esplicito" per questa mappatura = item.partnerCode (QR/link o,
// in futuro, un inserimento manuale nell'app) OPPURE
// item.generatedByPartnerCode (gestionale partner) — le tre fonti elencate
// nella richiesta che ha originato questa feature. Un item generato dal
// gestionale aggiorna la mappatura ma NON riceve mai lui stesso
// item.partnerCode: quel campo resta riservato al meccanismo di
// commissione esistente (vedi sotto), e un'agenzia non deve mai maturare
// una commissione sulla spedizione che genera direttamente per il proprio
// cliente. L'auto-attribuzione (sotto) si applica invece SOLO a un item
// che non porta già uno dei due campi — mai a un item che ne porta già
// uno, per non sovrascrivere una scelta esplicita già fatta su quello
// stesso item.
async function resolvePartnerAttribution(item, email, attribution) {
  if (!email) return; // nessuna email nota per questo cliente: nessuna attribuzione possibile, comportamento invariato
  const explicitCode = item.partnerCode || item.generatedByPartnerCode || null;
  if (explicitCode) {
    await attribution.setJSON(email, {
      email,
      partnerCode: explicitCode,
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const known = await attribution.get(email, { type: "json" });
  if (known && known.partnerCode) {
    item.partnerCode = known.partnerCode;
  }
}

// Campi paese/città REALI (strutturati) — introdotti accanto al vecchio
// addressLabel testuale, vedi MANUALE.md, sezione "Paese e città reali
// della spedizione". Non validati da isValidPurchase() (mai bloccanti,
// stesso principio di recordCustomsReference sopra): un valore non
// stringa o fuori misura viene semplicemente scartato (impostato a null),
// non fa rifiutare l'intero acquisto — il turista non deve mai perdere una
// spedizione per un campo informativo.
const MAX_STRUCTURED_FIELD_LEN = 100;
function sanitizeStructuredDestination(item) {
  for (const key of ["country", "city"]) {
    const value = item[key];
    if (typeof value !== "string" || !value.trim() || value.length > MAX_STRUCTURED_FIELD_LEN) {
      item[key] = null;
    } else {
      item[key] = value.trim();
    }
  }
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
    sanitizeStructuredDestination(item);

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
    const partnerAttribution = getStore({ name: guestScopedStoreName("partner-attribution"), ...blobsAuth });

    const email = normalizeEmail(item.touristEmail);

    if (email) {
      // Blocco manuale (invariato) — la segnalazione anti-frode (incluso
      // il "secondo acquisto senza abbonamento" che viveva qui prima di
      // questa modifica) è più sotto, insieme alle altre regole: serve
      // l'intero elenco degli acquisti, che viene recuperato una sola
      // volta per tutte le regole insieme.
      const existingBlock = await blocklist.get(email, { type: "json" });
      if (existingBlock) {
        return { statusCode: 403, body: JSON.stringify({ error: BLOCKED_MESSAGE }) };
      }
    }

    // Attribuzione partner persistente per touristEmail — va applicata
    // PRIMA del blocco di accredito commissione sotto: se questo item non
    // porta un codice esplicito, resolvePartnerAttribution() può scrivere
    // item.partnerCode con l'ultimo codice noto per questo cliente, e da
    // quel momento il blocco sotto (invariato) lo tratta come qualunque
    // altro item con partnerCode esplicito.
    if (email) {
      await resolvePartnerAttribution(item, email, partnerAttribution);
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

    // ------------------------------------------------------------------
    // Regole anti-frode (settembre 2026) — SOLO segnalazione per revisione
    // manuale dello staff dal CRM, MAI un blocco automatico: stesso
    // principio già consolidato dopo l'incidente verificato dal vivo il 1°
    // settembre 2026 (vedi il commento storico rimasto sopra, sul blocco
    // manuale). Nessuna delle regole seguenti deve mai impedire un
    // acquisto di procedere, indipendentemente da quante se ne attivino.
    //
    // Prima di questa modifica esisteva una sola regola ("Secondo acquisto
    // senza abbonamento"), scritta su un campo a valore singolo
    // (flaggedReason). Un acquisto può ora attivarne più di una insieme,
    // quindi il campo diventa un elenco (flaggedReasons) — ogni regola che
    // si attiva aggiunge la propria stringa, indipendentemente dalle
    // altre; flaggedAt resta un singolo timestamp dell'ultimo ricalcolo.
    //
    // Come già per la regola originale, ricalcolate INTERAMENTE ad ogni
    // salvataggio (mai lette/preservate dal record precedente né dal
    // payload del client): un acquisto che smette di corrispondere a un
    // pattern semplicemente non viene più segnalato ai salvataggi
    // successivi, senza bisogno di logica di merge.
    //
    // Formato e retrocompatibilità: un record VECCHIO già in store con il
    // campo singolo flaggedReason non viene mai toccato da questa modifica
    // finché non viene risincronizzato — resta leggibile esattamente
    // com'era. Se invece viene risincronizzato, viene ricalcolato nel
    // nuovo formato array (stesso comportamento "nessun merge" già in uso
    // per questo campo). Il CRM (repository separato touchandgo-internal,
    // non modificato da qui) legge oggi flaggedReason come valore singolo:
    // va aggiornato per mostrare l'elenco flaggedReasons — vedi
    // MANUALE.md, sezione "Segnalazioni anti-frode".
    item.purchasedAt = (alreadySaved && alreadySaved.purchasedAt) || new Date().toISOString();

    const { blobs: allPurchaseBlobs } = await purchases.list();
    const allItems = (await Promise.all(allPurchaseBlobs.map((b) => purchases.get(b.key, { type: "json" })))).filter(Boolean);
    // Esclude il record dell'item stesso: una risincronizzazione (es.
    // cambio di stato) non deve mai confrontare l'acquisto con se stesso.
    const otherItems = allItems.filter((it) => it.id !== item.id);
    const emailItems = email ? otherItems.filter((it) => normalizeEmail(it.touristEmail) === email) : [];

    const reasons = [];

    // 1. [ESISTENTE, logica invariata] Secondo acquisto senza abbonamento.
    if (email && emailItems.length > 0 && item.pricingTier !== "abbonato") {
      const everSubscribed = emailItems.some((it) => it.pricingTier === "abbonato");
      if (!everSubscribed) reasons.push("Secondo acquisto senza abbonamento");
    }

    // 2. Acquisti ravvicinati: un altro acquisto della stessa email con
    // purchasedAt entro un'ora (finestra simmetrica: prima o dopo).
    if (email) {
      const currentTime = new Date(item.purchasedAt).getTime();
      const hasCloseOne = emailItems.some(
        (it) => it.purchasedAt && Math.abs(new Date(it.purchasedAt).getTime() - currentTime) <= CLOSE_PURCHASE_WINDOW_MS
      );
      if (hasCloseOne) reasons.push("Più acquisti in meno di un'ora");
    }

    // 3./6. Valore/peso dichiarato anomalo per la categoria.
    const categoryItems = item.category ? otherItems.filter((it) => it.category === item.category) : [];
    if (isCategoryOutlier(categoryItems, "itemValue", item.itemValue)) {
      reasons.push("Valore dichiarato anomalo per la categoria");
    }
    if (isCategoryOutlier(categoryItems, "weightKg", item.weightKg)) {
      reasons.push("Peso dichiarato anomalo per la categoria");
    }

    // 4./7. Stesso indirizzo/nome (match esatto) usato da un'email diversa.
    if (email && item.addressLabel && usedByDifferentEmail(otherItems, "addressLabel", item.addressLabel, email)) {
      reasons.push("Stesso indirizzo usato da più account");
    }
    if (email && item.touristName && usedByDifferentEmail(otherItems, "touristName", item.touristName, email)) {
      reasons.push("Stesso nome usato da più account");
    }

    // 5. Uso ripetuto di "breakeven" — pensato come eccezione una tantum
    // (invito monouso o prima spedizione gratuita, vedi MANUALE.md, "Offerte
    // e sconti"), non un livello di prezzo permanente per lo stesso cliente.
    if (email && item.pricingTier === "breakeven" && emailItems.some((it) => it.pricingTier === "breakeven")) {
      reasons.push("Uso ripetuto di prezzo breakeven");
    }

    if (reasons.length > 0) {
      item.flaggedReasons = reasons;
      item.flaggedAt = new Date().toISOString();
    }

    await purchases.setJSON(item.id, item);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
