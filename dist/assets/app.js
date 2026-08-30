// Touch&Go — demo app (rebuilt: clean structure, same functionality)

const STATS = [
  { val: "57,4M", lbl: "Turisti/anno in Italia", sub: "fonte UNIMPRESE / ENIT" },
  { val: "20–25%", lbl: "Acquisti non avvenuti per problemi valigia", sub: "stima di mercato" },
  { val: "€1,27B", lbl: "Opportunità vendite mancate/anno", sub: "Italia" },
  { val: "2,8M", lbl: "Turisti cinesi/anno in Europa", sub: "spesa media 3× superiore" },
];

const STEPS = [
  "Fotografa l'oggetto con la camera dello smartphone",
  "AI identifica il codice doganale HS in 3 secondi",
  "Touch&Go orchestra il corriere internazionale più adatto",
  "Pagamento via Stripe · Apple Pay · Alipay+ · WeChat Pay",
  "QR univoco generato istantaneamente — valido 48h, monouso",
  "Il corriere ritira direttamente in negozio",
  "Tracking live fino alla consegna a casa",
];

// "material" (TOU-*, archivio di riferimento doganale) — aggiunto per
// popolare netlify/functions/save-purchase.js -> store Blobs
// "customs-reference" con dati reali (materiale costruttivo dichiarato/
// rilevato dall'AI), non prima disponibile: senza questo campo l'archivio
// non avrebbe potuto registrare il materiale come richiesto, e inventarlo
// altrove (es. da una regex sul nome oggetto) sarebbe stata l'euristica
// fragile che si voleva evitare. Testo libero breve, stesso stile di
// hs_description_it — non un enum, i materiali variano troppo per
// categoria per un elenco fisso utile.
const CLASSIFY_SCHEMA = `{"object_it":"...","object_en":"...","hs_code":"6 cifre","hs_description_it":"...","hs_description_en":"...","category":"Ceramica|Abbigliamento|Alimentari|Vino & Spirits|Accessori Moda|Arte & Antiquariato|Gioielleria|Artigianato|Altro","material":"materiale costruttivo principale, breve (es. pelle, cotone, ceramica, vetro, legno, metallo, misto)","weight_kg":1.0,"length_cm":0,"width_cm":0,"height_cm":0,"value_eur":0,"fragile":false,"made_in_italy":true,"confidence":"alta|media|bassa","shipping_note_it":"...","shipping_note_en":"..."}`;

// L'imballo non è un margine fisso: più l'oggetto è grande, più materiale
// serve in termini assoluti (stessa percentuale); se è fragile, il
// materiale protettivo (bolle d'aria, angolari, doppia parete) quasi
// raddoppia il margine necessario per lato.
const PACKAGING_BASE_RATE = 0.08; // 8% della dimensione, margine strutturale di base
const PACKAGING_MIN_CM = 2; // margine minimo anche per oggetti minuscoli
const PACKAGING_FRAGILE_MULTIPLIER = 1.8; // materiale protettivo extra se fragile

function packagingPadding(dimCm, fragile) {
  const dim = parseFloat(dimCm) || 0;
  const base = Math.max(PACKAGING_MIN_CM, dim * PACKAGING_BASE_RATE);
  return base * (fragile ? PACKAGING_FRAGILE_MULTIPLIER : 1);
}

function packagedDimensions(r) {
  if (!r || !r.length_cm || !r.width_cm || !r.height_cm) return null;
  const fragile = !!r.fragile;
  const pad = (n) => {
    const dim = parseFloat(n) || 0;
    return Math.round((dim + packagingPadding(dim, fragile)) * 10) / 10;
  };
  return { l: pad(r.length_cm), w: pad(r.width_cm), h: pad(r.height_cm) };
}

function formatDims(l, w, h) {
  return `${l} × ${w} × ${h} cm`;
}

const FULL_FEE = 39;
const SUBSCRIBED_FEE = 19;

const DESTINATIONS = [
  { name: "Italia", name_en: "Italy", zone: "domestico" },
  { name: "Unione Europea", name_en: "European Union", zone: "transfrontaliero" },
  { name: "Regno Unito", name_en: "United Kingdom", zone: "transfrontaliero" },
  { name: "Svizzera", name_en: "Switzerland", zone: "transfrontaliero" },
  { name: "Stati Uniti", name_en: "United States", zone: "worldwide" },
  { name: "Emirati Arabi Uniti", name_en: "United Arab Emirates", zone: "worldwide" },
  { name: "Cina", name_en: "China", zone: "worldwide" },
  { name: "Giappone", name_en: "Japan", zone: "worldwide" },
  { name: "Altro / non specificata", name_en: "Other / not specified", zone: "worldwide" },
];

// Tariffe a fasce di peso per zona — costo GREZZO del corriere, prima del
// margine Touch&Go (vedi SHIPPING_MARGIN sotto). Valori aggiornati da
// ricerca reale sui corrieri aggregati da Packlink (BRT/Poste per il
// domestico, TNT/Poste Crono Internazionale per l'EU, screenshot reale
// Packlink per il worldwide: 0,5kg Italia→USA = €49-55).
// brackets: [peso_max_kg, prezzo]. Oltre l'ultima fascia si applica
// perKgOver per ogni kg eccedente i 30kg.
const SHIPPING_RATES = {
  domestico: { brackets: [[1, 9], [2, 11], [5, 14], [10, 18], [20, 25], [30, 33]], perKgOver: 1.1, eta: "24–48 ore" },
  transfrontaliero: { brackets: [[1, 15], [2, 20], [5, 26], [10, 34], [20, 44], [30, 55]], perKgOver: 2.2, eta: "2–4 giorni lavorativi" },
  worldwide: { brackets: [[1, 50], [2, 58], [5, 75], [10, 95], [20, 130], [30, 165]], perKgOver: 5.5, eta: "4–8 giorni lavorativi" },
};

// Margine Touch&Go applicato sopra il costo grezzo del corriere. Applicato
// una sola volta, dentro shippingCost() — ogni preventivo, riepilogo e
// salvataggio a save-purchase.js legge sempre e solo il valore già
// comprensivo di margine, mai il grezzo.
const SHIPPING_MARGIN = 0.25;

// I corrieri espresso reali fatturano sul maggiore tra peso reale e peso
// volumetrico (L×W×H in cm / 5000) — un pacco grande ma leggero occupa
// comunque spazio nel mezzo di trasporto.
function volumetricWeight(dims) {
  if (!dims) return 0;
  const l = parseFloat(dims.length_cm) || 0;
  const w = parseFloat(dims.width_cm) || 0;
  const h = parseFloat(dims.height_cm) || 0;
  if (!l || !w || !h) return 0;
  return (l * w * h) / 5000;
}

function bracketPrice(zone, weightKg) {
  for (const [maxKg, price] of zone.brackets) {
    if (weightKg <= maxKg) return price;
  }
  const [lastMaxKg, lastPrice] = zone.brackets[zone.brackets.length - 1];
  return lastPrice + (weightKg - lastMaxKg) * zone.perKgOver;
}

function shippingCost(weightKg, destinationName, dims) {
  const realWeight = Math.max(0.3, parseFloat(weightKg) || 1);
  const billableWeight = Math.max(realWeight, volumetricWeight(dims));
  const dest = DESTINATIONS.find((d) => d.name === destinationName) || DESTINATIONS[DESTINATIONS.length - 1];
  const zone = SHIPPING_RATES[dest.zone];
  const rawCost = bracketPrice(zone, billableWeight);
  return {
    shipping: parseFloat((rawCost * (1 + SHIPPING_MARGIN)).toFixed(2)),
    eta: zone.eta,
  };
}

// Restituisce le due quotazioni sempre confrontate esplicitamente: prezzo
// pieno e prezzo con abbonamento — mostrate fin dalla primissima spedizione,
// per ogni cliente, senza eccezioni.
function priceQuotes(weightKg, destinationName, dims) {
  const { shipping, eta } = shippingCost(weightKg, destinationName, dims);
  const round = (n) => parseFloat(n.toFixed(2));
  return {
    shipping,
    eta,
    full: round(shipping + FULL_FEE),
    subscribed: round(shipping + SUBSCRIBED_FEE),
    breakeven: round(shipping),
  };
}

// Prezzo effettivo da applicare dato lo stato del cliente (usato per
// compatibilità con il resto del codice che si aspetta un unico totale).
// Se è attivo un codice invito valido e non ancora usato, la fee di
// servizio Touch&Go viene azzerata per questa sola spedizione: il turista
// paga solo il servizio di spedizione (che include comunque il margine
// SHIPPING_MARGIN — non è più a costo vivo per Touch&Go, solo la fee è
// azzerata).
function priceFor(weightKg, destinationName, dims) {
  const q = priceQuotes(weightKg, destinationName, dims);
  const onBreakeven = state.promoValid && !state.promoRedeemedThisOrder;
  const grandTotal = onBreakeven ? q.breakeven : state.isSubscribed ? q.subscribed : q.full;
  return { grandTotal, eta: q.eta, quotes: q };
}

// Paese di destinazione di un item già in coda: risolto dall'indirizzo
// salvato (state.addresses, tramite l'addressId già presente su ogni item
// da sempre), non da un nuovo campo — così funziona anche per gli item già
// in localStorage prima di questa modifica. Fallback all'indirizzo/paese
// correntemente selezionato solo nel caso limite in cui quell'indirizzo
// non esista più (non c'è oggi alcuna funzione per cancellare un
// indirizzo, quindi in pratica capita solo con dati di test manomessi).
function destinationCountryForItem(it) {
  const addr = state.addresses.find((a) => a.id === it.addressId);
  return addr ? addr.country : currentDestinationName();
}

// Ricalcolo del prezzo per un INTERO gruppo di oggetti consolidati verso la
// stessa destinazione (stessa addressLabel) — usato solo in ConcludeScreen,
// al momento della conferma/pagamento finale. Vedi MANUALE.md, sezione
// "Prezzo consolidato per gruppo di spedizione".
//
// Non è la somma dei prezzi individuali già mostrati durante lo shopping
// (quelli restano solo stime per spedizione singola, calcolate da
// priceFor/priceQuotes/shippingCost — INVARIATE, mai richiamate da qui):
// qui si ricalcola da zero il costo di spedizione UNA SOLA VOLTA sul
// peso/volume dell'intero gruppo, con UNA SOLA fee di servizio — esattamente
// come farebbe un vero corriere con un unico collo consolidato, invece di
// sommare più preventivi (ognuno con la propria fee) già calcolati sui
// singoli oggetti.
//
// Un gruppo con un solo oggetto deve produrre esattamente lo stesso prezzo
// di priceFor(item.weightKg, ...).grandTotal per quell'oggetto — vedi il
// commento riga per riga sotto: stessa soglia minima di 0.3kg, stesso peso
// volumetrico, stessa fascia tariffaria, stessa fee, stesso eventuale sconto
// codice partner. Nessuna regressione sul caso più comune (un solo acquisto
// verso una destinazione).
function consolidatedGroupPrice(items) {
  const destinationName = destinationCountryForItem(items[0]);
  const dest = DESTINATIONS.find((d) => d.name === destinationName) || DESTINATIONS[DESTINATIONS.length - 1];
  const zone = SHIPPING_RATES[dest.zone];

  // Peso reale combinato: somma dei pesi reali dei singoli oggetti. Ogni
  // oggetto resta comunque mai sotto lo 0.3kg minimo fatturabile — la
  // stessa soglia già applicata oggi al singolo oggetto in shippingCost() —
  // quindi per un gruppo di uno questo è letteralmente lo stesso numero
  // usato oggi; per un gruppo di più oggetti non si perde mai il minimo di
  // fatturazione per collo che un corriere applicherebbe comunque a
  // ciascun pezzo.
  const combinedRealWeight = items.reduce((sum, it) => sum + Math.max(0.3, parseFloat(it.weightKg) || 1), 0);

  // Peso volumetrico combinato: SOMMA dei pesi volumetrici individuali — non
  // un unico volume "ottimizzato" come se gli oggetti si annidassero
  // perfettamente in una scatola più piccola. Approssimazione deliberatamente
  // conservativa: gli oggetti vengono lasciati in negozi spesso diversi e
  // restano colli distinti fino al consolidamento fisico vero e proprio, non
  // sottostimare mai il costo assumendolo diversamente.
  const combinedVolumetricWeight = items.reduce((sum, it) => sum + volumetricWeight(it.dims), 0);

  const billableWeight = Math.max(combinedRealWeight, combinedVolumetricWeight);
  const rawCost = bracketPrice(zone, billableWeight);
  const shipping = parseFloat((rawCost * (1 + SHIPPING_MARGIN)).toFixed(2));

  // Una sola fee di servizio per l'intero gruppo, non una per oggetto: se
  // anche un solo oggetto del gruppo era in breakeven/promo quando è stato
  // aggiunto, l'intero ordine consolidato eredita quella condizione (è
  // comunque un solo "ordine" che il turista sta confermando e pagando
  // ora); altrimenti conta l'abbonamento se anche un solo oggetto lo è.
  const onBreakeven = items.some((it) => it.pricingTier === "breakeven");
  const isSubscribed = items.some((it) => it.pricingTier === "abbonato");
  const fee = onBreakeven ? 0 : isSubscribed ? SUBSCRIBED_FEE : FULL_FEE;

  // Eventuali sconti codice partner già applicati ai singoli oggetti in
  // ResultScreen restano validi e si sommano (nella pratica quasi sempre un
  // solo oggetto del gruppo ne ha uno) — stessa logica di sottrazione dalla
  // fee già usata lì, qui portata a livello di gruppo.
  const totalPartnerDiscount = items.reduce((sum, it) => sum + (it.partnerDiscountAmount || 0), 0);
  const total = Math.max(0, Math.round((shipping + fee - totalPartnerDiscount) * 100) / 100);

  return {
    destinationCountry: destinationName,
    weightKg: parseFloat(billableWeight.toFixed(2)),
    shipping,
    fee,
    partnerDiscount: totalPartnerDiscount,
    eta: zone.eta,
    total,
  };
}

async function classify(messages) {
  const res = await fetch("/.netlify/functions/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Errore AI");
  const text = data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error("Risposta vuota");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

function classifyImage(base64, mediaType) {
  return classify([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        {
          type: "text",
          text: `Sei un esperto di classificazione doganale per acquisti turistici in Italia. Analizza l'immagine e rispondi SOLO con JSON valido:\n${CLASSIFY_SCHEMA}`,
        },
      ],
    },
  ]);
}

function classifyText(label) {
  return classify([
    {
      role: "user",
      content: `Sei un esperto di classificazione doganale per acquisti turistici in Italia.\nClassifica: "${label}"\nRispondi SOLO con JSON valido:\n${CLASSIFY_SCHEMA}`,
    },
  ]);
}

// ---------------- Internazionalizzazione (i18n) ----------------
//
// FASE 1: copre l'architettura (dizionario, helper t(), rilevamento e
// selettore lingua) più le schermate del percorso principale d'acquisto
// (Cover, Home, Destination, Analyzing, Result, PackageCheck, Identify,
// Documents). Le altre schermate turista e l'area partner restano in
// italiano fisso finché non vengono migrate in una fase successiva,
// riusando questa stessa architettura (I18N + t()).
//
// Nota: i contenuti generati dall'AI di classificazione (nome oggetto,
// descrizione HS, categoria, note di spedizione) non sono coperti da
// questa traduzione — restano nella lingua in cui li restituisce
// classify.js, che oggi è sempre italiano.

const I18N = {
  it: {
    // ---- Header / chrome globale (sempre visibile) ----
    header_site_link: "🌐 Sito",
    header_reset_title: "Resetta profilo e ricomincia",
    header_reset_label: "Reset",
    offline_banner: "📡 Sei offline — la classificazione AI e le foto delle città non sono disponibili finché non torni online. I tuoi acquisti, indirizzi e dashboard restano comunque consultabili.",
    guest_mode_banner: "🛟 Stai usando la versione di continuità di Touch&amp;Go. I tuoi acquisti sono al sicuro e verranno sincronizzati automaticamente.",
    mode_tourist: "Turista",
    mode_partner: "Partner",
    header_assistant_btn: "💬 Chiedi a Touch&Go",

    // ---- Assistente conversazionale (AssistantChatModal, netlify/functions/assistant.js) ----
    assistant_chat_title: "Chiedi a Touch&Go",
    assistant_chat_close_aria: "Chiudi",
    assistant_chat_mode_question: "Fai una domanda",
    assistant_chat_mode_translate: "Comunica col negozio",
    assistant_chat_placeholder_question: "Es. Quanto costa se non mi abbono?",
    assistant_chat_placeholder_translate: "Scrivi qui cosa vuoi comunicare…",
    assistant_chat_send: "Invia",
    assistant_chat_sending: "Un attimo…",
    assistant_chat_error: "Non sono riuscito a rispondere. Riprova.",

    // ---- CoverScreen ----
    cover_pickup_detected: "📍 Punto di ritiro rilevato",
    cover_tap: "Tocca per iniziare →",

    // ---- HomeScreen ----
    home_greeting: "Ciao",
    home_step1_lbl: "Passo 1 · Fotografa l'acquisto",
    home_capture_title: "Fotografa l'oggetto",
    capture_tap_camera: "Tocca per aprire la fotocamera",
    home_gallery_choose: "Scegli dalla galleria",
    home_describe_lbl: "Non puoi fotografarlo? Descrivilo",
    home_describe_placeholder: "Es. bottiglia di vino, borsa in pelle…",
    home_foot: "Peso e dimensioni stimati dalla foto · prezzo calcolato sulla destinazione",
    home_promo_link: "Hai un codice invito?",
    home_promo_placeholder: "Codice invito",
    code_invalid_generic: "Codice non valido o già utilizzato.",
    home_promo_active: "✓ Codice invito {code} attivo — sconto applicato alla prossima spedizione",
    home_pending_item_singular: "acquisto",
    home_pending_item_plural: "acquisti",
    home_pending_suffix: "in sospeso presso i negozi",
    home_pending_sub: "Il ritiro parte solo quando concludi il soggiorno",
    home_conclude_btn: "Concludi il soggiorno e invia il ritiro →",
    loc_reminder_title: "Attiva la posizione dal telefono",
    loc_reminder_text: "Così rileviamo il punto di ritiro con precisione (ora usiamo una stima meno precisa dalla rete).",
    loc_reminder_dismiss_aria: "Chiudi",

    // ---- Assistente (suggerimenti contestuali) ----
    assistant_home: "Fotografa l'oggetto che hai comprato, o descrivilo se preferisci — ci penso io a classificarlo.",
    assistant_destination: "Conferma da dove ritirare l'acquisto e dove deve arrivare — poi calcolo il prezzo.",
    assistant_analyzing: "Un attimo, sto analizzando l'oggetto e calcolando peso e categoria doganale.",
    assistant_options: "Touch&Go si occupa di tutta la spedizione — corriere, dogana e assicurazione inclusi in base a peso, valore e destinazione.",
    assistant_result: "Scegli tra prezzo pieno o abbonamento, poi genera il codice QR per lasciare l'oggetto in negozio.",
    assistant_dismiss_aria: "Chiudi suggerimento",

    // ---- TrustRow ----
    trust_coverage: "Copertura inclusa",
    trust_tracked: "Tracciato via WhatsApp",
    trust_customs: "Dogana automatica",

    // ---- Footer (mostrato con HomeScreen) ----
    footer_tagline: "Prototipo Touch&amp;Go · Catania 2026 · Pre-seed · Smart&amp;Start Italia<br/>Classificazione AI reale · Quote e pagamenti simulati per il test",
    footer_dashboard: "La tua spesa",
    footer_history: "I tuoi acquisti ({count})",
    footer_reset: "Resetta tutto",
    footer_terms: "Termini di servizio",
    footer_privacy: "Privacy",

    // ---- DestinationScreen ----
    dest_back: "← Rifai la foto",
    dest_error_offline: "Sei offline: la classificazione AI richiede una connessione. Riprova quando torni online.",
    dest_step2_lbl: "Passo 2 · Conferma ritiro e destinazione",
    dest_note: "Il prezzo verrà calcolato su peso e dimensioni stimati dalla foto, in base a questa destinazione.",
    dest_go_btn: "Analizza e calcola il prezzo →",
    dest_error_api_key: "Chiave API non valida. Riprova più tardi.",
    dest_error_ai_generic: "Errore AI. Riprova.",

    // ---- PickupField / DestinationField / GuestDestinationField ----
    pickup_lbl_gps: "Punto di ritiro (GPS)",
    pickup_lbl_ip: "Punto di ritiro (rete)",
    pickup_lbl_default: "Punto di ritiro",
    pickup_note: "Modificabile se il ritiro avviene altrove (es. un servizio di imballaggio esterno), non solo presso il punto vendita.",
    pickup_use_location: "📍 Usa la mia posizione attuale",
    pickup_locating: "Rilevo…",
    pickup_recent_lbl: "Città recenti",
    guest_dest_lbl: "Paese di destinazione",
    guest_dest_note: "Basta il paese per calcolare subito il prezzo — l'indirizzo completo verrà chiesto solo quando confermi davvero la spedizione.",
    dest_field_from_profile: "Dal tuo profilo",
    dest_field_selected: "Destinazione selezionata",
    dest_no_address: "Nessun indirizzo salvato",
    dest_default_label: "Indirizzo",
    dest_add_address_btn: "+ Aggiungi un nuovo indirizzo",

    // ---- AnalyzingScreen ----
    analyzing_text: "Analisi in corso…",

    // ---- ResultScreen ----
    result_step3_lbl: "Passo 3 · Risultato",
    result_identified: "✓ Identificato · confidenza {confidence}",
    confidence_alta: "alta",
    confidence_media: "media",
    confidence_bassa: "bassa",
    result_lbl_weight: "Peso stimato",
    result_lbl_obj_dims: "Dimensioni oggetto",
    result_lbl_pkg_dims: "Dimensioni pacco (con imballo)",
    result_lbl_fragile: "Fragilità",
    result_fragile_yes: "⚠️ Fragile",
    result_fragile_no: "Non fragile",
    result_lbl_pickup_from: "Ritiro da",
    result_lbl_destination: "Destinazione",
    result_lbl_hs_code: "Codice doganale HS",
    result_obj_fallback: "Oggetto",
    result_secure_note: "🛡️ Valore dichiarato elevato: copertura assicurativa estesa consigliata — richiedibile senza costi aggiuntivi prima del ritiro.",
    result_promo_badge_breakeven: "Una tantum · invito {code}",
    result_promo_headline_breakeven: "La tua prima spedizione,<br><em>al prezzo che costa a noi.</em>",
    result_fee_service: "Fee di servizio Touch&amp;Go",
    result_shipping_intl: "Servizio di spedizione internazionale",
    result_promo_note_breakeven: "Nessuna fee di servizio su questa spedizione — offerta valida una sola volta.",
    result_promo_btn_activate: "Attiva l'offerta e continua →",
    result_promo_badge_firsttime: "Prova gratuita · prima spedizione",
    result_promo_headline_firsttime: "La tua prima spedizione,<br><em>senza fee di servizio.</em>",
    result_promo_note_firsttime: "Paghi solo il servizio di spedizione, a tariffa piena — così puoi provare il servizio prima di scegliere se abbonarti. Vale una sola volta.",
    result_dual_choose: "Scegli come pagare — confronto sempre visibile, per ogni spedizione",
    result_price_full_lbl: "Prezzo pieno",
    result_price_full_note: "Fee €{fee} + spedizione €{shipping} — nessun impegno",
    result_price_full_btn: "Continua a prezzo pieno",
    result_price_sub_lbl: "Con abbonamento",
    result_price_sub_note: "Fee scontata €{fee} + spedizione €{shipping} — su questa e le prossime spedizioni",
    result_price_sub_btn: "Abbonati e risparmia →",
    result_quote_title: "Preventivo trasparente",
    result_quote_suffix_breakeven: "· offerta breakeven",
    result_quote_suffix_subscribed: "· prezzo abbonato",
    result_total_lbl: "Totale",
    result_delivery_note: "Consegna in {eta} · tracciamento incluso · copertura standard inclusa",
    result_discount_lbl: "Sconto codice partner ({code})",
    result_estimate_badge: "Stima per spedizione singola",
    result_estimate_note: "Il totale finale dipende da eventuali altri acquisti consolidati verso la stessa destinazione — nessun addebito ora, questa è solo un'anteprima. Il calcolo definitivo e il pagamento avvengono solo quando confermi la conclusione del soggiorno.",
    result_qr_btn: "Genera QR code →",
    result_restart_btn: "Classifica un altro oggetto",
    result_partner_discount_link: "Hai un codice sconto partner?",
    result_partner_discount_placeholder: "Codice sconto partner",
    result_partner_discount_applied: "✓ Codice sconto partner {code} applicato — -€{amount} sulla fee di servizio",
    partner_discount_error_default: "Codice non valido o già utilizzato.",
    partner_discount_error_connection: "Errore di connessione. Riprova.",

    // ---- PackageCheckScreen ----
    back_generic: "← Torna indietro",
    item_not_found: "Acquisto non trovato.",
    pkgcheck_step_lbl: "Verifica imballo",
    pkgcheck_rec_lbl: "Dimensioni consigliate",
    pkgcheck_capture_title: "Fotografa l'imballo pronto",
    pkgcheck_offline_alert: "Sei offline: la verifica dell'imballo richiede una connessione.",
    pkgcheck_checking: "🔎 Verifico l'imballo…",
    pkgcheck_failed_alert: "⚠️ Verifica non riuscita. Riprova.",
    pkgcheck_oversized: "⚠️ Imballo più grande del necessario",
    pkgcheck_ok: "✓ Imballo conforme",
    pkgcheck_detected_dims: "Dimensioni rilevate: {dims}",

    // ---- IdentifyScreen ----
    identify_step_gate: "Ultimo passo · Registrati per spedire",
    identify_step_normal: "Prima di iniziare · Chi sei",
    identify_intro_default: "Ci serve sapere chi sei e dove deve arrivare l'acquisto — così calcoliamo il prezzo giusto e prepariamo i documenti doganali a tuo nome. Il documento viene chiesto una sola volta.",
    identify_name_lbl: "Il tuo nome",
    identify_name_placeholder: "Es. Maria Rossi",
    identify_email_lbl: "Email (per il tuo account)",
    identify_email_placeholder: "maria@esempio.com",
    identify_dest_lbl: "Indirizzo di destinazione",
    identify_doc_lbl: "Documento di riconoscimento",
    identify_doc_upload_txt: "Tocca per fotografare o caricare un documento (carta d'identità, passaporto)",
    identify_doc_status_none: "Nessun documento caricato",
    identify_doc_status_checking: "🔎 Verifico se il documento contiene una firma…",
    identify_doc_status_sig_yes: "✓ Documento caricato — firma rilevata sul documento",
    identify_doc_status_sig_no: "✓ Documento caricato — nessuna firma rilevata sul documento",
    identify_doc_status_sig_error: "✓ Documento caricato — verifica firma non riuscita, riprova più tardi",
    identify_doc_footnote: "Se il documento contiene già una firma visibile, verrà usata per firmare digitalmente le tue fatture proforma — nessuna firma aggiuntiva richiesta. Il documento resta salvato solo sul tuo dispositivo.",
    identify_save_btn: "Salva e continua →",
    identify_email_invalid_alert: "Inserisci un'email valida — serve per il tuo account.",
    identify_default_guest_name: "Ospite",
    identify_default_address_label: "Casa",
    identify_biometric_activating: "Attivo lo sblocco biometrico…",

    // ---- AddressFormFields (usato da IdentifyScreen) ----
    addr_street_placeholder: "Via e numero civico",
    addr_city_placeholder: "Città",
    addr_cap_placeholder: "CAP",

    // ---- DocumentsScreen ----
    docs_not_found: "Documenti non trovati.",
    docs_waybill_lbl: "Lettera di vettura",
    docs_row_reference: "Riferimento",
    docs_row_sender: "Mittente",
    docs_row_pickup: "Punto di ritiro",
    docs_row_recipient: "Destinatario",
    docs_row_delivery_address: "Indirizzo di consegna",
    docs_row_content: "Contenuto",
    docs_row_weight: "Peso",
    docs_row_pkg_dims: "Dimensioni pacco",
    docs_row_issue_date: "Data emissione",
    docs_invoice_lbl: "Fattura proforma",
    docs_row_invoice_number: "Numero fattura",
    docs_row_seller: "Venditore",
    docs_seller_value: "Touch&amp;Go — spedizione turistica",
    docs_row_buyer: "Acquirente",
    docs_row_goods_desc: "Descrizione merce",
    docs_row_declared_value: "Valore dichiarato",
    docs_row_vat_exempt: "Esenzione IVA",
    docs_row_shipping_cost: "Costo spedizione",
    docs_signature_lbl: "Firma",
    docs_signature_yes: "✓ Firma rilevata sul documento di riconoscimento caricato in fase di registrazione da {name} — usata per firmare digitalmente questa fattura.",
    docs_signature_no: "Nessuna firma rilevata sul documento caricato in fase di registrazione. La fattura non risulta firmata digitalmente.",
    docs_signature_fallback_name: "il turista",
    docs_id_on_file: "✓ Copia del documento associata a questo mittente, conservata sul dispositivo. Non riprodotta qui per riservatezza — disponibile al corriere tramite il codice di riferimento del QR.",
    docs_id_missing: "Nessun documento di riconoscimento associato a questo profilo.",

    // ---- OnboardingScreen (prima apertura, stesso copy della sezione "Come funziona" del sito) ----
    onboarding_live: "Prototipo reale",
    onboarding_eyebrow: "Come funziona",
    onboarding_stat0: "secondi per la stima AI",
    onboarding_stat3: "ordine unico di ritiro",
    onboarding_t0: "Fotografa l'oggetto",
    onboarding_p0: "Nel negozio, subito dopo l'acquisto. L'AI stima peso, dimensioni e categoria doganale in 3 secondi.",
    onboarding_t1: "Confermi ritiro e destinazione",
    onboarding_p1: "Il punto di ritiro è rilevato automaticamente; la destinazione arriva dal tuo profilo, modificabile in ogni momento.",
    onboarding_t2: "Lasci l'oggetto con un QR",
    onboarding_p2: "Il QR resta in sospeso: puoi continuare a fare acquisti in altri negozi durante il soggiorno.",
    onboarding_t3: "Concludi e consolidiamo",
    onboarding_p3: "Fine vacanza: un solo ordine di ritiro per tutti gli acquisti verso la stessa destinazione, invece di tante spedizioni separate.",
    onboarding_skip: "Salta",
    onboarding_replay: "Rivedi come funziona",
  },
  en: {
    // ---- Header / global chrome (always visible) ----
    header_site_link: "🌐 Site",
    header_reset_title: "Reset profile and start over",
    header_reset_label: "Reset",
    offline_banner: "📡 You're offline — AI classification and city photos aren't available until you're back online. Your purchases, addresses and dashboard are still available.",
    guest_mode_banner: "🛟 You're using Touch&amp;Go's continuity space. Your purchases are safe and will sync automatically.",
    mode_tourist: "Tourist",
    mode_partner: "Partner",
    header_assistant_btn: "💬 Ask Touch&Go",

    // ---- Conversational assistant (AssistantChatModal, netlify/functions/assistant.js) ----
    assistant_chat_title: "Ask Touch&Go",
    assistant_chat_close_aria: "Close",
    assistant_chat_mode_question: "Ask a question",
    assistant_chat_mode_translate: "Talk to the shop",
    assistant_chat_placeholder_question: "E.g. How much does it cost if I don't subscribe?",
    assistant_chat_placeholder_translate: "Write here what you want to say…",
    assistant_chat_send: "Send",
    assistant_chat_sending: "One moment…",
    assistant_chat_error: "I couldn't get an answer. Please try again.",

    // ---- CoverScreen ----
    cover_pickup_detected: "📍 Pickup point detected",
    cover_tap: "Tap to start →",

    // ---- HomeScreen ----
    home_greeting: "Hi",
    home_step1_lbl: "Step 1 · Photograph your purchase",
    home_capture_title: "Take a photo of the item",
    capture_tap_camera: "Tap to open the camera",
    home_gallery_choose: "Choose from gallery",
    home_describe_lbl: "Can't take a photo? Describe it",
    home_describe_placeholder: "E.g. bottle of wine, leather bag…",
    home_foot: "Weight and size estimated from the photo · price calculated based on destination",
    home_promo_link: "Have an invite code?",
    home_promo_placeholder: "Invite code",
    code_invalid_generic: "Invalid or already used code.",
    home_promo_active: "✓ Invite code {code} active — discount applied to your next shipment",
    home_pending_item_singular: "item",
    home_pending_item_plural: "items",
    home_pending_suffix: "pending at stores",
    home_pending_sub: "Pickup only starts once you end your stay",
    home_conclude_btn: "End your stay and request pickup →",
    loc_reminder_title: "Turn on location on your phone",
    loc_reminder_text: "This lets us detect your pickup point precisely (right now we're using a less accurate network-based estimate).",
    loc_reminder_dismiss_aria: "Close",

    // ---- Assistant (contextual tips) ----
    assistant_home: "Take a photo of what you bought, or describe it if you prefer — I'll take care of classifying it.",
    assistant_destination: "Confirm where to pick up your purchase and where it should arrive — then I'll calculate the price.",
    assistant_analyzing: "One moment, I'm analyzing the item and working out its weight and customs category.",
    assistant_options: "Touch&Go takes care of the whole shipment — courier, customs and insurance included, based on weight, value and destination.",
    assistant_result: "Choose between full price or subscription, then generate the QR code to leave the item at the store.",
    assistant_dismiss_aria: "Close tip",

    // ---- TrustRow ----
    trust_coverage: "Insurance included",
    trust_tracked: "Tracked via WhatsApp",
    trust_customs: "Automatic customs",

    // ---- Footer (shown with HomeScreen) ----
    footer_tagline: "Touch&amp;Go prototype · Catania 2026 · Pre-seed · Smart&amp;Start Italia<br/>Real AI classification · Quotes and payments simulated for testing",
    footer_dashboard: "Your spending",
    footer_history: "Your purchases ({count})",
    footer_reset: "Reset everything",
    footer_terms: "Terms of service",
    footer_privacy: "Privacy",

    // ---- DestinationScreen ----
    dest_back: "← Retake photo",
    dest_error_offline: "You're offline: AI classification needs an internet connection. Try again once you're back online.",
    dest_step2_lbl: "Step 2 · Confirm pickup and destination",
    dest_note: "The price will be calculated from the weight and size estimated from the photo, based on this destination.",
    dest_go_btn: "Analyze and calculate the price →",
    dest_error_api_key: "Invalid API key. Please try again later.",
    dest_error_ai_generic: "AI error. Please try again.",

    // ---- PickupField / DestinationField / GuestDestinationField ----
    pickup_lbl_gps: "Pickup point (GPS)",
    pickup_lbl_ip: "Pickup point (network)",
    pickup_lbl_default: "Pickup point",
    pickup_note: "You can change this if pickup happens elsewhere (e.g. an external packing service), not only at the store.",
    pickup_use_location: "📍 Use my current location",
    pickup_locating: "Locating…",
    pickup_recent_lbl: "Recent cities",
    guest_dest_lbl: "Destination country",
    guest_dest_note: "Just the country is enough to get an instant price — we'll ask for the full address only when you actually confirm the shipment.",
    dest_field_from_profile: "From your profile",
    dest_field_selected: "Selected destination",
    dest_no_address: "No saved address",
    dest_default_label: "Address",
    dest_add_address_btn: "+ Add a new address",

    // ---- AnalyzingScreen ----
    analyzing_text: "Analyzing…",

    // ---- ResultScreen ----
    result_step3_lbl: "Step 3 · Result",
    result_identified: "✓ Identified · {confidence} confidence",
    confidence_alta: "high",
    confidence_media: "medium",
    confidence_bassa: "low",
    result_lbl_weight: "Estimated weight",
    result_lbl_obj_dims: "Item size",
    result_lbl_pkg_dims: "Package size (with packaging)",
    result_lbl_fragile: "Fragility",
    result_fragile_yes: "⚠️ Fragile",
    result_fragile_no: "Not fragile",
    result_lbl_pickup_from: "Pickup from",
    result_lbl_destination: "Destination",
    result_lbl_hs_code: "HS customs code",
    result_obj_fallback: "Item",
    result_secure_note: "🛡️ High declared value: extended insurance coverage is recommended — you can request it at no extra cost before pickup.",
    result_promo_badge_breakeven: "One-time · invite {code}",
    result_promo_headline_breakeven: "Your first shipment,<br><em>at the price it costs us.</em>",
    result_fee_service: "Touch&amp;Go service fee",
    result_shipping_intl: "International shipping service",
    result_promo_note_breakeven: "No service fee on this shipment — offer valid once only.",
    result_promo_btn_activate: "Activate offer and continue →",
    result_promo_badge_firsttime: "Free trial · first shipment",
    result_promo_headline_firsttime: "Your first shipment,<br><em>with no service fee.</em>",
    result_promo_note_firsttime: "You only pay for the shipping service, at full rate — so you can try the service before deciding whether to subscribe. Valid once only.",
    result_dual_choose: "Choose how to pay — the comparison is always shown, for every shipment",
    result_price_full_lbl: "Full price",
    result_price_full_note: "€{fee} fee + €{shipping} shipping — no commitment",
    result_price_full_btn: "Continue at full price",
    result_price_sub_lbl: "With subscription",
    result_price_sub_note: "Discounted €{fee} fee + €{shipping} shipping — on this and future shipments",
    result_price_sub_btn: "Subscribe and save →",
    result_quote_title: "Transparent quote",
    result_quote_suffix_breakeven: "· breakeven offer",
    result_quote_suffix_subscribed: "· subscriber price",
    result_total_lbl: "Total",
    result_delivery_note: "Delivery in {eta} · tracking included · standard coverage included",
    result_discount_lbl: "Partner code discount ({code})",
    result_estimate_badge: "Estimate for a single shipment",
    result_estimate_note: "The final total depends on any other purchases consolidated toward the same destination — no charge now, this is only a preview. The final calculation and payment only happen when you confirm the end of your stay.",
    result_qr_btn: "Generate QR code →",
    result_restart_btn: "Classify another item",
    result_partner_discount_link: "Have a partner discount code?",
    result_partner_discount_placeholder: "Partner discount code",
    result_partner_discount_applied: "✓ Partner discount code {code} applied — -€{amount} off the service fee",
    partner_discount_error_default: "Invalid or already used code.",
    partner_discount_error_connection: "Connection error. Please try again.",

    // ---- PackageCheckScreen ----
    back_generic: "← Go back",
    item_not_found: "Purchase not found.",
    pkgcheck_step_lbl: "Check packaging",
    pkgcheck_rec_lbl: "Recommended size",
    pkgcheck_capture_title: "Take a photo of the finished package",
    pkgcheck_offline_alert: "You're offline: checking the packaging needs an internet connection.",
    pkgcheck_checking: "🔎 Checking the package…",
    pkgcheck_failed_alert: "⚠️ Check failed. Please try again.",
    pkgcheck_oversized: "⚠️ Package larger than needed",
    pkgcheck_ok: "✓ Package size OK",
    pkgcheck_detected_dims: "Detected size: {dims}",

    // ---- IdentifyScreen ----
    identify_step_gate: "Last step · Register to ship",
    identify_step_normal: "Before you start · Who you are",
    identify_intro_default: "We need to know who you are and where your purchase should arrive — so we can calculate the right price and prepare the customs documents in your name. Your ID is only requested once.",
    identify_name_lbl: "Your name",
    identify_name_placeholder: "E.g. Jane Smith",
    identify_email_lbl: "Email (for your account)",
    identify_email_placeholder: "jane@example.com",
    identify_dest_lbl: "Delivery address",
    identify_doc_lbl: "ID document",
    identify_doc_upload_txt: "Tap to photograph or upload a document (ID card, passport)",
    identify_doc_status_none: "No document uploaded",
    identify_doc_status_checking: "🔎 Checking if the document contains a signature…",
    identify_doc_status_sig_yes: "✓ Document uploaded — signature detected",
    identify_doc_status_sig_no: "✓ Document uploaded — no signature detected",
    identify_doc_status_sig_error: "✓ Document uploaded — signature check failed, try again later",
    identify_doc_footnote: "If the document already has a visible signature, it will be used to digitally sign your proforma invoices — no extra signature needed. The document stays saved only on your device.",
    identify_save_btn: "Save and continue →",
    identify_email_invalid_alert: "Please enter a valid email — it's needed for your account.",
    identify_default_guest_name: "Guest",
    identify_default_address_label: "Home",
    identify_biometric_activating: "Enabling biometric unlock…",

    // ---- AddressFormFields (used by IdentifyScreen) ----
    addr_street_placeholder: "Street and house number",
    addr_city_placeholder: "City",
    addr_cap_placeholder: "ZIP code",

    // ---- DocumentsScreen ----
    docs_not_found: "Documents not found.",
    docs_waybill_lbl: "Waybill",
    docs_row_reference: "Reference",
    docs_row_sender: "Sender",
    docs_row_pickup: "Pickup point",
    docs_row_recipient: "Recipient",
    docs_row_delivery_address: "Delivery address",
    docs_row_content: "Content",
    docs_row_weight: "Weight",
    docs_row_pkg_dims: "Package size",
    docs_row_issue_date: "Issue date",
    docs_invoice_lbl: "Proforma invoice",
    docs_row_invoice_number: "Invoice number",
    docs_row_seller: "Seller",
    docs_seller_value: "Touch&amp;Go — tourist shipping",
    docs_row_buyer: "Buyer",
    docs_row_goods_desc: "Goods description",
    docs_row_declared_value: "Declared value",
    docs_row_vat_exempt: "VAT exemption",
    docs_row_shipping_cost: "Shipping cost",
    docs_signature_lbl: "Signature",
    docs_signature_yes: "✓ Signature detected on the ID document uploaded at registration by {name} — used to digitally sign this invoice.",
    docs_signature_no: "No signature detected on the document uploaded at registration. This invoice is not digitally signed.",
    docs_signature_fallback_name: "the tourist",
    docs_id_on_file: "✓ A copy of the document is linked to this sender and stored on the device. Not shown here for privacy — available to the courier via the QR reference code.",
    docs_id_missing: "No ID document linked to this profile.",

    // ---- OnboardingScreen (first launch, same copy as the "How it works" section on the site) ----
    onboarding_live: "Real prototype",
    onboarding_eyebrow: "How it works",
    onboarding_stat0: "seconds for the AI estimate",
    onboarding_stat3: "single pickup order",
    onboarding_t0: "Photograph the item",
    onboarding_p0: "In the shop, right after buying. Our AI estimates weight, size and customs category in 3 seconds.",
    onboarding_t1: "Confirm pickup and destination",
    onboarding_p1: "The pickup point is detected automatically; the destination comes from your profile, editable anytime.",
    onboarding_t2: "Leave it with a QR code",
    onboarding_p2: "The QR stays pending: keep shopping at other stores for the rest of your stay.",
    onboarding_t3: "Wrap up and we consolidate",
    onboarding_p3: "End of trip: one single pickup order for everything going to the same destination, instead of many separate shipments.",
    onboarding_skip: "Skip",
    onboarding_replay: "See how it works again",
  },
};

// Traduce i valori di ETA delle spedizioni (dato fisso, calcolato in
// SHIPPING_RATES) senza toccarne la struttura, usata anche da codice non
// ancora tradotto in questa fase.
const ETA_TRANSLATIONS = {
  "24–48 ore": "24–48 hours",
  "2–4 giorni lavorativi": "2–4 business days",
  "4–8 giorni lavorativi": "4–8 business days",
};
function localizeEta(eta) {
  return state.lang === "en" && ETA_TRANSLATIONS[eta] ? ETA_TRANSLATIONS[eta] : eta;
}

// Restituisce la traduzione di `key` nella lingua corrente, con fallback
// all'italiano e infine alla chiave stessa (mai una stringa vuota/undefined
// a schermo). `params` sostituisce placeholder tipo {nome} nel testo.
function t(key, params) {
  let str = (I18N[state.lang] && I18N[state.lang][key]) || I18N.it[key] || key;
  if (params) {
    Object.keys(params).forEach((k) => {
      str = str.split(`{${k}}`).join(params[k]);
    });
  }
  return str;
}

// Sceglie object_it/object_en (coppia bilingue restituita dall'AI di
// classificazione) in base alla lingua corrente, con fallback incrociato
// se una delle due manca, e infine un testo generico localizzato.
function localizeObjectName(r) {
  if (!r) return t("result_obj_fallback");
  if (state.lang === "en") return r.object_en || r.object_it || t("result_obj_fallback");
  return r.object_it || r.object_en || t("result_obj_fallback");
}

// Traduce i 9 valori fissi di categoria restituiti dall'AI di
// classificazione (dato fisso, stesso pattern di ETA_TRANSLATIONS sopra).
const CATEGORY_TRANSLATIONS = {
  Ceramica: "Ceramics",
  Abbigliamento: "Clothing",
  Alimentari: "Food",
  "Vino & Spirits": "Wine & Spirits",
  "Accessori Moda": "Fashion Accessories",
  "Arte & Antiquariato": "Art & Antiques",
  Gioielleria: "Jewelry",
  Artigianato: "Handicraft",
  Altro: "Other",
};
function localizeCategory(category) {
  return state.lang === "en" && CATEGORY_TRANSLATIONS[category] ? CATEGORY_TRANSLATIONS[category] : category;
}

// Sceglie hs_description_it/hs_description_en in base alla lingua corrente,
// con fallback incrociato se l'AI non ha valorizzato una delle due lingue.
function localizeHsDescription(r) {
  if (!r) return "";
  if (state.lang === "en") return r.hs_description_en || r.hs_description_it || "";
  return r.hs_description_it || r.hs_description_en || "";
}

// Sceglie shipping_note_it/shipping_note_en in base alla lingua corrente,
// stesso pattern di localizeHsDescription.
function localizeShippingNote(r) {
  if (!r) return "";
  if (state.lang === "en") return r.shipping_note_en || r.shipping_note_it || "";
  return r.shipping_note_it || r.shipping_note_en || "";
}

// Sceglie il nome visualizzato di una destinazione (DESTINATIONS[].name_en)
// in base alla lingua corrente; `name` resta invariato per la logica interna
// (corrispondenza con le zone di spedizione, valore delle <option>, ecc.).
function destinationDisplayName(name) {
  if (!name) return name;
  const dest = DESTINATIONS.find((d) => d.name === name);
  return state.lang === "en" && dest && dest.name_en ? dest.name_en : name;
}

// Rilevamento lingua al primo avvio: preferenza salvata, altrimenti lingua
// del browser (inglese se inizia con "en", italiano per tutto il resto —
// pubblico prevalentemente italiano/internazionale).
function detectInitialLang() {
  try {
    const saved = localStorage.getItem("tg_lang");
    if (saved === "it" || saved === "en") return saved;
  } catch (e) {}
  if (typeof navigator !== "undefined" && navigator.language && navigator.language.toLowerCase().startsWith("en")) return "en";
  return "it";
}

function setLang(lang) {
  if (lang !== "it" && lang !== "en") return;
  state.lang = lang;
  try {
    localStorage.setItem("tg_lang", lang);
  } catch (e) {}
  render();
}

// ---------------- App state & rendering ----------------

const state = {
  lang: detectInitialLang(),
  mode: "turista",
  screen: "cover",
  error: null,
  result: null,
  price: null,
  addresses: [],
  selectedAddressId: null,
  destinationFromProfile: true,
  addAddressReturnTo: "destination",
  pendingInput: null,
  location: null,
  locationPhoto: null,
  pickupPoint: "Catania",
  pickupSource: null,
  isOffline: typeof navigator !== "undefined" && "onLine" in navigator ? !navigator.onLine : false,
  // Spazio ospite (continuità operativa) — vedi checkGuestMode() più sotto
  // e MANUALE.md. Sempre false finché /.netlify/functions/guest-status non
  // risponde guestMode:true, cosa che succede solo sul deploy con la
  // variabile d'ambiente GUEST_MODE=true (mai su produzione).
  guestMode: false,
  locationReminderDismissed: false,
  bookingCode: null,
  pendingItems: [],
  lastQueuedItem: null,
  shippedGroups: [],
  purchaseHistory: [],
  activePartnerCode: null,
  partnerLoggedCode: null,
  partnerLoginLoading: false,
  partnerLoginError: null,
  partnerStats: null,
  partnerUpgradePlan: null,
  partnerUpgradeLoading: false,
  partnerUpgradeError: null,
  showPartnerQr: false,
  editingItemId: null,
  viewingItemId: null,
  viewingDocsItemId: null,
  checkingItemId: null,
  docsReturnTo: null,
  touristName: null,
  touristEmail: null,
  guestDestinationCountry: null,
  identifyPrompt: null,
  identifyReturnTo: null,
  biometricCredentialId: null,
  biometricVerified: false,
  isSubscribed: false,
  priceConfirmedForThisResult: false,
  priceConfirmedAsBreakeven: false,
  idDocument: null,
  signatureDetected: false,
  promoCode: null,
  promoChecked: false,
  promoValid: false,
  promoRedeemedThisOrder: false,
  showPromoInput: false,
  showPartnerDiscountInput: false,
  partnerDiscountCodeInput: "",
  partnerDiscountChecking: false,
  partnerDiscountApplied: false,
  partnerDiscountCode: null,
  partnerDiscountAmount: 0,
  partnerDiscountError: null,
  partnerCreditRedeeming: false,
  partnerCreditRedeemResult: null,
  partnerCreditRedeemError: null,
  partnerDiscountGenerating: false,
  partnerGeneratedDiscountCode: null,
  partnerDiscountGenerateError: null,
  assistantDismissed: {},
  // Modale "Chiedi a Touch&Go" (assistente conversazionale, netlify/functions/assistant.js)
  // — nomi con prefisso assistantChat* per non confondersi con
  // assistantDismissed/AssistantAvatar sopra, che sono i piccoli
  // suggerimenti contestuali per-schermata, una feature diversa.
  assistantChatOpen: false,
  assistantChatMode: "domanda",
  assistantChatInput: "",
  assistantChatReply: null,
  assistantChatError: null,
  assistantChatLoading: false,
};
const app = document.getElementById("app");

// Filtro SVG "schizzo architettonico" per lo sfondo della Cover quando è
// disponibile una foto reale del punto di ritiro (state.locationPhoto),
// al posto della foto fotorealistica — desatura, rileva i bordi, inverte
// (bordi scuri su sfondo chiaro) e tinge con i colori del brand.
// Iniettato una sola volta in <body>, non dentro #app: render() svuota
// #app a ogni chiamata (app.innerHTML = ""), quindi il filtro deve vivere
// fuori da lì per restare referenziabile da CSS (filter:url(#sketchFilter))
// per tutta la vita della pagina.
function injectSketchFilter() {
  if (document.getElementById("sketchFilter")) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("style", "position:absolute;width:0;height:0");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `
    <filter id="sketchFilter" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0" result="gray"/>
      <feConvolveMatrix order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" divisor="2.4" bias="0" preserveAlpha="true" result="edges" in="gray"/>
      <feColorMatrix type="matrix" values="-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0" in="edges" result="inverted"/>
      <feComponentTransfer in="inverted" result="contrast">
        <feFuncR type="gamma" amplitude="1" exponent="1.8" offset="0"/>
        <feFuncG type="gamma" amplitude="1" exponent="1.8" offset="0"/>
        <feFuncB type="gamma" amplitude="1" exponent="1.8" offset="0"/>
      </feComponentTransfer>
      <!-- Tinge: interpola linearmente per canale tra il colore delle
           linee (oro brand, ai bordi rilevati) e il colore di sfondo
           (bruno scuro caldo, nelle zone piatte) in base alla luminanza
           del passaggio precedente — non una tinta piatta: qui il colore
           dipende davvero da dov'è un bordo. -->
      <feColorMatrix type="matrix" values="
        -0.2227 -0.2227 -0.2227 0 0.788
        -0.1877 -0.1877 -0.1877 0 0.663
        -0.1203 -0.1203 -0.1203 0 0.431
        0 0 0 1 0" in="contrast" result="tinted"/>
    </filter>`;
  document.body.appendChild(svg);
}
injectSketchFilter();

// Banner "spazio ospite" (continuità operativa) — vedi checkGuestMode()
// più sotto e MANUALE.md. Nascosto di default: compare SOLO se
// state.guestMode è true, cioè solo quando /.netlify/functions/guest-status
// risponde guestMode:true — cosa che succede solo sul deploy con la
// variabile d'ambiente GUEST_MODE=true, mai su produzione.
function GuestModeBanner() {
  return el("div", "guest-mode-banner", t("guest_mode_banner"));
}

function render() {
  document.documentElement.lang = state.lang;
  app.innerHTML = "";
  // Spazio ospite: mostrato PRIMA del controllo onboarding qui sotto (che
  // altrimenti fa uscire da render() subito, senza mai arrivare a
  // Header()) — così il banner è visibile fin dalla primissima schermata
  // vista da un turista nuovo, non solo dopo l'onboarding.
  if (state.guestMode) app.appendChild(GuestModeBanner());
  if (state.screen === "onboarding") {
    app.appendChild(OnboardingScreen());
    return;
  }
  app.appendChild(Header());
  if (state.mode === "partner") app.appendChild(PartnerScreen());
  else if (state.screen === "biometric-lock") app.appendChild(BiometricLockScreen());
  else if (state.screen === "cover") app.appendChild(CoverScreen());
  else if (state.screen === "identify") app.appendChild(IdentifyScreen());
  else if (state.screen === "home") app.appendChild(HomeScreen());
  else if (state.screen === "destination") app.appendChild(DestinationScreen());
  else if (state.screen === "add-address") app.appendChild(AddAddressScreen());
  else if (state.screen === "choose-address") app.appendChild(ChooseAddressScreen());
  else if (state.screen === "analyzing") app.appendChild(AnalyzingScreen());
  else if (state.screen === "result") app.appendChild(ResultScreen());
  else if (state.screen === "queued") app.appendChild(QueuedScreen());
  else if (state.screen === "conclude") app.appendChild(ConcludeScreen());
  else if (state.screen === "shipped") app.appendChild(ShippedScreen());
  else if (state.screen === "history") app.appendChild(HistoryScreen());
  else if (state.screen === "edit-item-address") app.appendChild(EditItemAddressScreen());
  else if (state.screen === "view-item-photo") app.appendChild(ViewItemPhotoScreen());
  else if (state.screen === "dashboard") app.appendChild(DashboardScreen());
  else if (state.screen === "documents") app.appendChild(DocumentsScreen());
  else if (state.screen === "package-check") app.appendChild(PackageCheckScreen());
  if (state.screen === "home") app.appendChild(Footer());
  if (state.mode !== "partner" && state.screen === "result") {
    requestAnimationFrame(() => animateResult(state.result, state.price));
  }
  // Overlay sopra la schermata corrente, non una navigazione — l'utente
  // non perde il contesto (es. può farsi una domanda da ResultScreen e
  // ritrovarsi esattamente lì chiudendo la chat).
  if (state.assistantChatOpen) app.appendChild(AssistantChatModal());
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function Header() {
  const wrap = el("div");
  const header = el("div", "header");
  header.innerHTML = `
    <div class="brand"><span class="brand-name">Touch<b>&amp;</b>Go</span></div>
    <div class="header-actions">
      <div class="lang-switch" id="lang-switch">
        <button class="lang-btn ${state.lang === "it" ? "on" : ""}" data-lang="it" aria-label="Italiano">IT</button>
        <button class="lang-btn ${state.lang === "en" ? "on" : ""}" data-lang="en" aria-label="English">EN</button>
      </div>
      ${state.mode === "turista" ? `<button class="header-assistant-btn" id="header-assistant-btn" type="button">${t("header_assistant_btn")}</button>` : ""}
      <a class="header-site-link" href="/site/index.html" target="_blank" rel="noopener">${t("header_site_link")}</a>
      <button class="header-reset" id="header-reset" title="${t("header_reset_title")}">⟲ ${t("header_reset_label")}</button>
    </div>`;
  wrap.appendChild(header);
  header.querySelector("#header-reset").addEventListener("click", resetEverything);
  header.querySelectorAll("[data-lang]").forEach((b) =>
    b.addEventListener("click", () => setLang(b.dataset.lang))
  );
  const assistantBtn = header.querySelector("#header-assistant-btn");
  if (assistantBtn) {
    assistantBtn.addEventListener("click", () => {
      state.assistantChatOpen = true;
      render();
    });
  }

  if (state.isOffline) {
    wrap.appendChild(el("div", "offline-banner", t("offline_banner")));
  }

  const toggle = el("div", "mode-toggle");
  toggle.innerHTML = `
    <button class="mode-btn ${state.mode === "turista" ? "on" : ""}" data-mode="turista">${t("mode_tourist")}</button>
    <button class="mode-btn ${state.mode === "partner" ? "on" : ""}" data-mode="partner">${t("mode_partner")}</button>`;
  toggle.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      render();
    })
  );
  wrap.appendChild(toggle);
  return wrap;
}

// ---------------- Assistente conversazionale "Chiedi a Touch&Go" ----------------
//
// Overlay sempre raggiungibile dal pulsante in Header() (solo modalità
// turista) — non una schermata a sé, così l'utente non perde il contesto
// di dove si trovava. Due modalità, gestite da netlify/functions/assistant.js:
// "domanda" (risposta informata sui fatti reali del servizio) e
// "traduci_per_negoziante" (traduzione turista↔negoziante nelle due
// direzioni). Fase 1: disponibile a tutti i turisti, non vincolata a
// nessun piano/abbonamento specifico.
function AssistantChatModal() {
  const overlay = el("div", "assistant-chat-overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeAssistantChat();
  });

  const modal = el("div", "assistant-chat-modal");
  modal.addEventListener("click", (e) => e.stopPropagation());

  const header = el("div", "assistant-chat-header");
  header.innerHTML = `<div class="assistant-chat-title">${t("assistant_chat_title")}</div>`;
  const closeBtn = el("button", "assistant-chat-close", "✕");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", t("assistant_chat_close_aria"));
  closeBtn.addEventListener("click", closeAssistantChat);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const modeRow = el("div", "assistant-chat-mode-row");
  modeRow.innerHTML = `
    <button type="button" class="assistant-chat-mode-btn ${state.assistantChatMode === "domanda" ? "on" : ""}" data-mode="domanda">${t("assistant_chat_mode_question")}</button>
    <button type="button" class="assistant-chat-mode-btn ${state.assistantChatMode === "traduci_per_negoziante" ? "on" : ""}" data-mode="traduci_per_negoziante">${t("assistant_chat_mode_translate")}</button>`;
  modeRow.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      state.assistantChatMode = b.dataset.mode;
      render();
    })
  );
  modal.appendChild(modeRow);

  const field = el("div", "assistant-chat-field");
  field.innerHTML = `<input class="addr-input assistant-chat-input" id="assistant-chat-input" placeholder="${
    state.assistantChatMode === "domanda" ? t("assistant_chat_placeholder_question") : t("assistant_chat_placeholder_translate")
  }" />`;
  const input = field.querySelector("#assistant-chat-input");
  input.value = state.assistantChatInput;
  input.addEventListener("input", (e) => {
    state.assistantChatInput = e.target.value;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendAssistantChatMessage();
  });
  modal.appendChild(field);
  // A differenza degli altri campi con dettatura vocale (nome, indirizzo),
  // qui la voce È l'interazione: dopo la trascrizione invia subito il
  // messaggio, come in un vero assistente vocale — altrimenti il turista
  // parla, non vede alcuna risposta e non capisce che dovrebbe comunque
  // premere "Invia" a mano.
  addVoiceButton(input, () => sendAssistantChatMessage());

  const sendBtn = el("button", "btn-primary assistant-chat-send", state.assistantChatLoading ? t("assistant_chat_sending") : t("assistant_chat_send"));
  sendBtn.type = "button";
  sendBtn.disabled = state.assistantChatLoading;
  sendBtn.addEventListener("click", sendAssistantChatMessage);
  modal.appendChild(sendBtn);

  if (state.assistantChatError) {
    modal.appendChild(el("div", "alert", `⚠️ ${state.assistantChatError}`));
  }

  if (state.assistantChatReply) {
    const bubble = el("div", "assistant-chat-reply");
    bubble.textContent = state.assistantChatReply;
    modal.appendChild(bubble);
  }

  overlay.appendChild(modal);
  return overlay;
}

function closeAssistantChat() {
  state.assistantChatOpen = false;
  render();
}

async function sendAssistantChatMessage() {
  const message = state.assistantChatInput.trim();
  if (!message || state.assistantChatLoading) return;
  state.assistantChatLoading = true;
  state.assistantChatError = null;
  state.assistantChatReply = null;
  state.assistantChatInput = "";
  render();
  try {
    const res = await fetch("/.netlify/functions/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: state.assistantChatMode, message, lang: state.lang }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error((data.error && data.error.message) || "Errore AI");
    state.assistantChatReply = data.reply;
  } catch (e) {
    state.assistantChatError = t("assistant_chat_error");
  }
  state.assistantChatLoading = false;
  render();
}

function PartnerScreen() {
  const wrap = el("div", "section");

  wrap.appendChild(el("div", "tg-lbl", "Per negozi, hotel e tour operator"));
  const intro = el("div", "info-card");
  intro.innerHTML = `<div class="info-line">Offri Touch&amp;Go ai tuoi clienti: spedizione doganale con codice AI, esenzione IVA export automatica e tracciamento incluso — con un guadagno su ogni spedizione venduta tramite il tuo codice.</div>
    <div class="info-line">Piani, canoni e dettagli sulla commissione sono nella sezione partner del sito.</div>`;
  wrap.appendChild(intro);

  const cta = el("button", "btn-primary", "Scopri i piani partner →");
  cta.addEventListener("click", () => {
    window.open("/site/index.html#partner", "_blank", "noopener");
  });
  wrap.appendChild(cta);

  wrap.appendChild(PartnerLoginAndHistory());

  return wrap;
}

function PartnerLoginAndHistory() {
  const wrap = el("div");
  wrap.appendChild(el("div", "tg-lbl", "Area riservata partner"));

  if (!state.partnerLoggedCode) {
    const intro = el(
      "div",
      "identify-intro",
      "Inserisci il tuo codice partner per vedere solo le vendite generate tramite il tuo negozio e le commissioni maturate."
    );
    wrap.appendChild(intro);

    const field = el("div", "dest-field");
    field.innerHTML = `<div class="dest-lbl">Codice partner</div><input class="dest-input" id="partner-code-input" placeholder="Es. NEGOZIO123" value="${state.activePartnerCode || ""}" />`;
    wrap.appendChild(field);
    addVoiceButton(field.querySelector("#partner-code-input"));

    if (state.partnerLoginError) {
      wrap.appendChild(el("div", "alert", `⚠️ ${state.partnerLoginError}`));
    }

    const loginBtn = el("button", "btn-secondary", state.partnerLoginLoading ? "Verifico…" : "Accedi");
    loginBtn.disabled = state.partnerLoginLoading;
    loginBtn.addEventListener("click", async () => {
      const code = document.getElementById("partner-code-input").value.trim().toUpperCase();
      if (state.partnerLoginLoading) return;
      if (!code) {
        state.partnerLoginError = "Inserisci il codice partner prima di accedere.";
        render();
        return;
      }
      state.partnerLoginLoading = true;
      state.partnerLoginError = null;
      render();
      try {
        const res = await fetch("/.netlify/functions/partner-stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        if (data.valid) {
          state.partnerLoggedCode = code;
          state.partnerStats = {
            partnerName: data.partnerName || "",
            plan: data.plan || "free",
            paid: !!data.paid,
            access: data.access || { blocked: false },
            salesCount: data.salesCount || 0,
            totalSalesValue: data.totalSalesValue || 0,
            totalCommission: data.totalCommission || 0,
            creditBalance: data.creditBalance || 0,
            monthlyBreakdown: data.monthlyBreakdown || [],
            recentOrders: data.recentOrders || [],
          };
        } else {
          state.partnerLoginError = "Codice partner non riconosciuto.";
        }
      } catch (e) {
        state.partnerLoginError = "Errore di connessione. Riprova.";
      }
      state.partnerLoginLoading = false;
      render();
    });
    wrap.appendChild(loginBtn);
    return wrap;
  }

  const stats = state.partnerStats || {
    partnerName: "",
    plan: "free",
    paid: false,
    access: { blocked: false },
    salesCount: 0,
    totalSalesValue: 0,
    totalCommission: 0,
    creditBalance: 0,
    monthlyBreakdown: [],
    recentOrders: [],
  };

  const logoutBtn = el("button", "reset-link", "Esci dall'area partner");
  logoutBtn.addEventListener("click", () => {
    state.partnerLoggedCode = null;
    state.partnerStats = null;
    state.partnerLoginError = null;
    state.showPartnerQr = false;
    state.partnerCreditRedeemResult = null;
    state.partnerCreditRedeemError = null;
    state.partnerGeneratedDiscountCode = null;
    state.partnerDiscountGenerateError = null;
    state.partnerUpgradePlan = null;
    state.partnerUpgradeLoading = false;
    state.partnerUpgradeError = null;
    render();
  });

  // TOU-19: piano gratuito scaduto (12 mesi) o piano a pagamento scaduto/
  // non confermato dallo staff — accesso alla propria area negato finché
  // non si passa a un piano a pagamento (o lo staff non conferma il
  // canone dal CRM). Le vendite/commissioni già maturate restano intatte
  // (vedi save-purchase.js) — qui si nega solo l'accesso alla dashboard.
  if (stats.access && stats.access.blocked) {
    const blockCard = el("div", "info-card");
    const isFreeExpired = stats.access.reason === "free-expired";
    blockCard.innerHTML = `
      <div class="alert">⚠️ ${
        isFreeExpired
          ? "Il tuo piano gratuito è scaduto dopo 12 mesi. Per continuare a vendere servizi Touch&amp;Go e accedere alla tua area, passa a un piano a pagamento."
          : "Il canone del tuo piano non risulta confermato. Contatta Touch&amp;Go o attendi la conferma dello staff per riottenere l'accesso."
      }</div>
      ${stats.creditBalance > 0 ? `<div class="info-row"><span>Credito già maturato (resta disponibile)</span><b>€${stats.creditBalance.toFixed(2)}</b></div>` : ""}`;
    wrap.appendChild(blockCard);
    if (isFreeExpired) wrap.appendChild(PartnerUpgradeSection(stats));
    wrap.appendChild(logoutBtn);
    return wrap;
  }

  const summary = el("div", "info-card");
  summary.innerHTML = `
    <div class="info-row"><span>Codice partner</span><b>${state.partnerLoggedCode}</b></div>
    ${stats.partnerName ? `<div class="info-row"><span>Nome registrato</span><b>${stats.partnerName}</b></div>` : ""}
    <div class="info-row"><span>Vendite registrate</span><b>${stats.salesCount}</b></div>
    <div class="info-row"><span>Valore generato tramite il tuo negozio</span><b>€${stats.totalSalesValue.toFixed(2)}</b></div>
    <div class="info-row"><span>Commissioni maturate (10%)</span><b>€${stats.totalCommission.toFixed(2)}</b></div>
    <div class="info-row total"><span>Credito disponibile</span><b>€${stats.creditBalance.toFixed(2)}</b></div>`;
  wrap.appendChild(summary);

  // Piano gratuito, non ancora scaduto: incentivo a passare a un piano a
  // pagamento — quanto avrebbe già generato di commissione se fosse stato
  // abbonato (stesso 10% di totalCommission sopra, qui riletto come
  // occasione persa). Il countdown avvisa prima che scatti il blocco.
  if (stats.plan === "free" || !stats.plan) {
    const daysLeft = stats.access && typeof stats.access.daysRemaining === "number" ? stats.access.daysRemaining : null;
    const incentive = el("div", "info-card");
    incentive.innerHTML = `
      ${
        stats.totalCommission > 0
          ? `<div class="info-row"><span>Se fossi abbonato, avresti già maturato</span><b>€${stats.totalCommission.toFixed(2)}</b></div>`
          : ""
      }
      ${
        daysLeft != null
          ? `<div class="info-row"><span>Piano gratuito</span><b>${
              daysLeft > 30 ? `${Math.ceil(daysLeft / 30)} mesi rimasti` : `${daysLeft} giorni rimasti`
            }</b></div>`
          : ""
      }`;
    wrap.appendChild(incentive);
    wrap.appendChild(PartnerUpgradeSection(stats));
  }

  wrap.appendChild(PartnerTrendSection(stats));

  wrap.appendChild(PartnerCreditSection(stats));

  wrap.appendChild(PartnerQRSection(state.partnerLoggedCode));

  wrap.appendChild(logoutBtn);

  return wrap;
}

// TOU-19: passaggio self-service dal piano gratuito a uno a pagamento —
// prima di questa feature non esisteva alcun modo per un partner già
// registrato di cambiare piano. Il pagamento reale resta fuori da questo
// prototipo (come alla registrazione): dopo l'upgrade lo staff deve
// comunque confermare il canone dal CRM prima che l'accesso si sblocchi
// davvero (vedi computeAccessStatus in partner-stats.js).
function PartnerUpgradeSection(stats) {
  const wrap = el("div", "info-card");
  const plans = [
    ["boutique", "Boutique — €49/mese"],
    ["enoteche", "Enoteche & Cantine — €59/mese"],
    ["sport", "Sport & Attrezzatura — €69/mese"],
    ["hotel", "Hotel — €99/mese"],
    ["agenzie", "Agenzie di Viaggio — €149/mese"],
    ["touroperator", "Tour Operator — €199/mese"],
  ];
  const field = el("div", "dest-field");
  const options = plans.map(([value, label]) => `<option value="${value}" ${state.partnerUpgradePlan === value ? "selected" : ""}>${label}</option>`).join("");
  field.innerHTML = `<div class="dest-lbl">Passa a un piano a pagamento</div><select class="dest-input" id="partner-upgrade-plan"><option value="">Scegli un piano…</option>${options}</select>`;
  wrap.appendChild(field);

  if (state.partnerUpgradeError) {
    wrap.appendChild(el("div", "alert", `⚠️ ${state.partnerUpgradeError}`));
  }

  const upgradeBtn = el("button", "btn-primary", state.partnerUpgradeLoading ? "Attivo il piano…" : "Attiva piano a pagamento");
  upgradeBtn.disabled = state.partnerUpgradeLoading;
  upgradeBtn.addEventListener("click", async () => {
    const plan = document.getElementById("partner-upgrade-plan").value;
    if (!plan) {
      state.partnerUpgradeError = "Scegli un piano prima di continuare.";
      render();
      return;
    }
    state.partnerUpgradeLoading = true;
    state.partnerUpgradeError = null;
    render();
    try {
      const res = await fetch("/.netlify/functions/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upgrade-partner-plan", code: state.partnerLoggedCode, plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore durante l'attivazione del piano");
      await refreshPartnerStats();
    } catch (e) {
      state.partnerUpgradeError = e.message || "Errore di connessione. Riprova.";
    }
    state.partnerUpgradeLoading = false;
    render();
  });
  wrap.appendChild(upgradeBtn);
  wrap.appendChild(el("div", "partner-result-sub", "Dopo l'attivazione, lo staff Touch&Go confermerà il canone e sbloccherà l'accesso."));

  return wrap;
}

// Ricarica le statistiche (incluso creditBalance) del partner loggato —
// usata dopo un riscatto credito, così il saldo mostrato resta coerente
// con quanto appena scalato lato server.
async function refreshPartnerStats() {
  if (!state.partnerLoggedCode) return;
  try {
    const res = await fetch("/.netlify/functions/partner-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: state.partnerLoggedCode }),
    });
    const data = await res.json();
    if (data.valid) {
      state.partnerStats = {
        partnerName: data.partnerName || "",
        plan: data.plan || "free",
        paid: !!data.paid,
        access: data.access || { blocked: false },
        salesCount: data.salesCount || 0,
        totalSalesValue: data.totalSalesValue || 0,
        totalCommission: data.totalCommission || 0,
        creditBalance: data.creditBalance || 0,
        monthlyBreakdown: data.monthlyBreakdown || [],
        recentOrders: data.recentOrders || [],
      };
    }
  } catch (e) {
    // Aggiornamento saldo non riuscito — resta il valore già mostrato,
    // il riscatto stesso ha comunque avuto successo lato server.
  }
}

// Andamento nel tempo (TOU-17) — a differenza dei totali cumulativi sopra
// (sempre esistiti), qui il partner vede mese per mese: confronto con il
// mese precedente, l'andamento degli ultimi mesi e gli ultimi ordini che
// hanno generato commissione. commission qui è sempre creditIssuedAmount
// (commissione realmente accreditata, non una stima) — un ordine "in
// sospeso" del mese corrente compare quindi con commissione €0 finché non
// viene ritirato.
function PartnerTrendSection(stats) {
  const wrap = el("div");
  const months = stats.monthlyBreakdown || [];

  if (months.length) {
    const current = months[0];
    const previous = months[1] || null;
    const compare = el("div", "info-card");
    const commissionDelta = previous ? current.commission - previous.commission : null;
    const deltaStr =
      previous == null
        ? ""
        : commissionDelta >= 0
        ? `<span style="color:var(--good)">▲ +€${commissionDelta.toFixed(2)} vs mese precedente</span>`
        : `<span style="color:var(--danger)">▼ €${commissionDelta.toFixed(2)} vs mese precedente</span>`;
    compare.innerHTML = `
      <div class="info-row"><span>Questo mese (${current.label})</span><b>${current.orders} ordini · €${current.commission.toFixed(2)} commissioni</b></div>
      ${previous ? `<div class="info-row"><span>Mese precedente (${previous.label})</span><b>${previous.orders} ordini · €${previous.commission.toFixed(2)} commissioni</b></div>` : ""}
      ${deltaStr ? `<div class="info-row">${deltaStr}</div>` : ""}`;
    wrap.appendChild(compare);

    const trendTitle = el("div", "tg-lbl", "Andamento mensile");
    wrap.appendChild(trendTitle);
    const trendList = el("div", "info-card");
    trendList.innerHTML = months
      .map((m) => `<div class="info-row"><span>${m.label}</span><b>${m.orders} ordini · €${m.serviceValue.toFixed(2)} · €${m.commission.toFixed(2)} comm.</b></div>`)
      .join("");
    wrap.appendChild(trendList);
  }

  const orders = stats.recentOrders || [];
  if (orders.length) {
    const ordersTitle = el("div", "tg-lbl", "Ultimi ordini");
    wrap.appendChild(ordersTitle);
    const ordersList = el("div", "info-card");
    ordersList.innerHTML = orders
      .map((o) => {
        const d = new Date(o.date);
        const dateStr = isNaN(d) ? "—" : d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
        return `<div class="info-row"><span>${dateStr} · ${o.objectName || "—"}</span><b>€${o.commission.toFixed(2)}</b></div>`;
      })
      .join("");
    wrap.appendChild(ordersList);
  }

  return wrap;
}

// Riscatto del credito partner: pagare il canone (fino a coprirlo) o
// generare un codice sconto monouso da dare a un cliente.
function PartnerCreditSection(stats) {
  const wrap = el("div");

  if (stats.creditBalance > 0) {
    const redeemBtn = el("button", "btn-secondary", state.partnerCreditRedeeming ? "Applico il credito…" : "Usa credito per il canone");
    redeemBtn.disabled = state.partnerCreditRedeeming;
    redeemBtn.addEventListener("click", async () => {
      state.partnerCreditRedeeming = true;
      state.partnerCreditRedeemError = null;
      state.partnerCreditRedeemResult = null;
      render();
      try {
        const res = await fetch("/.netlify/functions/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "redeem-credit-for-invoice", code: state.partnerLoggedCode }),
        });
        const data = await res.json();
        if (res.ok && data.invoice) {
          state.partnerCreditRedeemResult = data.invoice;
          await refreshPartnerStats();
        } else {
          state.partnerCreditRedeemError = data.error || "Riscatto non riuscito. Riprova.";
        }
      } catch (e) {
        state.partnerCreditRedeemError = "Errore di connessione. Riprova.";
      }
      state.partnerCreditRedeeming = false;
      render();
    });
    wrap.appendChild(redeemBtn);
  }

  if (state.partnerCreditRedeemResult) {
    const r = state.partnerCreditRedeemResult;
    const note = el("div", "promo-active-note");
    note.textContent =
      r.creditApplied > 0
        ? `✓ Fattura ${r.id}: -€${r.creditApplied.toFixed(2)} di credito applicato — importo residuo da pagare €${r.amount.toFixed(2)}`
        : `Fattura ${r.id} generata — nessun credito applicato (importo €${r.amount.toFixed(2)})`;
    wrap.appendChild(note);
  }
  if (state.partnerCreditRedeemError) {
    wrap.appendChild(el("div", "alert", `⚠️ ${state.partnerCreditRedeemError}`));
  }

  const genBtn = el("button", "btn-secondary", state.partnerDiscountGenerating ? "Genero il codice…" : "Genera codice sconto per un cliente");
  genBtn.disabled = state.partnerDiscountGenerating;
  genBtn.addEventListener("click", async () => {
    state.partnerDiscountGenerating = true;
    state.partnerDiscountGenerateError = null;
    render();
    try {
      const res = await fetch("/.netlify/functions/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate-partner-discount-code", code: state.partnerLoggedCode }),
      });
      const data = await res.json();
      if (res.ok && data.discountCode) {
        state.partnerGeneratedDiscountCode = data.discountCode;
      } else {
        state.partnerDiscountGenerateError = data.error || "Generazione codice non riuscita. Riprova.";
      }
    } catch (e) {
      state.partnerDiscountGenerateError = "Errore di connessione. Riprova.";
    }
    state.partnerDiscountGenerating = false;
    render();
  });
  wrap.appendChild(genBtn);

  if (state.partnerGeneratedDiscountCode) {
    wrap.appendChild(
      el(
        "div",
        "promo-active-note",
        `✓ Codice sconto generato: ${state.partnerGeneratedDiscountCode} — comunicalo al cliente, vale il 10% sulla fee di servizio, una sola volta`
      )
    );
  }
  if (state.partnerDiscountGenerateError) {
    wrap.appendChild(el("div", "alert", `⚠️ ${state.partnerDiscountGenerateError}`));
  }

  return wrap;
}

// Il QR è un'immagine raster generata da un servizio esterno (api.qrserver.com,
// vedi qrCodeUrl() sotto) — i suoi colori sono quindi "cotti" nel PNG stesso,
// non CSS: non seguirebbero altrimenti i temi lime/corallo (TOU-21), lasciando
// un riquadro dal vecchio colore fisso dentro una .qr-card ormai scura. Letti
// qui a runtime da --ink/--paper (gli stessi token usati da .qr-card) così il
// QR resta coerente col tema attivo in tutti e tre (produzione + lime/corallo).
function hexToDashRgb(hex) {
  hex = (hex || "").trim().replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  return `${r}-${g}-${b}`;
}
function qrCodeUrl(data, size) {
  const style = getComputedStyle(document.documentElement);
  const color = hexToDashRgb(style.getPropertyValue("--ink") || "#0F0F0F");
  const bgcolor = hexToDashRgb(style.getPropertyValue("--paper") || "#FAF8F4");
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&color=${color}&bgcolor=${bgcolor}&data=${data}`;
}

// QR che incorpora l'URL dell'app con ?partner=CODICE già impostato —
// chi lo scansiona apre l'app con capturePartnerCode() che salva il
// codice partner in automatico (vedi capturePartnerCode(), non toccata).
function PartnerQRSection(code) {
  const wrap = el("div");

  if (!state.showPartnerQr) {
    const qrBtn = el("button", "btn-secondary", "Genera QR per il tuo negozio");
    qrBtn.addEventListener("click", () => {
      state.showPartnerQr = true;
      render();
    });
    wrap.appendChild(qrBtn);
    return wrap;
  }

  const partnerUrl = `${window.location.origin}/?partner=${encodeURIComponent(code)}`;
  const qrData = encodeURIComponent(partnerUrl);
  const qrUrl = qrCodeUrl(qrData, 220);

  const card = el("div", "qr-card");
  card.innerHTML = `
    <img src="${qrUrl}" alt="QR del tuo negozio" class="qr-img" />
    <div class="qr-code">${code}</div>
    <div class="qr-note">Chi lo scansiona apre Touch&amp;Go con il tuo codice partner già applicato — ogni spedizione generata da questo QR viene attribuita a te.</div>`;
  wrap.appendChild(card);

  const downloadBtn = el("button", "btn-secondary", "⬇️ Scarica il QR");
  downloadBtn.addEventListener("click", () => downloadQR(qrUrl, `touchandgo-partner-qr-${code}.png`));
  wrap.appendChild(downloadBtn);

  return wrap;
}

async function downloadQR(qrUrl, filename) {
  try {
    const res = await fetch(qrUrl);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (e) {
    window.open(qrUrl, "_blank", "noopener");
  }
}

function getGPSCoords() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), 6000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { timeout: 5500, maximumAge: 300000 }
    );
  });
}

async function reverseGeocode(lat, lon) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=it`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await res.json();
    const city = data.city || data.locality || data.principalSubdivision;
    if (!city) return null;
    return { city, country: data.countryName };
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

async function locateByGPS() {
  const coords = await getGPSCoords();
  if (!coords) return null;
  return reverseGeocode(coords.lat, coords.lon);
}

async function locateTourist() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch("https://ipapi.co/json/", { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (!data.city) return null;
    return { city: data.city, country: data.country_name };
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

async function cityPhoto(city) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(city)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await res.json();
    return (data.originalimage && data.originalimage.source) || (data.thumbnail && data.thumbnail.source) || null;
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

async function loadLocation() {
  let place = await locateByGPS();
  let source = "gps";
  if (!place) {
    place = await locateTourist();
    source = "ip";
  }
  if (!place) return;
  const photo = await cityPhoto(place.city);
  state.location = place;
  state.locationPhoto = photo;
  state.pickupPoint = place.city;
  state.pickupSource = source;
  if ((state.screen === "cover" || state.screen === "home") && state.mode === "turista") render();
}

// Punto di ritiro scelto a mano dal turista (PickupField) — ha priorità
// sulla rilevazione automatica GPS/rete al prossimo avvio (vedi il
// bootstrap in fondo al file), così chi aggiunge acquisti da una città
// diversa da dove si trova ora non se la vede sovrascrivere ad ogni
// riapertura dell'app. null/assente = nessuna scelta manuale salvata,
// via libera alla rilevazione automatica.
function saveManualPickup(city) {
  try {
    if (city) localStorage.setItem("tg_manual_pickup", city);
    else localStorage.removeItem("tg_manual_pickup");
  } catch (e) {}
}

// Ultime città distinte usate come pickupPoint (manuale o rilevato), più
// recente per prima, max 5 — mostrate come chip rapidi in PickupField.
function getRecentPickups() {
  try {
    const raw = localStorage.getItem("tg_recent_pickups");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((c) => typeof c === "string" && c) : [];
  } catch (e) {
    return [];
  }
}

function addRecentPickup(city) {
  const trimmed = (city || "").trim();
  if (!trimmed) return;
  try {
    const recent = getRecentPickups().filter((c) => c.toLowerCase() !== trimmed.toLowerCase());
    recent.unshift(trimmed);
    localStorage.setItem("tg_recent_pickups", JSON.stringify(recent.slice(0, 5)));
  } catch (e) {}
}

function TrustRow() {
  const row = el("div", "trust-row");
  row.innerHTML = `
    <div class="trust-item"><span class="trust-ic">🛡️</span>${t("trust_coverage")}</div>
    <div class="trust-item"><span class="trust-ic">📍</span>${t("trust_tracked")}</div>
    <div class="trust-item"><span class="trust-ic">✓</span>${t("trust_customs")}</div>`;
  return row;
}

// Chiavi I18N per screenKey già tradotti in questa fase (Home, Destination,
// Analyzing, Result/Options). "queued" e "history" restano in italiano
// fisso finché quelle schermate non vengono migrate.
const ASSISTANT_TIP_KEYS = {
  home: "assistant_home",
  destination: "assistant_destination",
  analyzing: "assistant_analyzing",
  options: "assistant_options",
  result: "assistant_result",
};
const ASSISTANT_TIPS_LEGACY = {
  queued: "Mostra questo QR in negozio quando lasci l'acquisto — il ritiro parte a fine soggiorno.",
  history: "Qui trovi tutti i tuoi acquisti passati e il loro stato di consegna.",
};

function AssistantAvatar(screenKey) {
  if (state.assistantDismissed && state.assistantDismissed[screenKey]) return el("div");
  const tip = ASSISTANT_TIP_KEYS[screenKey] ? t(ASSISTANT_TIP_KEYS[screenKey]) : ASSISTANT_TIPS_LEGACY[screenKey];
  if (!tip) return el("div");

  const wrap = el("div", "assistant-tip");
  wrap.innerHTML = `
    <div class="assistant-avatar">T&amp;G</div>
    <div class="assistant-text">${tip}</div>
    <button class="assistant-dismiss" aria-label="${t("assistant_dismiss_aria")}">✕</button>
  `;
  wrap.querySelector(".assistant-dismiss").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!state.assistantDismissed) state.assistantDismissed = {};
    state.assistantDismissed[screenKey] = true;
    render();
  });
  return wrap;
}

// ---------------- OnboardingScreen (prima apertura, prima della Cover) ----------------
//
// Sequenza animata a 4 slide. Parte in automatico al lancio dell'app per
// chi non ha ancora effettuato l'accesso (registrazione) su questo
// dispositivo (vedi il controllo vicino a loadProfile() più in basso, che
// usa sia state.touristEmail che il flag persistente "tg_onboarded"); una
// volta effettuato l'accesso una prima volta, non riparte più in
// automatico, nemmeno dopo un reset (resetEverything() non tocca
// "tg_onboarded"). Rilanciabile in ogni momento da "Rivedi come funziona"
// in DashboardScreen(), per loggati e non.
//
// A differenza del mockup di riferimento — pensato come demo a loop
// infinito — qui la sequenza ha una vera fine: l'ultima slide, sia per
// timeout automatico che per tap a destra, completa l'onboarding invece
// di tornare alla prima slide.
//
// onboardingSlide/onboardingTimer sono a livello di modulo (non dentro la
// funzione) apposta: quando l'utente cambia lingua, setLang() richiama il
// render() globale che ricostruisce l'intera schermata da zero — tenendo
// l'indice della slide corrente fuori dalla funzione, la sequenza riprende
// esattamente da dove si trovava invece di ripartire dalla prima slide.
let onboardingSlide = 0;
let onboardingTimer = null;
const ONBOARDING_SLIDE_MS = 4200;

function finishOnboarding() {
  clearTimeout(onboardingTimer);
  onboardingSlide = 0;
  state.screen = "cover";
  render();
}

// Richiamabile da qualunque schermata (es. "Rivedi come funziona" nella
// Dashboard) per rivedere l'onboarding su richiesta, sia da loggati che
// da non registrati.
function restartOnboarding() {
  clearTimeout(onboardingTimer);
  onboardingSlide = 0;
  state.screen = "onboarding";
  render();
}

// Le 4 illustrazioni SVG, identiche al mockup di riferimento (stesso
// viewBox, stessi path, stessi colori — #F0C877 = --gold-hot, #E8D5B0 =
// --gold-soft già espressi come valori letterali negli attributi SVG).
const ONBOARDING_ART = [
  `<svg class="ob-art" viewBox="0 0 172 130" fill="none">
    <path d="M64 70C64 58 73 49 85 49C97 49 106 58 106 70V96H64V70Z" stroke="#F0C877" stroke-width="1.5"/>
    <path d="M70 96V102C70 105 73 108 76 108H94C97 108 100 105 100 102V96" stroke="#F0C877" stroke-width="1.5"/>
    <ellipse cx="85" cy="70" rx="14" ry="18" stroke="#F0C877" stroke-width="1.2" opacity=".7"/>
    <rect x="24" y="30" width="34" height="52" rx="5" stroke="#E8D5B0" stroke-width="1.7" transform="rotate(-8 24 30)"/>
    <circle cx="43" cy="65" r="7" stroke="#E8D5B0" stroke-width="1.3" transform="rotate(-8 24 30)"/>
    <path d="M78 24L86 30L94 24M78 36L86 30L94 36" stroke="#F0C877" stroke-width="1.3" opacity=".9"/>
  </svg>`,
  `<svg class="ob-art" viewBox="0 0 172 130" fill="none">
    <path d="M40 90C55 78 62 62 62 52C62 39 51.5 30 40 30C28.5 30 18 39 18 52C18 62 25 78 40 90Z" stroke="#E8D5B0" stroke-width="1.6"/>
    <circle cx="40" cy="52" r="7" stroke="#E8D5B0" stroke-width="1.4"/>
    <path d="M50 78C68 68 84 68 100 74" stroke="#F0C877" stroke-width="1.1" stroke-dasharray="2 4"/>
    <circle cx="122" cy="60" r="26" stroke="#F0C877" stroke-width="1.5"/>
    <path d="M96 60H148M122 34C130 42 134 51 134 60C134 69 130 78 122 86C114 78 110 69 110 60C110 51 114 42 122 34Z" stroke="#F0C877" stroke-width="1"/>
  </svg>`,
  `<svg class="ob-art" viewBox="0 0 172 130" fill="none">
    <rect x="58" y="52" width="52" height="44" rx="2" stroke="#F0C877" stroke-width="1.6"/>
    <path d="M58 66H110M84 52V96" stroke="#F0C877" stroke-width="1"/>
    <circle cx="120" cy="46" r="2" fill="#E8D5B0"/>
    <path d="M120 48V56" stroke="#E8D5B0" stroke-width="1"/>
    <rect x="112" y="56" width="18" height="18" rx="2" stroke="#E8D5B0" stroke-width="1.5"/>
    <rect x="116" y="60" width="4" height="4" fill="#E8D5B0"/><rect x="122" y="60" width="4" height="4" fill="#E8D5B0"/>
    <rect x="116" y="66" width="4" height="4" fill="#E8D5B0"/><rect x="122" y="66" width="4" height="4" fill="#E8D5B0"/>
  </svg>`,
  `<svg class="ob-art" viewBox="0 0 172 130" fill="none">
    <rect x="22" y="30" width="26" height="22" rx="2" stroke="#E8D5B0" stroke-width="1.3" opacity=".8"/>
    <rect x="124" y="24" width="26" height="22" rx="2" stroke="#E8D5B0" stroke-width="1.3" opacity=".8"/>
    <rect x="30" y="66" width="24" height="20" rx="2" stroke="#E8D5B0" stroke-width="1.3" opacity=".8"/>
    <path d="M46 50L74 66M140 44L104 62M50 76L74 70" stroke="#F0C877" stroke-width="1.1" stroke-dasharray="2 3"/>
    <rect x="66" y="62" width="42" height="34" rx="3" stroke="#F0C877" stroke-width="1.8"/>
    <path d="M66 74H108M87 62V96" stroke="#F0C877" stroke-width="1"/>
  </svg>`,
];

// Stat-chip mostrato solo sulla prima e sull'ultima slide (numeri reali:
// 3 secondi per la stima AI, 1 solo ordine di ritiro consolidato).
const ONBOARDING_STATS = {
  0: { val: "3s", key: "onboarding_stat0" },
  3: { val: "1", key: "onboarding_stat3" },
};

function OnboardingScreen() {
  clearTimeout(onboardingTimer);
  const total = ONBOARDING_ART.length;
  let current = Math.min(Math.max(onboardingSlide, 0), total - 1);

  const stage = el("div", "ob-stage");

  const liveTag = el("div", "ob-live-tag");
  liveTag.innerHTML = `<span class="ob-dot-pulse"></span><span>${t("onboarding_live")}</span>`;
  stage.appendChild(liveTag);

  const topRight = el("div", "ob-top-right");
  const langGroup = el("div", "ob-lang-group");
  langGroup.innerHTML = `
    <button class="ob-lang-btn ${state.lang === "it" ? "on" : ""}" data-lang="it" aria-label="Italiano">IT</button>
    <button class="ob-lang-btn ${state.lang === "en" ? "on" : ""}" data-lang="en" aria-label="English">EN</button>`;
  langGroup.querySelectorAll("[data-lang]").forEach((b) =>
    b.addEventListener("click", () => setLang(b.dataset.lang))
  );
  topRight.appendChild(langGroup);
  const skipBtn = el("button", "ob-skip-btn", t("onboarding_skip"));
  skipBtn.addEventListener("click", finishOnboarding);
  topRight.appendChild(skipBtn);
  stage.appendChild(topRight);

  // Wordmark del brand, persistente su tutte le slide (fuori dal ciclo delle
  // singole slide, stesso principio della barra di progresso e del toggle
  // lingua): oggi "Touch&Go" non compariva mai a schermo in questa sequenza,
  // solo nel <title> della pagina. Riga propria sotto live-tag/lingua e sopra
  // la barra di progresso per non contendersi lo spazio orizzontale con loro
  // su viewport stretti.
  const wordmark = el("div", "ob-wordmark", "Touch&Go");
  stage.appendChild(wordmark);

  const progressWrap = el("div", "ob-progress");
  const segments = [];
  for (let i = 0; i < total; i++) {
    const seg = el("div", "ob-seg");
    seg.innerHTML = `<div class="ob-fill"></div>`;
    progressWrap.appendChild(seg);
    segments.push(seg);
  }
  stage.appendChild(progressWrap);

  const tapLeft = el("div", "ob-tap-zone ob-left");
  const tapRight = el("div", "ob-tap-zone ob-right");
  stage.appendChild(tapLeft);
  stage.appendChild(tapRight);

  const slides = [];
  for (let i = 0; i < total; i++) {
    const slide = el("div", "ob-slide");
    const stepLabel = String(i + 1).padStart(2, "0") + " / 0" + total;
    const stat = ONBOARDING_STATS[i];
    slide.innerHTML = `
      <div class="ob-step-num">${stepLabel}</div>
      <div class="ob-art-wrap"><div class="ob-art-glow"></div>${ONBOARDING_ART[i]}</div>
      ${stat ? `<div class="ob-stat-chip"><span class="ob-n">${stat.val}</span><span class="ob-l">${t(stat.key)}</span></div>` : ""}
      <div class="ob-eyebrow">${t("onboarding_eyebrow")}</div>
      <h2>${t("onboarding_t" + i)}</h2>
      <p>${t("onboarding_p" + i)}</p>`;
    stage.appendChild(slide);
    slides.push(slide);
  }

  const dotsWrap = el("div", "ob-dots");
  for (let i = 0; i < total; i++) {
    dotsWrap.appendChild(el("div", "ob-d"));
  }
  stage.appendChild(dotsWrap);
  const dots = dotsWrap.querySelectorAll(".ob-d");

  function renderSlideState() {
    onboardingSlide = current;
    slides.forEach((s, i) => s.classList.toggle("active", i === current));
    dots.forEach((d, i) => d.classList.toggle("active", i === current));
    segments.forEach((seg, i) => {
      const fill = seg.querySelector(".ob-fill");
      if (i < current) {
        fill.style.transition = "none";
        fill.style.width = "100%";
      } else if (i === current) {
        fill.style.transition = "none";
        fill.style.width = "0%";
        requestAnimationFrame(() => {
          fill.style.transition = `width ${ONBOARDING_SLIDE_MS}ms linear`;
          fill.style.width = "100%";
        });
      } else {
        fill.style.transition = "none";
        fill.style.width = "0%";
      }
    });
  }

  function scheduleNext() {
    clearTimeout(onboardingTimer);
    onboardingTimer = setTimeout(nextSlide, ONBOARDING_SLIDE_MS);
  }

  function nextSlide() {
    if (current >= total - 1) {
      finishOnboarding();
      return;
    }
    current += 1;
    renderSlideState();
    scheduleNext();
  }

  function prevSlide() {
    if (current <= 0) {
      scheduleNext();
      return;
    }
    current -= 1;
    renderSlideState();
    scheduleNext();
  }

  tapLeft.addEventListener("click", prevSlide);
  tapRight.addEventListener("click", nextSlide);

  renderSlideState();
  scheduleNext();

  return stage;
}

function CoverScreen() {
  const wrap = el("div", "cover-screen");
  if (state.locationPhoto) {
    wrap.classList.add("has-photo");
    // Layer di sfondo separato dal testo apposta: il filtro SVG
    // "schizzo architettonico" (filter:url(#sketchFilter), vedi CSS) si
    // applica solo a questo div, mai alla didascalia sopra — altrimenti
    // il testo verrebbe distorto dal rilevamento bordi insieme alla foto.
    const bgPhoto = el("div", "cover-bg-photo");
    bgPhoto.style.backgroundImage = `url('${state.locationPhoto}')`;
    wrap.appendChild(bgPhoto);
  } else {
    wrap.classList.add("no-photo");
  }
  wrap.appendChild(el("div", "cover-caption", `${t("cover_pickup_detected")}<br><span>${state.pickupPoint}</span>`));
  wrap.appendChild(el("div", "cover-tap", t("cover_tap")));
  wrap.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  return wrap;
}

// Icona a iride/diaframma fotografico (TOU-20, sostituisce la vecchia
// emoji 📷 nel riquadro placeholder pre-tap) — 6 lamelle reali (non
// un'immagine raster), ognuna un <path> identico ruotato in slot da 60°
// via l'attributo SVG transform (posizione fissa). L'apertura/chiusura è
// invece un secondo transform CSS sul singolo <path>, con transform-origin
// sulla punta esterna della lamella (non sul centro dell'icona): è quello
// il perno su cui una lamella reale ruota, così la punta interna spazza
// verso il centro invece che l'intera lamella ruotare rigidamente attorno
// al centro come farebbe una girandola. Vedi .aperture-icon/.aperture-blade
// in style.css per l'animazione (classe "closing" aggiunta via JS).
const APERTURE_BLADE_D = "M 50,4 L 93.2,34.3 L 66.1,27.1 Z";
function apertureIconMarkup() {
  const blades = [0, 60, 120, 180, 240, 300]
    .map((deg) => `<g transform="rotate(${deg} 50 50)"><path class="aperture-blade" d="${APERTURE_BLADE_D}"/></g>`)
    .join("");
  return `<svg class="aperture-icon" viewBox="0 0 100 100" aria-hidden="true">${blades}</svg>`;
}

function HomeScreen() {
  const wrap = el("div");
  wrap.appendChild(AssistantAvatar("home"));
  wrap.appendChild(TrustRow());

  if (state.pickupSource !== "gps" && !state.locationReminderDismissed) {
    const loc = el("div", "location-reminder");
    loc.innerHTML = `
      <div class="loc-avatar">📍</div>
      <div class="loc-text"><b>${t("loc_reminder_title")}</b><br/>${t("loc_reminder_text")}</div>
      <button class="loc-dismiss" aria-label="${t("loc_reminder_dismiss_aria")}">✕</button>`;
    loc.querySelector(".loc-dismiss").addEventListener("click", () => {
      state.locationReminderDismissed = true;
      render();
    });
    loc.querySelector(".loc-avatar").addEventListener("click", () => loadLocation());
    wrap.appendChild(loc);
  }

  if (state.pendingItems.length > 0) {
    const banner = el("div", "pending-banner");
    const pendingItemWord = state.pendingItems.length === 1 ? t("home_pending_item_singular") : t("home_pending_item_plural");
    banner.innerHTML = `<div class="pending-count">🧳 ${state.pendingItems.length} ${pendingItemWord} ${t("home_pending_suffix")}</div>
      <div class="pending-sub">${t("home_pending_sub")}</div>`;
    const concludeBtn = el("button", "btn-secondary", t("home_conclude_btn"));
    concludeBtn.addEventListener("click", () => {
      state.screen = "conclude";
      render();
    });
    banner.appendChild(concludeBtn);
    wrap.appendChild(banner);
  }

  if (state.error) {
    wrap.appendChild(el("div", "alert", `⚠️ ${state.error}`));
  }

  const section = el("div", "section");
  if (state.touristName) {
    section.appendChild(el("div", "greeting", `${t("home_greeting")}, ${state.touristName}`));
  }
  section.appendChild(el("div", "step-lbl", t("home_step1_lbl")));
  const captureCard = el("div", "capture-card");
  captureCard.innerHTML = `
    <div class="capture-icon">${apertureIconMarkup()}</div>
    <h3>${t("home_capture_title")}</h3>
    <p>${t("capture_tap_camera")}</p>`;
  const cameraInput = el("input");
  cameraInput.type = "file";
  cameraInput.accept = "image/*";
  cameraInput.capture = "environment";
  cameraInput.style.display = "none";
  cameraInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
  captureCard.appendChild(cameraInput);
  // TOU-20 (Giuseppe): l'iride va mostrata aperta prima del tap e chiudersi
  // "nel momento dello scatto", in sincrono col rumore dell'otturatore.
  // L'unico "scatto" che questo riquadro placeholder può davvero mostrare è
  // il tap che lo apre (il vero pulsante di scatto vive dentro l'overlay a
  // schermo intero del mirino, dove questa icona non è più visibile) — Code
  // interpreta quindi "lo scatto" come questo tap: chiude l'iride e riproduce
  // il suono qui, poi apre la fotocamera come "passo successivo del flusso",
  // esattamente come descritto da Giuseppe. Il ritardo (uguale alla durata
  // della transizione CSS, .aperture-icon.closing) lascia vedere l'animazione
  // prima di passare al mirino vero e proprio.
  captureCard.addEventListener("click", () => {
    const icon = captureCard.querySelector(".aperture-icon");
    if (icon) icon.classList.add("closing");
    playShutterSound();
    setTimeout(() => openCameraViewfinder(handleImageDataUrl, cameraInput), 230);
  });
  section.appendChild(captureCard);

  const galleryCard = el("div", "gallery-card");
  galleryCard.innerHTML = `<span>${t("home_gallery_choose")}</span>`;
  const galleryInput = el("input");
  galleryInput.type = "file";
  galleryInput.accept = "image/*";
  galleryInput.style.display = "none";
  galleryInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
  galleryCard.appendChild(galleryInput);
  galleryCard.addEventListener("click", () => galleryInput.click());
  section.appendChild(galleryCard);

  const describeBox = el("div", "describe-box");
  const describeLbl = el("div", "tg-lbl", t("home_describe_lbl"));
  const input = el("input");
  input.type = "text";
  input.placeholder = t("home_describe_placeholder");
  const goBtn = el("button", null, "→");
  goBtn.addEventListener("click", () => {
    if (input.value.trim()) handleDescribe(input.value.trim());
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) handleDescribe(input.value.trim());
  });
  describeBox.appendChild(input);
  describeBox.appendChild(goBtn);
  section.appendChild(describeLbl);
  section.appendChild(describeBox);

  const foot = el("div", "home-foot", t("home_foot"));
  section.appendChild(foot);

  if (!state.promoValid) {
    if (!state.showPromoInput) {
      const promoLink = el("div", "promo-link", t("home_promo_link"));
      promoLink.addEventListener("click", () => {
        state.showPromoInput = true;
        render();
      });
      section.appendChild(promoLink);
    } else {
      const promoBox = el("div", "describe-box");
      const promoInput = el("input");
      promoInput.type = "text";
      promoInput.placeholder = t("home_promo_placeholder");
      promoInput.value = state.promoCode || "";
      const promoGo = el("button", null, "→");
      promoGo.addEventListener("click", () => {
        if (promoInput.value.trim()) checkPromoCode(promoInput.value.trim());
      });
      promoInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && promoInput.value.trim()) checkPromoCode(promoInput.value.trim());
      });
      promoBox.appendChild(promoInput);
      promoBox.appendChild(promoGo);
      section.appendChild(promoBox);
      if (state.promoChecked && !state.promoValid) {
        section.appendChild(el("div", "promo-invalid", t("code_invalid_generic")));
      }
    }
  } else {
    section.appendChild(el("div", "promo-active-note", t("home_promo_active", { code: state.promoCode })));
  }

  wrap.appendChild(section);

  return wrap;
}

function DestinationScreen() {
  const wrap = el("div", "section");
  wrap.appendChild(AssistantAvatar("destination"));
  const back = el("div", "back", t("dest_back"));
  back.addEventListener("click", () => {
    state.screen = "home";
    state.pendingInput = null;
    render();
  });
  wrap.appendChild(back);

  if (state.error) {
    wrap.appendChild(el("div", "alert", `⚠️ ${state.error}`));
  }

  wrap.appendChild(el("div", "step-lbl", t("dest_step2_lbl")));

  if (state.pendingInput && state.pendingInput.type === "image") {
    const preview = el("img", "capture-preview");
    preview.src = state.pendingInput.dataUrl;
    wrap.appendChild(preview);
  } else if (state.pendingInput && state.pendingInput.type === "text") {
    wrap.appendChild(el("div", "pending-desc", `"${state.pendingInput.label}"`));
  }

  wrap.appendChild(PickupField());
  wrap.appendChild(DestinationField());

  const note = el("div", "home-foot", t("dest_note"));
  wrap.appendChild(note);

  const goBtn = el("button", "btn-primary", t("dest_go_btn"));
  goBtn.addEventListener("click", () => {
    if (!state.pendingInput) return;
    if (state.isOffline) {
      state.error = t("dest_error_offline");
      render();
      return;
    }
    const promise =
      state.pendingInput.type === "image"
        ? classifyImage(state.pendingInput.base64, state.pendingInput.mediaType)
        : classifyText(state.pendingInput.label);
    runClassification(promise);
  });
  wrap.appendChild(goBtn);

  return wrap;
}

function PickupField() {
  const wrap = el("div");
  const field = el("div", "dest-field");
  const label =
    state.pickupSource === "gps"
      ? t("pickup_lbl_gps")
      : state.pickupSource === "ip"
      ? t("pickup_lbl_ip")
      : t("pickup_lbl_default");
  field.innerHTML = `
    <div class="dest-lbl">${label}</div>
    <input class="dest-input" id="pickup-input" value="${state.pickupPoint}" />`;
  const input = field.querySelector("#pickup-input");
  input.addEventListener("input", (e) => {
    state.pickupPoint = e.target.value;
    state.pickupSource = null;
    saveManualPickup(state.pickupPoint);
  });
  // Al blur (non ad ogni tasto, per non riempire l'elenco di città a
  // metà digitate) il valore commesso entra tra le città recenti — e si
  // ri-renderizza per aggiornare i chip, sicuro solo ora che il campo ha
  // perso il focus.
  input.addEventListener("blur", () => {
    addRecentPickup(state.pickupPoint);
    render();
  });
  wrap.appendChild(field);

  const useLocBtn = el("button", "pickup-use-location", t("pickup_use_location"));
  useLocBtn.type = "button";
  useLocBtn.addEventListener("click", async () => {
    saveManualPickup(null);
    useLocBtn.disabled = true;
    useLocBtn.textContent = t("pickup_locating");
    await loadLocation();
    addRecentPickup(state.pickupPoint);
    render();
  });
  wrap.appendChild(useLocBtn);

  const recent = getRecentPickups().filter(
    (c) => c.trim().toLowerCase() !== (state.pickupPoint || "").trim().toLowerCase()
  );
  if (recent.length) {
    const chipsWrap = el("div", "pickup-chips");
    chipsWrap.appendChild(el("div", "pickup-chips-lbl", t("pickup_recent_lbl")));
    const chipsRow = el("div", "pickup-chips-row");
    recent.forEach((city) => {
      const chip = el("button", "pickup-chip", city);
      chip.type = "button";
      chip.addEventListener("click", () => {
        state.pickupPoint = city;
        state.pickupSource = null;
        saveManualPickup(city);
        addRecentPickup(city);
        render();
      });
      chipsRow.appendChild(chip);
    });
    chipsWrap.appendChild(chipsRow);
    wrap.appendChild(chipsWrap);
  }

  wrap.appendChild(el("div", "pickup-note", t("pickup_note")));
  return wrap;
}

function InfoSection() {
  const wrap = el("div", "section info-section");

  wrap.appendChild(el("div", "tg-lbl", "Come funziona il prezzo"));
  const priceInfo = el("div", "info-card");
  priceInfo.innerHTML = `
    <div class="info-row"><span>Fee di servizio Touch&amp;Go</span><b>€39</b></div>
    <div class="info-row"><span>Costo servizio di spedizione (varia per peso/destinazione)</span><b>calcolato all'istante</b></div>
    <div class="info-row"><span>Nessun costo nascosto: vedi il totale prima di confermare</span></div>
    <div class="info-line" style="margin-top:8px">🎁 <b>Prima spedizione senza fee di servizio</b> — paghi solo il servizio di spedizione, a tariffa piena. Un modo per provare il servizio prima di scegliere se abbonarti.</div>`;
  wrap.appendChild(priceInfo);

  wrap.appendChild(el("div", "tg-lbl", "Copertura e dogana"));
  const coverage = el("div", "info-card");
  coverage.innerHTML = `
    <div class="info-line">🛡️ Copertura assicurativa standard inclusa in ogni spedizione; copertura estesa disponibile su richiesta per articoli di alto valore.</div>
    <div class="info-line">📄 Documentazione doganale (MRN/DAE) ed esenzione IVA export (art. 8 DPR 633/72) generate automaticamente — nessuna pratica in aeroporto.</div>
    <div class="info-line">📍 Tracciamento in tempo reale via WhatsApp, disponibile in 180+ Paesi.</div>`;
  wrap.appendChild(coverage);

  return wrap;
}

function AnalyzingScreen() {
  const wrap = el("div", "analyzing");
  wrap.appendChild(AssistantAvatar("analyzing"));
  const spinnerBlock = el("div");
  spinnerBlock.innerHTML = `<div class="spinner"></div><p>${t("analyzing_text")}</p>`;
  wrap.appendChild(spinnerBlock);
  return wrap;
}

function ResultScreen() {
  const r = state.result;
  const p = state.price;
  const q = p.quotes || priceQuotes(r.weight_kg, currentDestinationName(), r);
  const wrap = el("div");
  wrap.appendChild(AssistantAvatar("result"));
  wrap.appendChild(AssistantAvatar("options"));

  const topbar = el("div", "topbar");
  const back = el("button", "back", "←");
  back.addEventListener("click", () => {
    state.screen = "home";
    state.pendingInput = null;
    render();
  });
  topbar.appendChild(back);
  topbar.appendChild(el("h2", null, t("result_step3_lbl")));
  wrap.appendChild(topbar);

  const card = el("div", "result-card");
  const top = el("div", "result-top");
  top.innerHTML = `
    <span class="confidence">${t("result_identified", { confidence: t("confidence_" + (r.confidence || "alta")) })}</span>
    <div class="result-title" id="res-title"></div>
    <div class="result-sub" id="res-sub"></div>`;
  card.appendChild(top);

  const grid = el("div", "result-grid");
  const pkg = packagedDimensions(r);
  const objDims = r.length_cm && r.width_cm && r.height_cm ? formatDims(r.length_cm, r.width_cm, r.height_cm) : "—";
  grid.innerHTML = `
    <div><div class="result-lbl">${t("result_lbl_weight")}</div><div class="result-val">${r.weight_kg ?? "—"} kg</div></div>
    <div><div class="result-lbl">${t("result_lbl_obj_dims")}</div><div class="result-val">${objDims}</div></div>
    <div><div class="result-lbl">${t("result_lbl_pkg_dims")}</div><div class="result-val">${pkg ? formatDims(pkg.l, pkg.w, pkg.h) : "—"}</div></div>
    <div><div class="result-lbl">${t("result_lbl_fragile")}</div><div class="result-val ${r.fragile ? "warn" : ""}">${r.fragile ? t("result_fragile_yes") : t("result_fragile_no")}</div></div>
    <div><div class="result-lbl">${t("result_lbl_pickup_from")}</div><div class="result-val">${state.pickupPoint}</div></div>
    <div><div class="result-lbl">${t("result_lbl_destination")}</div><div class="result-val">${
      getSelectedAddress() ? formatAddress(getSelectedAddress()) : destinationDisplayName(state.guestDestinationCountry) || "—"
    }</div></div>`;
  card.appendChild(grid);

  const hs = el("div", "hs-block");
  hs.innerHTML = `
    <div class="hs-left"><div class="hs-lbl">${t("result_lbl_hs_code")}</div><div class="hs-code" id="res-hscode"></div></div>
    <div class="hs-desc" id="res-desc"></div>`;
  card.appendChild(hs);
  wrap.appendChild(card);

  const shippingNote = localizeShippingNote(r);
  if (shippingNote) {
    const tip = el("div", "tip", `💡 ${shippingNote}`);
    wrap.appendChild(tip);
  }

  if (r.value_eur > 500 || r.confidence === "bassa") {
    const secure = el("div", "secure-note", t("result_secure_note"));
    wrap.appendChild(secure);
  }

  let priceCard;
  const onBreakeven = state.promoValid && !state.promoRedeemedThisOrder;
  const isFirstEverShipment = state.purchaseHistory.length === 0;
  const firstTimeFree = !onBreakeven && !state.isSubscribed && isFirstEverShipment;

  if (onBreakeven && !state.priceConfirmedForThisResult) {
    const promo = el("div", "promo-card-inline");
    promo.innerHTML = `
      <div class="promo-badge">${t("result_promo_badge_breakeven", { code: state.promoCode })}</div>
      <div class="promo-headline-inline">${t("result_promo_headline_breakeven")}</div>
      <div class="promo-price-row">
        <span class="promo-price-new">€${q.breakeven.toFixed(2)}</span>
        <span class="promo-price-old">€${q.full.toFixed(2)}</span>
      </div>
      <div class="info-row waived"><span>${t("result_fee_service")}</span><b>€0</b></div>
      <div class="info-row"><span>${t("result_shipping_intl")}</span><b>€${q.shipping.toFixed(2)}</b></div>
      <div class="promo-note-inline">${t("result_promo_note_breakeven")}</div>`;
    const promoBtn = el("button", "btn-primary", t("result_promo_btn_activate"));
    promoBtn.addEventListener("click", () => {
      state.price = { grandTotal: q.breakeven, eta: q.eta, quotes: q };
      state.priceConfirmedForThisResult = true;
      state.priceConfirmedAsBreakeven = true;
      render();
    });
    promo.appendChild(promoBtn);
    wrap.appendChild(promo);
  } else if (firstTimeFree && !state.priceConfirmedForThisResult) {
    const promo = el("div", "promo-card-inline");
    promo.innerHTML = `
      <div class="promo-badge">${t("result_promo_badge_firsttime")}</div>
      <div class="promo-headline-inline">${t("result_promo_headline_firsttime")}</div>
      <div class="promo-price-row">
        <span class="promo-price-new">€${q.breakeven.toFixed(2)}</span>
        <span class="promo-price-old">€${q.full.toFixed(2)}</span>
      </div>
      <div class="info-row waived"><span>${t("result_fee_service")}</span><b>€0</b></div>
      <div class="info-row"><span>${t("result_shipping_intl")}</span><b>€${q.shipping.toFixed(2)}</b></div>
      <div class="promo-note-inline">${t("result_promo_note_firsttime")}</div>`;
    const promoBtn = el("button", "btn-primary", t("result_promo_btn_activate"));
    promoBtn.addEventListener("click", () => {
      state.price = { grandTotal: q.breakeven, eta: q.eta, quotes: q };
      state.priceConfirmedForThisResult = true;
      state.priceConfirmedAsBreakeven = true;
      render();
    });
    promo.appendChild(promoBtn);
    wrap.appendChild(promo);
  } else if (!state.isSubscribed && !state.priceConfirmedForThisResult) {
    const dual = el("div", "price-dual");
    dual.innerHTML = `<div class="tg-lbl" style="margin-bottom:10px">${t("result_dual_choose")}</div>`;
    const optFull = el("div", "price-option");
    optFull.innerHTML = `
      <div class="price-option-lbl">${t("result_price_full_lbl")}</div>
      <div class="price-option-total">€${q.full.toFixed(2)}</div>
      <div class="price-option-note">${t("result_price_full_note", { fee: FULL_FEE, shipping: q.shipping.toFixed(2) })}</div>`;
    const fullBtn = el("button", "btn-secondary", t("result_price_full_btn"));
    fullBtn.addEventListener("click", () => {
      state.price = { grandTotal: q.full, eta: q.eta, quotes: q };
      state.priceConfirmedForThisResult = true;
      render();
    });
    optFull.appendChild(fullBtn);
    dual.appendChild(optFull);

    const optSub = el("div", "price-option highlight");
    optSub.innerHTML = `
      <div class="price-option-lbl">${t("result_price_sub_lbl")}</div>
      <div class="price-option-total">€${q.subscribed.toFixed(2)}</div>
      <div class="price-option-note">${t("result_price_sub_note", { fee: SUBSCRIBED_FEE, shipping: q.shipping.toFixed(2) })}</div>`;
    const subBtn = el("button", "btn-primary", t("result_price_sub_btn"));
    subBtn.addEventListener("click", () => {
      state.isSubscribed = true;
      saveProfile();
      state.price = { grandTotal: q.subscribed, eta: q.eta, quotes: q };
      state.priceConfirmedForThisResult = true;
      render();
    });
    optSub.appendChild(subBtn);
    dual.appendChild(optSub);
    wrap.appendChild(dual);
  } else {
    const fee = state.priceConfirmedAsBreakeven ? 0 : state.isSubscribed ? SUBSCRIBED_FEE : FULL_FEE;
    const discount = state.partnerDiscountApplied ? state.partnerDiscountAmount : 0;
    const quoteSuffix = state.priceConfirmedAsBreakeven
      ? t("result_quote_suffix_breakeven")
      : state.isSubscribed
      ? t("result_quote_suffix_subscribed")
      : "";
    priceCard = el("div", "price-card");
    priceCard.innerHTML = `
      <div class="tg-lbl" style="margin-bottom:10px">${t("result_quote_title")} ${quoteSuffix}</div>
      <div class="info-row"><span>${t("result_fee_service")}</span><b>€${fee}</b></div>
      ${discount > 0 ? `<div class="info-row"><span>${t("result_discount_lbl", { code: state.partnerDiscountCode })}</span><b>-€${discount.toFixed(2)}</b></div>` : ""}
      <div class="info-row"><span>${t("result_shipping_intl")}</span><b>€${q.shipping.toFixed(2)}</b></div>
      <div class="info-row total"><span>${t("result_total_lbl")}</span><b id="res-total">€0</b></div>
      <div class="info-line" style="margin-top:8px">${t("result_delivery_note", { eta: localizeEta(q.eta) })}</div>`;
    wrap.appendChild(priceCard);
    if (fee > 0) {
      wrap.appendChild(PartnerDiscountField(fee));
    }
  }

  // Il prezzo qui è sempre e solo una STIMA per la spedizione di questo
  // singolo oggetto — nessun addebito reale (o simulato) avviene in questo
  // punto del flusso, qualunque sia il ramo di prezzo mostrato sopra (dual
  // pricing, breakeven, prima spedizione gratuita). Il calcolo definitivo
  // (consolidato se il turista aggiunge altri oggetti verso la stessa
  // destinazione — vedi consolidatedGroupPrice()) e il momento del
  // pagamento (anche solo simulato oggi) sono SOLO in ConcludeScreen — vedi
  // il commento lì sopra confirmBtn e MANUALE.md, sezione "Punto di
  // integrazione pagamento futuro".
  const estimateNote = el("div", "info-line");
  estimateNote.innerHTML = `<b>${t("result_estimate_badge")}</b> — ${t("result_estimate_note")}`;
  wrap.appendChild(estimateNote);

  const actions = el("div", "result-actions");
  const bookBtn = el("button", "btn-primary", t("result_qr_btn"));
  bookBtn.addEventListener("click", () => {
    state.screen = "choose-address";
    render();
  });
  actions.appendChild(bookBtn);

  const restart = el("button", "btn-secondary", t("result_restart_btn"));
  restart.addEventListener("click", () => {
    state.screen = "home";
    state.error = null;
    state.pendingInput = null;
    render();
  });
  actions.appendChild(restart);
  wrap.appendChild(actions);

  return wrap;
}

// Campo "Hai un codice sconto partner?" nella schermata di conferma
// prezzo — stesso pattern del codice invito in HomeScreen (link che apre
// un piccolo input), ma valida/consuma il codice tramite
// partner-discount.js invece di promo.js.
function PartnerDiscountField(fee) {
  const wrap = el("div");

  if (state.partnerDiscountApplied) {
    wrap.appendChild(
      el(
        "div",
        "promo-active-note",
        t("result_partner_discount_applied", { code: state.partnerDiscountCode, amount: state.partnerDiscountAmount.toFixed(2) })
      )
    );
    return wrap;
  }

  if (!state.showPartnerDiscountInput) {
    const link = el("div", "promo-link", t("result_partner_discount_link"));
    link.addEventListener("click", () => {
      state.showPartnerDiscountInput = true;
      render();
    });
    wrap.appendChild(link);
    return wrap;
  }

  const box = el("div", "describe-box");
  const input = el("input");
  input.type = "text";
  input.placeholder = t("result_partner_discount_placeholder");
  input.value = state.partnerDiscountCodeInput || "";
  input.addEventListener("input", (e) => {
    state.partnerDiscountCodeInput = e.target.value;
  });
  const go = el("button", null, state.partnerDiscountChecking ? "…" : "→");
  go.disabled = state.partnerDiscountChecking;
  const submit = () => {
    const code = (input.value || "").trim();
    if (!code || state.partnerDiscountChecking) return;
    applyPartnerDiscountCode(code, fee);
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  box.appendChild(input);
  box.appendChild(go);
  wrap.appendChild(box);

  if (state.partnerDiscountError) {
    wrap.appendChild(el("div", "promo-invalid", state.partnerDiscountError));
  }

  return wrap;
}

async function applyPartnerDiscountCode(code, fee) {
  state.partnerDiscountChecking = true;
  state.partnerDiscountError = null;
  render();
  try {
    const res = await fetch("/.netlify/functions/partner-discount", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "redeem", code, fee, touristEmail: state.touristEmail }),
    });
    const data = await res.json();
    if (data.valid) {
      state.partnerDiscountApplied = true;
      state.partnerDiscountCode = code.trim().toUpperCase();
      state.partnerDiscountAmount = data.discountAmount || 0;
      if (state.price) {
        state.price.grandTotal = Math.max(0, Math.round((state.price.grandTotal - state.partnerDiscountAmount) * 100) / 100);
      }
    } else {
      state.partnerDiscountError = data.error || t("partner_discount_error_default");
    }
  } catch (e) {
    state.partnerDiscountError = t("partner_discount_error_connection");
  }
  state.partnerDiscountChecking = false;
  render();
}

// ---------------- Reveal animations ----------------

function typewriter(elNode, text, speed = 18) {
  return new Promise((resolve) => {
    if (!text) return resolve();
    let i = 0;
    elNode.textContent = "";
    elNode.classList.add("caret");
    const tick = () => {
      elNode.textContent = text.slice(0, i + 1);
      i++;
      if (i < text.length) {
        setTimeout(tick, speed);
      } else {
        elNode.classList.remove("caret");
        resolve();
      }
    };
    tick();
  });
}

function countUp(elNode, target, duration = 600) {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const val = (target * progress).toFixed(2);
      elNode.textContent = `€${val}`;
      if (progress < 1) requestAnimationFrame(step);
      else {
        elNode.textContent = `€${target}`;
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

async function animateResult(r, p) {
  const title = document.getElementById("res-title");
  const sub = document.getElementById("res-sub");
  const hscode = document.getElementById("res-hscode");
  const desc = document.getElementById("res-desc");
  const total = document.getElementById("res-total");
  if (!title) return;
  await typewriter(title, localizeObjectName(r), 16);
  await typewriter(sub, `${r.object_en || ""} · ${localizeCategory(r.category) || ""}`, 8);
  await typewriter(hscode, r.hs_code || "——", 60);
  await typewriter(desc, localizeHsDescription(r), 8);
  if (total) await countUp(total, p.grandTotal, 700);
}

function syncPurchaseToCRM(item) {
  const payload = item.touristEmail ? item : Object.assign({}, item, { touristEmail: state.touristEmail });
  fetch("/.netlify/functions/save-purchase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Offline or server unavailable — the purchase still lives in the
    // tourist's local history; it just won't appear centrally until
    // the next successful sync attempt.
  });
}

// Registra centralmente il record del gruppo di spedizione consolidato
// (ConcludeScreen, save-shipment-group.js) — stesso pattern "fire and
// forget" di syncPurchaseToCRM: un fallimento di rete non deve bloccare il
// flusso del turista, il gruppo resta comunque visibile localmente in
// ShippedScreen.
function saveShipmentGroupToCRM(group) {
  fetch("/.netlify/functions/save-shipment-group", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(group),
  }).catch(() => {});
}

function historyStatusClass(status) {
  if (status === "ritirato") return "done";
  if (status === "ritiro richiesto") return "requested";
  if (status === "in confezionamento") return "packaging";
  return "pending";
}

// Applica sull'oggetto locale i campi eventualmente aggiornati lato CRM
// (es. lo staff ha inviato l'oggetto a confezionamento o ha cambiato il
// punto di ritiro da un altro dispositivo). Ritorna true se qualcosa è
// cambiato, per sapere se salvare/ri-renderizzare.
function applyRemotePurchaseUpdate(local, remote) {
  let changed = false;
  ["status", "pickupPoint", "pickupPointChanged", "pickupPointChangedAt", "previousPickupPoint", "packagingDispatch", "pickupRequestedAt", "deliveryConfirmedAt"].forEach((key) => {
    if (remote[key] !== undefined && JSON.stringify(remote[key]) !== JSON.stringify(local[key])) {
      local[key] = remote[key];
      changed = true;
    }
  });
  return changed;
}

// Allinea localmente lo stato degli acquisti già noti con quanto
// aggiornato nel frattempo dallo staff nel CRM (invio a confezionamento,
// cambio punto di ritiro). Chiamata all'avvio e ogni volta che il turista
// apre lo storico acquisti — è così che il banner "punto di ritiro
// aggiornato" compare quando il turista riapre l'app.
async function syncPurchaseUpdatesFromCRM() {
  const ids = state.purchaseHistory.map((it) => it.id).filter(Boolean);
  if (!ids.length) return;
  try {
    const res = await fetch("/.netlify/functions/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get-purchases", ids }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const byId = {};
    (data.items || []).forEach((it) => {
      if (it && it.id) byId[it.id] = it;
    });
    let changed = false;
    state.purchaseHistory.forEach((local) => {
      const remote = byId[local.id];
      if (remote && applyRemotePurchaseUpdate(local, remote)) changed = true;
    });
    state.pendingItems.forEach((local) => {
      const remote = byId[local.id];
      if (remote && applyRemotePurchaseUpdate(local, remote)) changed = true;
    });
    if (changed) {
      saveHistory();
      savePending();
      render();
    }
  } catch (e) {
    // Offline o server irraggiungibile — lo storico locale resta quello
    // che era, si riproverà al prossimo avvio/apertura dello storico.
  }
}

// A differenza di syncPurchaseUpdatesFromCRM() sopra — che aggiorna solo
// lo STATO di acquisti già noti localmente, cercandoli per id — questa
// funzione scopre acquisti che esistono già nel database ma non sono mai
// stati salvati su QUESTO dispositivo (cambio telefono, dati del browser
// puliti, acquisto creato/associato da un altro dispositivo con la
// stessa email). Chiamata all'avvio, dopo che loadProfile()/loadHistory()
// hanno già popolato state.touristEmail/state.purchaseHistory.
async function discoverPurchasesByEmail() {
  if (!state.touristEmail) return;
  try {
    const res = await fetch("/.netlify/functions/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get-purchases-by-email", email: state.touristEmail }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const knownIds = new Set(state.purchaseHistory.map((it) => it.id));
    let added = false;
    (data.items || []).forEach((it) => {
      if (it && it.id && !knownIds.has(it.id)) {
        state.purchaseHistory.push(it);
        knownIds.add(it.id);
        added = true;
      }
    });
    if (added) {
      saveHistory();
      render();
    }
  } catch (e) {
    // Offline o server irraggiungibile — si riproverà al prossimo avvio.
  }
}

function markPickupPointSeen(item) {
  item.pickupPointChanged = false;
  saveHistory();
  savePending();
  fetch("/.netlify/functions/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "ack-pickup-point", id: item.id }),
  }).catch(() => {
    // Se la conferma non arriva al server, il banner potrebbe ripresentarsi
    // al prossimo sync — non blocca comunque il turista.
  });
  render();
}

// Conferma di consegna del turista, indipendente dallo stato "ritirato"
// (che indica solo che il corriere lo ha ritirato dal negozio, non che sia
// arrivato a casa). Mostrata sempre per ogni oggetto "ritirato" finché non
// confermato — nessuna soglia di giorni: un ritardo del corriere non deve
// nascondere la domanda proprio nel momento in cui servirebbe di più, e un
// singolo tap è comunque a costo zero per il turista se il pacco non è
// ancora arrivato (può semplicemente ignorarla finché non lo riceve).
// Un solo tap è prova sufficiente, nessun altro dato richiesto.
function confirmDelivery(item) {
  item.deliveryConfirmedAt = new Date().toISOString();
  saveHistory();
  savePending();
  syncPurchaseToCRM(item);
  render();
}

function pickupPointUpdateBanner(item) {
  if (!item.pickupPointChanged) return null;
  const banner = el("div", "pickup-update-banner");
  banner.innerHTML = `📍 Punto di ritiro aggiornato: ${item.pickupPoint}<div class="pickup-update-note">Tocca per confermare di aver visto l'aggiornamento</div>`;
  banner.addEventListener("click", (e) => {
    e.stopPropagation();
    markPickupPointSeen(item);
  });
  return banner;
}

function PackageCheckScreen() {
  const wrap = el("div", "section");
  const item =
    state.pendingItems.find((it) => it.id === state.checkingItemId) ||
    state.purchaseHistory.find((it) => it.id === state.checkingItemId);
  const back = el("div", "back", t("back_generic"));
  back.addEventListener("click", () => {
    state.screen = state.lastQueuedItem && state.lastQueuedItem.id === state.checkingItemId ? "queued" : "history";
    render();
  });
  wrap.appendChild(back);

  if (!item) {
    wrap.appendChild(el("div", "identify-intro", t("item_not_found")));
    return wrap;
  }

  wrap.appendChild(el("div", "step-lbl", t("pkgcheck_step_lbl")));

  if (item.packageDims) {
    const recCard = el("div", "pack-card");
    recCard.innerHTML = `<div class="pack-label">${t("pkgcheck_rec_lbl")}</div><div class="pack-dims">${formatDims(item.packageDims.l, item.packageDims.w, item.packageDims.h)}</div>`;
    wrap.appendChild(recCard);
  }

  const resultBox = el("div", "id", "package-check-result");
  resultBox.id = "package-check-result";
  if (item.packageCheck) {
    resultBox.appendChild(renderPackageCheckResult(item.packageCheck));
  }

  const captureCard = el("div", "capture-card");
  captureCard.innerHTML = `<div class="capture-icon">📷</div><h3>${t("pkgcheck_capture_title")}</h3><p>${t("capture_tap_camera")}</p>`;
  const input = el("input");
  input.type = "file";
  input.accept = "image/*";
  input.capture = "environment";
  input.style.display = "none";
  const runPackageCheckFromDataUrl = async (dataUrl) => {
    if (state.isOffline) {
      alert(t("pkgcheck_offline_alert"));
      return;
    }
    resultBox.innerHTML = `<div class="pack-checking">${t("pkgcheck_checking")}</div>`;
    try {
      const photo = await compressImage(dataUrl, 500, 0.6);
      const check = await checkPackage(photo, item.packageDims);
      item.packageCheck = check;
      savePending();
      saveHistory();
      resultBox.innerHTML = "";
      resultBox.appendChild(renderPackageCheckResult(check));
    } catch (err) {
      resultBox.innerHTML = `<div class="alert">${t("pkgcheck_failed_alert")}</div>`;
    }
  };
  input.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => runPackageCheckFromDataUrl(reader.result);
    reader.readAsDataURL(file);
  });
  captureCard.appendChild(input);
  captureCard.addEventListener("click", () => openCameraViewfinder(runPackageCheckFromDataUrl, input));
  wrap.appendChild(captureCard);
  wrap.appendChild(resultBox);

  return wrap;
}

function renderPackageCheckResult(check) {
  const box = el("div", "pack-check-result " + (check.oversized ? "warn" : "ok"));
  box.innerHTML = `
    <div class="pack-check-title">${check.oversized ? t("pkgcheck_oversized") : t("pkgcheck_ok")}</div>
    <div class="pack-check-dims">${t("pkgcheck_detected_dims", { dims: formatDims(check.length_cm, check.width_cm, check.height_cm) })}</div>
    <div class="pack-check-note">${check.note || ""}</div>`;
  return box;
}

async function checkPackage(photoDataUrl, recommendedDims) {
  const base64 = photoDataUrl.split(",")[1];
  const mediaType = photoDataUrl.split(";")[0].split(":")[1] || "image/jpeg";
  const recText = recommendedDims
    ? `Le dimensioni consigliate per questo imballo erano ${recommendedDims.l} x ${recommendedDims.w} x ${recommendedDims.h} cm.`
    : "Non ci sono dimensioni consigliate di riferimento.";
  return classify([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        {
          type: "text",
          text: `Sei un esperto di imballaggi per spedizioni. Analizza questa foto di un pacco pronto per la spedizione e stima le sue dimensioni esterne in centimetri. ${recText} Rispondi SOLO con JSON valido: {"length_cm":0,"width_cm":0,"height_cm":0,"oversized":true o false,"note":"breve commento, es. se è più grande del necessario rispetto alle dimensioni consigliate"}`,
        },
      ],
    },
  ]);
}

async function shareQR(item, qrUrl) {
  const text = `Touch&Go — QR di deposito per "${item.objectName}"\nCodice: ${item.id}\nPunto di ritiro: ${item.pickupPoint}\nDestinazione: ${item.addressLabel}`;
  try {
    if (navigator.share) {
      try {
        const res = await fetch(qrUrl);
        const blob = await res.blob();
        const file = new File([blob], `touchandgo-qr-${item.id}.png`, { type: "image/png" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text, title: "QR Touch&Go" });
          return;
        }
      } catch (e) {
        // fetch/File sharing not supported — fall through to text share
      }
      await navigator.share({ text, title: "QR Touch&Go", url: qrUrl });
      return;
    }
  } catch (e) {
    // user cancelled or share failed — fall back to clipboard
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${qrUrl}`);
    alert("Link e dettagli del QR copiati — incollali nel messaggio a chi imballa.");
  } catch (e) {
    alert("Copia manualmente questo codice per chi imballa: " + item.id);
  }
}

function generateBookingCode() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `TG-${rand}`;
}

function QueuedScreen() {
  const item = state.lastQueuedItem;
  const wrap = el("div", "section booked-screen");
  wrap.appendChild(AssistantAvatar("queued"));
  const qrData = encodeURIComponent(`TouchAndGo|${item.id}|negozio:${item.pickupPoint}|dest:${item.addressLabel}`);
  const qrUrl = qrCodeUrl(qrData, 220);
  const intro = el("div");
  intro.innerHTML = `
    <div class="booked-icon">🕓</div>
    <div class="booked-title">QR generato — in sospeso</div>
    <div class="booked-text">Mostra questo QR al negozio per lasciare l'oggetto. <b>Il ritiro non parte ancora:</b> resta in sospeso finché non concludi il soggiorno e invii l'ordine di ritiro per tutti gli acquisti.</div>
    <div class="qr-card">
      <img src="${qrUrl}" alt="QR di deposito" class="qr-img" />
      <div class="qr-code">${item.id}</div>
      <div class="qr-note">Il QR contiene il codice di riferimento — lettera di vettura, fattura e documento sono collegati a questo codice</div>
    </div>`;
  wrap.appendChild(intro);
  const shareBtn = el("button", "btn-secondary", "📤 Invia il QR a chi imballa");
  shareBtn.addEventListener("click", () => shareQR(item, qrUrl));
  wrap.appendChild(shareBtn);
  if (item.packageDims) {
    const pkgCard = el("div", "pack-card");
    pkgCard.innerHTML = `
      <div class="pack-label">📦 Per chi imballa — dimensioni consigliate</div>
      <div class="pack-dims">${formatDims(item.packageDims.l, item.packageDims.w, item.packageDims.h)}</div>
      <div class="pack-warn">Un imballo più grande del necessario aumenta il costo di spedizione: usa una scatola il più vicino possibile a queste misure.</div>`;
    wrap.appendChild(pkgCard);
    const checkBtn = el("button", "btn-secondary", "📷 Fotografa l'imballo per validarlo");
    checkBtn.addEventListener("click", () => {
      state.checkingItemId = item.id;
      state.screen = "package-check";
      render();
    });
    wrap.appendChild(checkBtn);
  }
  wrap.appendChild(el("div", "booked-note", `Hai ora ${state.pendingItems.length} acquist${state.pendingItems.length === 1 ? "o" : "i"} in sospeso.`));
  const docsBtn = el("button", "btn-secondary", "Vedi lettera di vettura e fattura →");
  docsBtn.addEventListener("click", () => {
    state.viewingDocsItemId = item.id;
    state.screen = "documents";
    render();
  });
  wrap.appendChild(docsBtn);
  const backBtn = el("button", "btn-primary", "Torna alla home");
  backBtn.addEventListener("click", () => {
    state.screen = "home";
    state.pendingInput = null;
    render();
  });
  wrap.appendChild(backBtn);
  return wrap;
}

function DocumentsScreen() {
  const wrap = el("div", "section");
  const item =
    state.pendingItems.find((it) => it.id === state.viewingDocsItemId) ||
    state.purchaseHistory.find((it) => it.id === state.viewingDocsItemId);
  const back = el("div", "back", t("back_generic"));
  back.addEventListener("click", () => {
    state.screen = state.docsReturnTo || "home";
    render();
  });
  wrap.appendChild(back);

  if (!item) {
    wrap.appendChild(el("div", "identify-intro", t("docs_not_found")));
    return wrap;
  }

  const addr = state.addresses.find((a) => a.id === item.addressId);
  const dateStr = new Date(item.date).toLocaleDateString(state.lang === "en" ? "en-GB" : "it-IT", { day: "2-digit", month: "long", year: "numeric" });

  wrap.appendChild(el("div", "step-lbl", t("docs_waybill_lbl")));
  const waybill = el("div", "doc-card");
  waybill.innerHTML = `
    <div class="doc-row"><span>${t("docs_row_reference")}</span><b>${item.id}</b></div>
    <div class="doc-row"><span>${t("docs_row_sender")}</span><b>${item.touristName || "—"}</b></div>
    <div class="doc-row"><span>${t("docs_row_pickup")}</span><b>${item.pickupPoint}</b></div>
    <div class="doc-row"><span>${t("docs_row_recipient")}</span><b>${item.touristName || "—"}</b></div>
    <div class="doc-row"><span>${t("docs_row_delivery_address")}</span><b>${item.addressLabel}</b></div>
    <div class="doc-row"><span>${t("docs_row_content")}</span><b>${item.objectName}</b></div>
    <div class="doc-row"><span>${t("result_lbl_hs_code")}</span><b>${item.hsCode}</b></div>
    <div class="doc-row"><span>${t("docs_row_weight")}</span><b>${item.weightKg} kg</b></div>
    <div class="doc-row"><span>${t("docs_row_pkg_dims")}</span><b>${item.packageDims ? formatDims(item.packageDims.l, item.packageDims.w, item.packageDims.h) : "—"}</b></div>
    <div class="doc-row"><span>${t("docs_row_issue_date")}</span><b>${dateStr}</b></div>`;
  wrap.appendChild(waybill);

  wrap.appendChild(el("div", "tg-lbl", t("docs_invoice_lbl")));
  const invoice = el("div", "doc-card");
  invoice.innerHTML = `
    <div class="doc-row"><span>${t("docs_row_invoice_number")}</span><b>PF-${item.id}</b></div>
    <div class="doc-row"><span>${t("docs_row_seller")}</span><b>${t("docs_seller_value")}</b></div>
    <div class="doc-row"><span>${t("docs_row_buyer")}</span><b>${item.touristName || "—"}</b></div>
    <div class="doc-row"><span>${t("docs_row_goods_desc")}</span><b>${item.objectName}</b></div>
    <div class="doc-row"><span>${t("docs_row_declared_value")}</span><b>€${(item.itemValue || 0).toFixed(2)}</b></div>
    <div class="doc-row"><span>${t("docs_row_vat_exempt")}</span><b>Art. 8 DPR 633/72</b></div>
    <div class="doc-row"><span>${t("docs_row_shipping_cost")}</span><b>€${item.price}</b></div>`;
  wrap.appendChild(invoice);

  const sigBlock = el("div", "sig-block");
  if (item.hasSignedInvoice) {
    sigBlock.innerHTML = `<div class="tg-lbl">${t("docs_signature_lbl")}</div><div class="identify-intro">${t("docs_signature_yes", { name: item.touristName || t("docs_signature_fallback_name") })}</div>`;
  } else {
    sigBlock.innerHTML = `<div class="tg-lbl">${t("docs_signature_lbl")}</div><div class="identify-intro">${t("docs_signature_no")}</div>`;
  }
  wrap.appendChild(sigBlock);

  wrap.appendChild(el("div", "tg-lbl", t("identify_doc_lbl")));
  if (item.hasIdOnFile) {
    wrap.appendChild(el("div", "identify-intro", t("docs_id_on_file")));
  } else {
    wrap.appendChild(el("div", "identify-intro", t("docs_id_missing")));
  }

  return wrap;
}

function ConcludeScreen() {
  const wrap = el("div", "section");
  const back = el("div", "back", "← Torna alla home");
  back.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  wrap.appendChild(back);

  wrap.appendChild(el("div", "step-lbl", "Concludi il soggiorno"));
  wrap.appendChild(
    el(
      "div",
      "identify-intro",
      "Questi sono gli acquisti raccolti nei negozi durante il soggiorno. Confermando, paghi ora il totale finale — ricalcolato sul gruppo consolidato, non la somma delle stime viste durante lo shopping — e invii un unico ordine di ritiro per ciascuna destinazione."
    )
  );

  const list = el("div", "queue-list");
  state.pendingItems.forEach((it) => {
    const row = el("div", "queue-item clickable");
    row.innerHTML = `<div class="queue-item-name">${it.objectName}</div>
      <div class="queue-item-meta">Negozio: ${it.pickupPoint} · HS ${it.hsCode}</div>
      <div class="queue-item-meta">→ ${it.addressLabel} · stima €${it.price}</div>`;
    row.addEventListener("click", () => {
      state.viewingItemId = it.id;
      state.viewItemReturnTo = "conclude";
      state.screen = "view-item-photo";
      render();
    });
    const changeBtn = el("button", "queue-item-change", "Cambia destinazione");
    changeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.editingItemId = it.id;
      state.editItemReturnTo = "conclude";
      state.screen = "edit-item-address";
      render();
    });
    row.appendChild(changeBtn);
    list.appendChild(row);
  });
  wrap.appendChild(list);

  // Calcolo finale del prezzo: per ogni destinazione (stessa addressLabel),
  // consolidatedGroupPrice() ricalcola il gruppo da zero sul peso/volume
  // combinato con una sola fee di servizio — vedi il commento su quella
  // funzione e MANUALE.md, sezione "Prezzo consolidato per gruppo di
  // spedizione". Questo, non la somma di it.price (le stime individuali
  // mostrate durante lo shopping), è il prezzo che conta davvero.
  const itemsByDest = {};
  state.pendingItems.forEach((it) => {
    (itemsByDest[it.addressLabel] = itemsByDest[it.addressLabel] || []).push(it);
  });
  const groupPricing = {};
  Object.entries(itemsByDest).forEach(([dest, items]) => {
    groupPricing[dest] = consolidatedGroupPrice(items);
  });
  const groups = Object.keys(itemsByDest).length;
  const grandTotal = Math.round(Object.values(groupPricing).reduce((s, g) => s + g.total, 0) * 100) / 100;

  const summary = el(
    "div",
    "info-line",
    `${state.pendingItems.length} oggetti verranno consolidati in ${groups} spedizion${groups === 1 ? "e" : "i"} (una per destinazione), invece di ${state.pendingItems.length} separate.`
  );
  wrap.appendChild(summary);

  const paymentSummary = el("div", "price-card");
  paymentSummary.innerHTML = `
    <div class="tg-lbl" style="margin-bottom:10px">Totale da confermare e pagare ora</div>
    ${Object.entries(groupPricing)
      .map(
        ([dest, g]) =>
          `<div class="info-row"><span>${dest} (${g.weightKg} kg fatturabili)</span><b>€${g.total.toFixed(2)}</b></div>`
      )
      .join("")}
    <div class="info-row total"><span>Totale complessivo</span><b>€${grandTotal.toFixed(2)}</b></div>`;
  wrap.appendChild(paymentSummary);

  // ============================================================
  // QUI è il punto di integrazione per un pagamento reale futuro
  // (Stripe o altro PSP) — vedi MANUALE.md, sezione "Punto di
  // integrazione pagamento futuro".
  //
  // Oggi il pagamento è solo simulato (il setTimeout qui sotto conferma
  // sempre, incondizionatamente), ma questo è già, a livello concettuale,
  // l'istante in cui il turista conferma E PAGA il totale finale mostrato
  // sopra (singolo o consolidato a seconda di quanti oggetti sono nel
  // gruppo, calcolato da consolidatedGroupPrice()) — non solo "notifica un
  // ritiro". Nessun punto del flusso PRIMA di questo (ResultScreen incluso)
  // deve mai comunicare un addebito: quello è sempre e solo una stima.
  //
  // Quando arriverà un pagamento reale, la chiamata al provider va
  // agganciata ESATTAMENTE qui, prima del blocco che marca gli oggetti come
  // "ritirato" e li sincronizza col CRM più sotto — non dopo: un pagamento
  // vero può fallire (carta rifiutata, timeout), e in quel caso gli oggetti
  // non andrebbero comunque marcati come ritirati né il gruppo salvato.
  // ============================================================
  const confirmBtn = el(
    "button",
    "btn-primary",
    `Conferma e paga €${grandTotal.toFixed(2)} — ordine di ritiro consolidato →`
  );
  confirmBtn.addEventListener("click", () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Confermo e pago…";
    setTimeout(() => {
      state.shippedGroups = Object.entries(itemsByDest).map(([dest, items]) => {
        const pricing = groupPricing[dest];
        const code = generateBookingCode();
        const group = {
          code,
          dest,
          destinationCountry: pricing.destinationCountry,
          itemIds: items.map((it) => it.id),
          itemCount: items.length,
          weightKg: pricing.weightKg,
          shipping: pricing.shipping,
          fee: pricing.fee,
          total: pricing.total,
          eta: pricing.eta,
          touristEmail: state.touristEmail,
          createdAt: new Date().toISOString(),
        };
        saveShipmentGroupToCRM(group);
        return { dest, total: pricing.total.toFixed(2), code, count: items.length };
      });
      state.pendingItems.forEach((it) => {
        const group = state.shippedGroups.find((g) => g.dest === it.addressLabel);
        it.status = "ritirato";
        it.shipmentGroupCode = group ? group.code : null;
        syncPurchaseToCRM(it);
      });
      state.pendingItems = [];
      savePending();
      saveHistory();
      state.screen = "shipped";
      render();
    }, 800);
  });
  wrap.appendChild(confirmBtn);

  return wrap;
}

function ShippedScreen() {
  const wrap = el("div", "section booked-screen");
  wrap.appendChild(el("div", "booked-icon", "✓"));
  wrap.appendChild(el("div", "booked-title", "Ordine confermato e pagato"));
  wrap.appendChild(
    el(
      "div",
      "booked-text",
      `Il corriere passerà a ritirare tutti gli oggetti lasciati nei negozi entro le prossime 24 ore, consolidati in ${state.shippedGroups.length} spedizion${state.shippedGroups.length === 1 ? "e" : "i"}.`
    )
  );
  const paidTotal = (state.shippedGroups || []).reduce((s, g) => s + parseFloat(g.total), 0);
  (state.shippedGroups || []).forEach((g) => {
    const card = el("div", "qr-card");
    card.innerHTML = `<div class="qr-code">${g.code}</div>
      <div class="qr-note">${g.count} oggett${g.count === 1 ? "o" : "i"} → ${g.dest}</div>
      <div class="qr-note">Totale €${g.total}</div>`;
    wrap.appendChild(card);
  });
  wrap.appendChild(
    el("div", "booked-text", `Pagamento di €${paidTotal.toFixed(2)} registrato (simulato in questo prototipo).`)
  );
  wrap.appendChild(
    el("div", "booked-note", "Prototipo — nessuna richiesta reale è stata inviata a un corriere né a un istituto di pagamento.")
  );
  const backBtn = el("button", "btn-primary", "Torna alla home");
  backBtn.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  wrap.appendChild(backBtn);
  return wrap;
}

// Aggiunge un pulsante microfono accanto a un campo di testo per dettare a
// voce invece di scrivere (turisti di fretta o con difficoltà con la
// tastiera). Usa la Web Speech API nativa del browser (su Chrome/Chromium
// la trascrizione passa comunque dai server di Google, non è on-device —
// serve quindi connessione dati attiva).
//
// Bug investigato (segnalato come "il microfono non funziona"): fino a
// questa versione, se il browser non esponeva SpeechRecognition/
// webkitSpeechRecognition la funzione usciva subito senza aggiungere
// nulla — il controllo spariva senza alcuna spiegazione, indistinguibile
// da un campo che non ha mai avuto dettatura vocale. Verificato con test
// reali (Playwright + Chromium, vedi commit): (a) su un browser che ESPONE
// l'API, il pulsante appare correttamente, è cliccabile, non è coperto né
// tagliato da nessun elemento — anche dentro AssistantChatModal, che è
// stata verificata esplicitamente perché sospettata di avere un problema
// suo; (b) il flusso di permesso/errore (recognition "error" con
// not-allowed/no-speech) funziona davvero e mostra il toast corretto —
// provato scatenando per davvero un rifiuto di permesso reale. Non è
// quindi un bug di layout/gestione errori specifico della modale.
// La causa reale è la (a) del sospetto originale, confermata anche solo
// leggendo il codice (nessun test necessario: il "return" immediato è
// deterministico) — su un browser che non espone affatto l'API (Firefox
// desktop/Android, che non la implementa per scelta di privacy; Safari ha
// un supporto storicamente incompleto/dipendente dalla versione) il
// controllo non compariva mai, ovunque nell'app: non solo nella chat
// assistente, ma anche nei campi nome/indirizzo — semplicemente lì viene
// notato meno perché scrivere a mano è l'alternativa ovvia e già in vista.
//
// Fix: il pulsante compare SEMPRE, anche quando l'API non è disponibile —
// in versione visivamente attenuata, non clickable per avviare un
// riconoscimento (non esiste nulla da avviare), ma il tap mostra comunque
// una spiegazione breve tramite lo stesso toast già usato per gli altri
// errori, invece di far sparire il controllo senza dire nulla.
//
// onResult(transcript), opzionale, viene chiamato dopo che il testo
// dettato è già stato scritto nel campo — usato dal chat dell'assistente
// per inviare subito il messaggio dopo la dettatura.
function addVoiceButton(input, onResult) {
  if (!input) return;
  const parent = input.parentElement;
  if (!parent) return;
  const supported = "SpeechRecognition" in window || "webkitSpeechRecognition" in window;

  const wrap = el("div", "voice-field-wrap" + (input.classList.contains("addr-cap") ? " voice-cap" : ""));
  parent.insertBefore(wrap, input);
  wrap.appendChild(input);

  const btn = el("button", "voice-btn" + (supported ? "" : " voice-btn-unsupported"), "🎤");
  btn.type = "button";
  btn.title = supported ? "Detta a voce" : "Dettatura vocale non disponibile su questo browser";
  btn.setAttribute("aria-label", supported ? "Detta a voce" : "Dettatura vocale non disponibile su questo browser");
  wrap.appendChild(btn);

  const toast = el("div", "voice-toast");
  toast.hidden = true;
  wrap.appendChild(toast);
  let toastTimer = null;
  const showToast = (msg) => {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  };

  if (!supported) {
    btn.addEventListener("click", () => showToast("🎤 Dettatura vocale non disponibile su questo browser — puoi comunque scrivere qui a mano."));
    return;
  }

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizing = false;

  btn.addEventListener("click", () => {
    if (recognizing) return;
    let recognition;
    try {
      recognition = new Recognition();
    } catch (err) {
      return;
    }
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.addEventListener("result", (ev) => {
      const transcript = (ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript || "").trim();
      if (!transcript) return;
      const existing = input.value.trim();
      input.value = existing ? `${existing} ${transcript}` : transcript;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (typeof onResult === "function") onResult(transcript);
    });

    recognition.addEventListener("error", (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        showToast("🎤 Microfono non autorizzato — puoi comunque scrivere qui a mano.");
      } else if (ev.error === "no-speech") {
        showToast("Non ho sentito nulla — riprova o scrivi a mano.");
      } else if (ev.error !== "aborted") {
        showToast("Non ho capito bene — riprova o scrivi a mano.");
      }
    });

    recognition.addEventListener("end", () => {
      recognizing = false;
      btn.classList.remove("listening");
    });

    try {
      recognition.start();
      recognizing = true;
      btn.classList.add("listening");
    } catch (err) {
      recognizing = false;
      btn.classList.remove("listening");
    }
  });
}

function IdentifyScreen() {
  const wrap = el("div", "section identify-screen");
  const isBookingGate = !!state.identifyPrompt;
  wrap.innerHTML = `
    <div class="step-lbl">${isBookingGate ? t("identify_step_gate") : t("identify_step_normal")}</div>
    <div class="identify-intro">${state.identifyPrompt || t("identify_intro_default")}</div>`;

  const nameField = el("div", "dest-field");
  nameField.innerHTML = `<div class="dest-lbl">${t("identify_name_lbl")}</div><input class="dest-input" id="name-input" placeholder="${t("identify_name_placeholder")}" />`;
  wrap.appendChild(nameField);
  addVoiceButton(nameField.querySelector("#name-input"));

  const emailField = el("div", "dest-field");
  emailField.innerHTML = `<div class="dest-lbl">${t("identify_email_lbl")}</div><input class="dest-input" id="email-input" type="email" placeholder="${t("identify_email_placeholder")}" />`;
  wrap.appendChild(emailField);

  wrap.appendChild(el("div", "tg-lbl", t("identify_dest_lbl")));
  const addressFields = AddressFormFields("identify");
  wrap.appendChild(addressFields);
  if (state.guestDestinationCountry) {
    const countrySelect = addressFields.querySelector("#identify-country");
    if (countrySelect) countrySelect.value = state.guestDestinationCountry;
  }

  wrap.appendChild(el("div", "tg-lbl", t("identify_doc_lbl")));
  const idCard = el("div", "id-upload-card");
  idCard.innerHTML = `<div class="id-upload-ic">🪪</div><div class="id-upload-txt">${t("identify_doc_upload_txt")}</div><div class="id-upload-status" id="id-upload-status">${t("identify_doc_status_none")}</div>`;
  const idInput = el("input");
  idInput.type = "file";
  idInput.accept = "image/*";
  idInput.style.display = "none";
  let idDocumentData = null;
  let signatureDetected = false;
  idInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById("id-upload-status");
    const reader = new FileReader();
    reader.onload = async () => {
      idDocumentData = await compressImage(reader.result, 700, 0.6);
      statusEl.textContent = t("identify_doc_status_checking");
      statusEl.classList.remove("ok");
      try {
        const detection = await detectSignature(idDocumentData);
        signatureDetected = !!detection.has_signature;
        statusEl.textContent = signatureDetected
          ? t("identify_doc_status_sig_yes")
          : t("identify_doc_status_sig_no");
        if (signatureDetected) statusEl.classList.add("ok");
      } catch (err) {
        signatureDetected = false;
        statusEl.textContent = t("identify_doc_status_sig_error");
      }
    };
    reader.readAsDataURL(file);
  });
  idCard.appendChild(idInput);
  idCard.addEventListener("click", () => idInput.click());
  wrap.appendChild(idCard);
  wrap.appendChild(el("div", "home-foot", t("identify_doc_footnote")));

  const goBtn = el("button", "btn-primary", t("identify_save_btn"));
  goBtn.addEventListener("click", async () => {
    const name = document.getElementById("name-input").value.trim();
    const email = document.getElementById("email-input").value.trim();
    const addr = readAddressForm("identify");
    if (!addr.city || !addr.country) return;
    if (!email || !email.includes("@")) {
      alert(t("identify_email_invalid_alert"));
      return;
    }
    state.touristName = name || t("identify_default_guest_name");
    state.touristEmail = email;
    addr.label = t("identify_default_address_label");
    addr.id = "addr-" + Date.now();
    state.addresses = [addr];
    state.selectedAddressId = addr.id;
    state.idDocument = idDocumentData;
    state.signatureDetected = signatureDetected;
    saveProfile();

    if (isBiometricSupported()) {
      goBtn.disabled = true;
      goBtn.textContent = t("identify_biometric_activating");
      try {
        const credentialId = await registerBiometric(email, name);
        state.biometricCredentialId = credentialId;
        state.biometricVerified = true;
        saveProfile();
      } catch (e) {
        // L'utente ha annullato o il dispositivo non supporta il sensore —
        // si continua comunque senza sblocco biometrico.
      }
    }

    const returnTo = state.identifyReturnTo;
    state.identifyPrompt = null;
    state.identifyReturnTo = null;
    state.screen = returnTo || "home";
    render();
  });
  wrap.appendChild(goBtn);

  return wrap;
}

async function detectSignature(idDocumentDataUrl) {
  const base64 = idDocumentDataUrl.split(",")[1];
  const mediaType = idDocumentDataUrl.split(";")[0].split(":")[1] || "image/jpeg";
  const result = await classify([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        {
          type: "text",
          text: 'Analizza questa immagine di un documento di identità. Contiene una firma manoscritta visibile del titolare? Rispondi SOLO con JSON valido: {"has_signature": true o false}',
        },
      ],
    },
  ]);
  return result;
}

function AddressFormFields(prefix) {
  const wrap = el("div", "address-form");
  wrap.innerHTML = `
    <input class="addr-input" id="${prefix}-street" placeholder="${t("addr_street_placeholder")}" />
    <div class="addr-row">
      <input class="addr-input" id="${prefix}-city" placeholder="${t("addr_city_placeholder")}" />
      <input class="addr-input addr-cap" id="${prefix}-cap" placeholder="${t("addr_cap_placeholder")}" />
    </div>
    <select class="dest-select addr-country" id="${prefix}-country">
      ${DESTINATIONS.map((d) => `<option value="${d.name}">${destinationDisplayName(d.name)}</option>`).join("")}
    </select>`;
  addVoiceButton(wrap.querySelector(`#${prefix}-street`));
  addVoiceButton(wrap.querySelector(`#${prefix}-city`));
  addVoiceButton(wrap.querySelector(`#${prefix}-cap`));
  return wrap;
}

function readAddressForm(prefix) {
  const g = (id) => {
    const node = document.getElementById(id);
    return node ? node.value.trim() : "";
  };
  return {
    street: g(`${prefix}-street`),
    city: g(`${prefix}-city`),
    cap: g(`${prefix}-cap`),
    country: g(`${prefix}-country`),
  };
}

function formatAddress(a) {
  if (!a) return "—";
  const parts = [a.street, [a.cap, a.city].filter(Boolean).join(" "), destinationDisplayName(a.country)].filter(Boolean);
  return parts.join(", ");
}

function getSelectedAddress() {
  return state.addresses.find((a) => a.id === state.selectedAddressId) || state.addresses[0] || null;
}

// Destinazione da usare per il calcolo prezzo: l'indirizzo salvato se il
// turista è registrato, altrimenti il solo paese generico scelto in Passo 2
// (nessun indirizzo completo richiesto finché non si conferma davvero).
function currentDestinationName() {
  const addr = getSelectedAddress();
  return addr ? addr.country : state.guestDestinationCountry;
}

function GuestDestinationField() {
  if (!state.guestDestinationCountry) state.guestDestinationCountry = DESTINATIONS[0].name;
  const wrap = el("div", "dest-field-block");
  const field = el("div", "dest-field");
  field.innerHTML = `<div class="dest-lbl">${t("guest_dest_lbl")}</div>
    <select class="dest-select" id="guest-country-input">
      ${DESTINATIONS.map(
        (d) =>
          `<option value="${d.name}" ${d.name === state.guestDestinationCountry ? "selected" : ""}>${destinationDisplayName(
            d.name
          )}</option>`
      ).join("")}
    </select>`;
  field.querySelector("#guest-country-input").addEventListener("change", (e) => {
    state.guestDestinationCountry = e.target.value;
  });
  wrap.appendChild(field);
  wrap.appendChild(el("div", "pickup-note", t("guest_dest_note")));
  return wrap;
}

function DestinationField() {
  if (state.addresses.length === 0) return GuestDestinationField();
  const wrap = el("div", "dest-field-block");
  const label = state.destinationFromProfile ? t("dest_field_from_profile") : t("dest_field_selected");
  const current = getSelectedAddress();
  wrap.innerHTML = `<div class="dest-lbl">${label}</div>
    <div class="addr-summary">${current ? `<b>${current.label || t("dest_default_label")}</b> · ${formatAddress(current)}` : t("dest_no_address")}</div>`;

  const list = el("div", "addr-list");
  state.addresses.forEach((a) => {
    const row = el("div", "addr-option" + (a.id === state.selectedAddressId ? " selected" : ""));
    row.innerHTML = `<span>${a.label || t("dest_default_label")} — ${formatAddress(a)}</span>`;
    row.addEventListener("click", () => {
      state.selectedAddressId = a.id;
      state.destinationFromProfile = false;
      saveProfile();
      render();
    });
    list.appendChild(row);
  });
  wrap.appendChild(list);

  const addBtn = el("button", "btn-secondary", t("dest_add_address_btn"));
  addBtn.addEventListener("click", () => {
    state.addAddressReturnTo = "destination";
    state.screen = "add-address";
    render();
  });
  wrap.appendChild(addBtn);

  return wrap;
}

function AddAddressScreen() {
  const wrap = el("div", "section");
  const back = el("div", "back", "← Torna indietro");
  back.addEventListener("click", () => {
    state.screen = state.addAddressReturnTo || "destination";
    render();
  });
  wrap.appendChild(back);
  wrap.appendChild(el("div", "step-lbl", "Nuovo indirizzo di destinazione"));

  const labelField = el("div", "dest-field");
  labelField.innerHTML = `<div class="dest-lbl">Etichetta</div><input class="dest-input" id="newaddr-label" placeholder="Es. Casa, Ufficio…" />`;
  wrap.appendChild(labelField);
  addVoiceButton(labelField.querySelector("#newaddr-label"));

  wrap.appendChild(AddressFormFields("newaddr"));

  const saveBtn = el("button", "btn-primary", "Salva indirizzo →");
  saveBtn.addEventListener("click", () => {
    const addr = readAddressForm("newaddr");
    if (!addr.city || !addr.country) return;
    addr.label = document.getElementById("newaddr-label").value.trim() || "Indirizzo";
    addr.id = "addr-" + Date.now();
    state.addresses.push(addr);
    state.selectedAddressId = addr.id;
    state.destinationFromProfile = false;
    saveProfile();
    state.screen = state.addAddressReturnTo || "destination";
    render();
  });
  wrap.appendChild(saveBtn);

  return wrap;
}

function ChooseAddressScreen() {
  const wrap = el("div", "section");
  const back = el("div", "back", "← Torna al risultato");
  back.addEventListener("click", () => {
    state.screen = "result";
    render();
  });
  wrap.appendChild(back);

  wrap.appendChild(el("div", "step-lbl", "A quale indirizzo destiniamo questo acquisto?"));
  wrap.appendChild(
    el("div", "identify-intro", `${localizeObjectName(state.result)} — scegli l'indirizzo per questa spedizione.`)
  );

  if (state.addresses.length === 0) {
    wrap.appendChild(
      el(
        "div",
        "identify-intro",
        `Destinazione indicata finora: ${destinationDisplayName(state.guestDestinationCountry) || "—"}. L'indirizzo completo verrà chiesto al passo successivo, quando confermi davvero la spedizione.`
      )
    );
  } else {
    const list = el("div", "addr-list");
    state.addresses.forEach((a) => {
      const row = el("div", "addr-option" + (a.id === state.selectedAddressId ? " selected" : ""));
      row.innerHTML = `<span>${a.label || "Indirizzo"} — ${formatAddress(a)}</span>`;
      row.addEventListener("click", () => {
        state.selectedAddressId = a.id;
        state.destinationFromProfile = false;
        render();
      });
      list.appendChild(row);
    });
    wrap.appendChild(list);

    const addBtn = el("button", "btn-secondary", "+ Aggiungi un nuovo indirizzo");
    addBtn.addEventListener("click", () => {
      state.addAddressReturnTo = "choose-address";
      state.screen = "add-address";
      render();
    });
    wrap.appendChild(addBtn);
  }

  wrap.appendChild(el("div", "tg-lbl", "Punto di ritiro per questo acquisto"));
  const pickupField = el("div", "dest-field");
  pickupField.innerHTML = `<div class="dest-lbl">Se diverso dal punto vendita rilevato</div><input class="dest-input" id="item-pickup-input" value="${state.pickupPoint}" />`;
  wrap.appendChild(pickupField);
  wrap.appendChild(
    el("div", "home-foot", "Utile se chi imballa/consegna l'oggetto non è lo stesso negozio dove hai fatto l'acquisto.")
  );

  const confirmBtn = el("button", "btn-primary", "Conferma e genera QR →");
  confirmBtn.addEventListener("click", async () => {
    if (!state.touristName) {
      state.identifyPrompt = "Ultimo passo: registrati per completare la spedizione — il preventivo resta questo.";
      state.identifyReturnTo = "choose-address";
      state.screen = "identify";
      render();
      return;
    }
    if (!state.selectedAddressId) return;
    const itemPickupPoint = document.getElementById("item-pickup-input").value.trim() || state.pickupPoint;
    const addr = getSelectedAddress();
    if (state.result) {
      state.price = priceFor(state.result.weight_kg, currentDestinationName(), state.result);
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Genero QR…";
    if (state.priceConfirmedAsBreakeven) redeemPromoCode();

    let photo = null;
    let textDescription = null;
    if (state.pendingInput && state.pendingInput.type === "image") {
      photo = await compressImage(state.pendingInput.dataUrl, 480, 0.6);
    } else if (state.pendingInput && state.pendingInput.type === "text") {
      textDescription = state.pendingInput.label;
    }

    setTimeout(() => {
      const item = {
        id: generateBookingCode(),
        objectName: localizeObjectName(state.result),
        hsCode: (state.result && state.result.hs_code) || "—",
        category: (state.result && state.result.category) || null,
        material: (state.result && state.result.material) || null,
        weightKg: state.result ? state.result.weight_kg : 1,
        dims: state.result
          ? { length_cm: state.result.length_cm, width_cm: state.result.width_cm, height_cm: state.result.height_cm }
          : null,
        packageDims: packagedDimensions(state.result),
        itemValue: state.result && typeof state.result.value_eur === "number" ? state.result.value_eur : 0,
        pricingTier: state.priceConfirmedAsBreakeven ? "breakeven" : state.isSubscribed ? "abbonato" : "pieno",
        pickupPoint: itemPickupPoint,
        pickupSource: itemPickupPoint === state.pickupPoint ? state.pickupSource : null,
        addressId: addr ? addr.id : null,
        addressLabel: addr ? `${addr.label || "Indirizzo"} — ${formatAddress(addr)}` : "—",
        price: state.price ? state.price.grandTotal : 0,
        touristName: state.touristName,
        partnerCode: state.activePartnerCode || null,
        partnerDiscountCode: state.partnerDiscountApplied ? state.partnerDiscountCode : null,
        partnerDiscountAmount: state.partnerDiscountApplied ? state.partnerDiscountAmount : null,
        status: "in sospeso",
        date: new Date().toISOString(),
        photo,
        textDescription,
        hasSignedInvoice: !!state.signatureDetected,
        hasIdOnFile: !!state.idDocument,
      };
      state.pendingItems.push(item);
      state.purchaseHistory.push(item);
      savePending();
      saveHistory();
      syncPurchaseToCRM(item);
      state.lastQueuedItem = item;
      state.screen = "queued";
      render();
    }, 700);
  });
  wrap.appendChild(confirmBtn);

  return wrap;
}

function EditItemAddressScreen() {
  const wrap = el("div", "section");
  const item = state.pendingItems.find((it) => it.id === state.editingItemId);
  const returnTo = state.editItemReturnTo || "conclude";

  const back = el("div", "back", "← Annulla");
  back.addEventListener("click", () => {
    state.editingItemId = null;
    state.screen = returnTo;
    render();
  });
  wrap.appendChild(back);

  if (!item) {
    wrap.appendChild(el("div", "identify-intro", "Acquisto non trovato."));
    return wrap;
  }

  wrap.appendChild(el("div", "step-lbl", "Cambia destinazione"));
  wrap.appendChild(el("div", "identify-intro", `${item.objectName} — attualmente verso: ${item.addressLabel}`));

  const list = el("div", "addr-list");
  state.addresses.forEach((a) => {
    const row = el("div", "addr-option" + (a.id === item.addressId ? " selected" : ""));
    row.innerHTML = `<span>${a.label || "Indirizzo"} — ${formatAddress(a)}</span>`;
    row.addEventListener("click", () => {
      item.addressId = a.id;
      item.addressLabel = `${a.label || "Indirizzo"} — ${formatAddress(a)}`;
      item.price = priceFor(item.weightKg, a.country, item.dims).grandTotal;
      savePending();
      saveHistory();
      state.editingItemId = null;
      state.screen = returnTo;
      render();
    });
    list.appendChild(row);
  });
  wrap.appendChild(list);

  const addBtn = el("button", "btn-secondary", "+ Aggiungi un nuovo indirizzo");
  addBtn.addEventListener("click", () => {
    state.addAddressReturnTo = "edit-item-address";
    state.screen = "add-address";
    render();
  });
  wrap.appendChild(addBtn);

  return wrap;
}

function compressImage(dataUrl, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      if (w > h && w > maxDim) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else if (h > maxDim) {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function ViewItemPhotoScreen() {
  const wrap = el("div", "section");
  const item =
    state.purchaseHistory.find((it) => it.id === state.viewingItemId) ||
    state.pendingItems.find((it) => it.id === state.viewingItemId);
  const back = el("div", "back", "← Torna indietro");
  back.addEventListener("click", () => {
    state.viewingItemId = null;
    state.screen = state.viewItemReturnTo || "history";
    render();
  });
  wrap.appendChild(back);

  if (!item) {
    wrap.appendChild(el("div", "identify-intro", "Acquisto non trovato."));
    return wrap;
  }

  wrap.appendChild(el("div", "step-lbl", "Foto originale dell'acquisto"));
  if (item.photo) {
    const img = el("img", "capture-preview");
    img.src = item.photo;
    wrap.appendChild(img);
  } else if (item.textDescription) {
    wrap.appendChild(el("div", "pending-desc", `"${item.textDescription}"`));
    wrap.appendChild(el("div", "identify-intro", "Questo acquisto è stato descritto a testo, senza foto."));
  } else {
    wrap.appendChild(el("div", "identify-intro", "Nessuna foto disponibile per questo acquisto."));
  }

  const info = el("div", "info-card");
  info.innerHTML = `
    <div class="info-row"><span>Oggetto</span><b>${item.objectName}</b></div>
    <div class="info-row"><span>Codice HS</span><b>${item.hsCode}</b></div>
    <div class="info-row"><span>Ritiro</span><b>${item.pickupPoint}</b></div>
    <div class="info-row"><span>Destinazione</span><b>${item.addressLabel}</b></div>`;
  wrap.appendChild(info);

  return wrap;
}

function DashboardScreen() {
  const wrap = el("div", "section");
  const back = el("div", "back", "← Torna alla home");
  back.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  wrap.appendChild(back);
  wrap.appendChild(el("div", "step-lbl", "La tua spesa"));

  const items = state.purchaseHistory;
  const totalValue = items.reduce((s, it) => s + (it.itemValue || 0), 0);
  const totalService = items.reduce((s, it) => s + (it.price || 0), 0);
  const pendingCount = items.filter((it) => it.status === "in sospeso").length;
  const doneCount = items.filter((it) => it.status === "ritirato").length;
  const fullPriceCount = items.filter((it) => it.pricingTier === "pieno").length;
  const subscriptionSavings = fullPriceCount * (FULL_FEE - SUBSCRIBED_FEE);

  const summary = el("div", "info-card");
  summary.innerHTML = `
    <div class="info-row"><span>Acquisti registrati</span><b>${items.length}</b></div>
    <div class="info-row"><span>In sospeso / ritirati</span><b>${pendingCount} / ${doneCount}</b></div>
    <div class="info-row"><span>Valore acquisti (stima AI)</span><b>€${totalValue.toFixed(2)}</b></div>
    <div class="info-row"><span>Speso in servizi Touch&amp;Go</span><b>€${totalService.toFixed(2)}</b></div>
    ${
      subscriptionSavings > 0
        ? `<div class="info-row"><span>${state.isSubscribed ? "Risparmiato abbonandoti" : "Risparmieresti abbonandoti"}</span><b>€${subscriptionSavings.toFixed(2)}</b></div>`
        : ""
    }
    <div class="info-row total"><span>Totale complessivo</span><b>€${(totalValue + totalService).toFixed(2)}</b></div>`;
  wrap.appendChild(summary);

  wrap.appendChild(el("div", "tg-lbl", "Dettaglio per acquisto"));
  const list = el("div", "history-list");
  if (!items.length) {
    list.appendChild(el("div", "identify-intro", "Non hai ancora registrato nessun acquisto."));
  } else {
    items
      .slice()
      .reverse()
      .forEach((it) => {
        const banner = pickupPointUpdateBanner(it);
        if (banner) list.appendChild(banner);
        const row = el("div", "history-item");
        row.innerHTML = `
          <div class="history-top"><span class="history-name">${it.objectName}</span><span class="history-status ${historyStatusClass(it.status)}">${it.status}</span></div>
          <div class="history-meta">Valore oggetto: €${(it.itemValue || 0).toFixed(2)} · Servizio Touch&amp;Go: €${it.price}</div>`;
        list.appendChild(row);
      });
  }
  wrap.appendChild(list);

  const replayBtn = el("button", "reset-link", t("onboarding_replay"));
  replayBtn.addEventListener("click", restartOnboarding);
  wrap.appendChild(replayBtn);

  return wrap;
}

function resetEverything() {
  if (!confirm("Cancellare nome, indirizzi salvati, acquisti in sospeso, lo storico acquisti e ricominciare da capo?")) return;
  try {
    localStorage.removeItem("tg_profile");
    localStorage.removeItem("tg_pending");
    localStorage.removeItem("tg_history");
  } catch (e) {}
  state.touristName = null;
  state.touristEmail = null;
  state.biometricCredentialId = null;
  state.biometricVerified = false;
  state.isSubscribed = false;
  state.idDocument = null;
  state.signatureDetected = false;
  state.addresses = [];
  state.selectedAddressId = null;
  state.destinationFromProfile = true;
  state.guestDestinationCountry = null;
  state.identifyPrompt = null;
  state.identifyReturnTo = null;
  state.pendingInput = null;
  state.pendingItems = [];
  state.purchaseHistory = [];
  state.mode = "turista";
  state.screen = "cover";
  render();
}

function isBiometricSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

function randomChallenge() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return arr;
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function registerBiometric(email, name) {
  const userId = new Uint8Array(16);
  crypto.getRandomValues(userId);
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomChallenge(),
      rp: { name: "Touch&Go" },
      user: { id: userId, name: email, displayName: name || email },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60000,
    },
  });
  return bufToBase64(credential.rawId);
}

async function verifyBiometric(credentialIdBase64) {
  await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      allowCredentials: [{ id: base64ToBuf(credentialIdBase64), type: "public-key" }],
      userVerification: "required",
      timeout: 60000,
    },
  });
}

function BiometricLockScreen() {
  const wrap = el("div", "section biometric-lock");
  wrap.innerHTML = `
    <div class="biometric-icon">🔒</div>
    <div class="step-lbl" style="justify-content:center;text-align:center">Sblocca Touch&amp;Go</div>
    <div class="identify-intro" style="text-align:center">Ciao ${state.touristName || ""} — verifica la tua identità per continuare.</div>`;
  const unlockBtn = el("button", "btn-primary", "🔓 Sblocca con Face ID / Touch ID / impronta");
  const errBox = el("div", "alert hidden");
  unlockBtn.addEventListener("click", async () => {
    unlockBtn.disabled = true;
    unlockBtn.textContent = "Verifico…";
    errBox.classList.add("hidden");
    try {
      await verifyBiometric(state.biometricCredentialId);
      state.biometricVerified = true;
      state.screen = state.touristName ? "home" : "cover";
      render();
    } catch (e) {
      errBox.textContent = "⚠️ Verifica non riuscita o annullata. Riprova.";
      errBox.classList.remove("hidden");
      unlockBtn.disabled = false;
      unlockBtn.textContent = "🔓 Sblocca con Face ID / Touch ID / impronta";
    }
  });
  wrap.appendChild(unlockBtn);
  wrap.appendChild(errBox);
  const skipBtn = el("button", "reset-link", "Non riesco a sbloccare — resetta l'account");
  skipBtn.addEventListener("click", resetEverything);
  wrap.appendChild(skipBtn);
  return wrap;
}

function saveProfile() {
  try {
    localStorage.setItem(
      "tg_profile",
      JSON.stringify({
        name: state.touristName,
        email: state.touristEmail,
        addresses: state.addresses,
        selectedAddressId: state.selectedAddressId,
        idDocument: state.idDocument,
        signatureDetected: state.signatureDetected,
        biometricCredentialId: state.biometricCredentialId,
        isSubscribed: state.isSubscribed,
      })
    );
    // TOU-14: marca il dispositivo come "ha già effettuato l'accesso" una
    // volta per sempre — a differenza di "tg_profile", resetEverything() non
    // rimuove mai questa chiave, cosi l'onboarding automatico (vedi vicino a
    // loadProfile() più in basso) non riparte più dopo un reset per chi ha
    // già completato la registrazione almeno una volta su questo dispositivo.
    if (state.touristEmail) localStorage.setItem("tg_onboarded", "1");
  } catch (e) {}
}

function loadProfile() {
  try {
    const raw = localStorage.getItem("tg_profile");
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.name) state.touristName = p.name;
    if (p.email) state.touristEmail = p.email;
    if (p.addresses && p.addresses.length) {
      state.addresses = p.addresses;
      state.selectedAddressId = p.selectedAddressId || p.addresses[0].id;
      state.destinationFromProfile = true;
    }
    if (p.idDocument) state.idDocument = p.idDocument;
    if (typeof p.signatureDetected === "boolean") state.signatureDetected = p.signatureDetected;
    if (p.biometricCredentialId) state.biometricCredentialId = p.biometricCredentialId;
    if (typeof p.isSubscribed === "boolean") state.isSubscribed = p.isSubscribed;
  } catch (e) {}
}

function savePending() {
  try {
    localStorage.setItem("tg_pending", JSON.stringify(state.pendingItems));
  } catch (e) {}
}

function loadPending() {
  try {
    const raw = localStorage.getItem("tg_pending");
    if (!raw) return;
    const items = JSON.parse(raw);
    if (Array.isArray(items)) state.pendingItems = items;
  } catch (e) {}
}

function saveHistory() {
  try {
    localStorage.setItem("tg_history", JSON.stringify(state.purchaseHistory));
  } catch (e) {}
}

function loadHistory() {
  try {
    const raw = localStorage.getItem("tg_history");
    if (!raw) return;
    const items = JSON.parse(raw);
    if (Array.isArray(items)) state.purchaseHistory = items;
  } catch (e) {}
}

function PurchaseHistoryList(items, emptyText, editable) {
  const wrap = el("div", "history-list");
  if (!items.length) {
    wrap.appendChild(el("div", "identify-intro", emptyText));
    return wrap;
  }
  items
    .slice()
    .reverse()
    .forEach((it) => {
      const banner = pickupPointUpdateBanner(it);
      if (banner) wrap.appendChild(banner);
      const row = el("div", "history-item");
      const dt = new Date(it.date);
      const dateStr = isNaN(dt) ? "" : dt.toLocaleDateString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      const sourceLbl = it.pickupSource === "gps" ? "GPS" : it.pickupSource === "ip" ? "rete" : "manuale";
      row.innerHTML = `
        <div class="history-top"><span class="history-name">${it.objectName}</span><span class="history-status ${historyStatusClass(it.status)}">${it.status}</span></div>
        <div class="history-meta">Ritiro rilevato (${sourceLbl}): <b>${it.pickupPoint}</b> · HS ${it.hsCode}</div>
        <div class="history-meta">→ ${it.addressLabel} · €${it.price}</div>
        <div class="history-meta">${it.touristName ? it.touristName + " · " : ""}${dateStr}</div>`;
      if (editable) {
        row.classList.add("clickable");
        row.addEventListener("click", () => {
          state.viewingItemId = it.id;
          state.viewItemReturnTo = "history";
          state.screen = "view-item-photo";
          render();
        });
        const docsBtn = el("button", "queue-item-change", "Lettera di vettura e fattura");
        docsBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.viewingDocsItemId = it.id;
          state.docsReturnTo = "history";
          state.screen = "documents";
          render();
        });
        row.appendChild(docsBtn);
      }
      if (editable && it.status === "in sospeso") {
        const changeBtn = el("button", "queue-item-change", "Cambia destinazione");
        changeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.editingItemId = it.id;
          state.editItemReturnTo = "history";
          state.screen = "edit-item-address";
          render();
        });
        row.appendChild(changeBtn);
      }
      if (editable && it.status === "in confezionamento") {
        const pickupBtn = el("button", "queue-item-change", "📦 Richiedi ritiro");
        pickupBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          it.status = "ritiro richiesto";
          it.pickupRequestedAt = new Date().toISOString();
          savePending();
          saveHistory();
          syncPurchaseToCRM(it);
          render();
        });
        row.appendChild(pickupBtn);
      }
      if (editable && it.status === "ritirato" && !it.deliveryConfirmedAt) {
        const confirmBox = el("div", "delivery-confirm-box");
        confirmBox.appendChild(el("div", "delivery-confirm-question", "Hai ricevuto il tuo pacco?"));
        const confirmBtn = el("button", "btn-primary delivery-confirm-btn", "Sì, l'ho ricevuto");
        confirmBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          confirmDelivery(it);
        });
        confirmBox.appendChild(confirmBtn);
        row.appendChild(confirmBox);
      } else if (editable && it.status === "ritirato" && it.deliveryConfirmedAt) {
        const confirmedDt = new Date(it.deliveryConfirmedAt);
        const confirmedStr = isNaN(confirmedDt)
          ? ""
          : confirmedDt.toLocaleDateString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
        row.appendChild(el("div", "delivery-confirmed-note", `✓ Consegna confermata${confirmedStr ? " il " + confirmedStr : ""}`));
      }
      wrap.appendChild(row);
    });
  return wrap;
}

function HistoryScreen() {
  const wrap = el("div", "section");
  wrap.appendChild(AssistantAvatar("history"));
  const back = el("div", "back", "← Torna alla home");
  back.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  wrap.appendChild(back);
  wrap.appendChild(el("div", "step-lbl", "I tuoi acquisti"));
  wrap.appendChild(PurchaseHistoryList(state.purchaseHistory, "Non hai ancora registrato nessun acquisto.", true));
  return wrap;
}



function Footer() {
  const f = el("div", "footer");
  f.innerHTML = `<p>${t("footer_tagline")}</p>
    <div class="footer-links">
      <button class="reset-link" id="dashboard-link">${t("footer_dashboard")}</button>
      <button class="reset-link" id="history-link">${t("footer_history", { count: state.purchaseHistory.length })}</button>
      <button class="reset-link" id="reset-link">${t("footer_reset")}</button>
    </div>
    <div class="footer-links">
      <a class="reset-link" href="/site/termini.html">${t("footer_terms")}</a>
      <a class="reset-link" href="/site/privacy.html">${t("footer_privacy")}</a>
    </div>`;
  f.querySelector("#reset-link").addEventListener("click", resetEverything);
  f.querySelector("#history-link").addEventListener("click", () => {
    state.screen = "history";
    render();
    syncPurchaseUpdatesFromCRM();
  });
  f.querySelector("#dashboard-link").addEventListener("click", () => {
    state.screen = "dashboard";
    render();
    syncPurchaseUpdatesFromCRM();
  });
  return f;
}

// ---------------- Handlers ----------------

async function runClassification(promise) {
  state.screen = "analyzing";
  state.error = null;
  render();
  try {
    const result = await promise;
    state.result = result;
    state.price = priceFor(result.weight_kg, currentDestinationName(), result);
    state.priceConfirmedForThisResult = false;
    state.priceConfirmedAsBreakeven = false;
    state.showPartnerDiscountInput = false;
    state.partnerDiscountCodeInput = "";
    state.partnerDiscountChecking = false;
    state.partnerDiscountApplied = false;
    state.partnerDiscountCode = null;
    state.partnerDiscountAmount = 0;
    state.partnerDiscountError = null;
    state.screen = "result";
  } catch (err) {
    state.error = /401/.test(err.message) ? t("dest_error_api_key") : t("dest_error_ai_generic");
    state.screen = "destination";
  }
  render();
}

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => handleImageDataUrl(reader.result, file.type);
  reader.readAsDataURL(file);
}

// Stesso esito di handleFile() sopra, ma a partire da un data URL già
// pronto (es. lo scatto del mirino fotocamera custom in openCameraViewfinder,
// che produce direttamente un data URL via canvas invece che un File).
function handleImageDataUrl(dataUrl, mediaType) {
  state.pendingInput = { type: "image", base64: dataUrl.split(",")[1], mediaType, dataUrl };
  state.screen = "destination";
  render();
}

// ---------------- Mirino fotocamera custom (TOU-20) ----------------
//
// L'app apriva finora sempre la fotocamera nativa del telefono tramite un
// <input type="file" capture="environment"> nascosto: nessuna UI nostra,
// nessun controllo sul momento esatto dello scatto (il sistema operativo
// gestisce tutto). Qui costruiamo un vero mirino in pagina via
// getUserMedia — anteprima live dentro una cornice ad angoli in stile
// reflex, con un pulsante di scatto che riproduce un rumore di otturatore
// esattamente nell'istante del tap.
//
// Se getUserMedia non è disponibile o l'utente nega il permesso (webview
// datate, contesti senza fotocamera, permesso negato), si ricade sul
// comportamento precedente passando il click all'<input capture> originale
// — nessuna regressione per chi non può usare il mirino custom.
let viewfinderStream = null;

// Rumore di scatto sintetizzato via Web Audio (due brevi impulsi di
// rumore filtrato, apertura+chiusura otturatore) invece di un file audio
// esterno: nessun asset da scaricare, nessuna questione di licenza,
// funziona anche offline nella PWA.
//
// TOU-20 (audio completamente assente su dispositivo reale, confermato da
// Giuseppe): la funzione creava un nuovo AudioContext ad ogni scatto senza
// mai controllarne lo stato. Su Safari/Chrome mobile un AudioContext può
// nascere "suspended" anche se costruito dentro un gesto utente reale (il
// tap sul pulsante di scatto) — senza un resume() esplicito, i nodi
// programmati non producono alcun suono e non sollevano alcun errore:
// esattamente il sintomo riportato ("nessun suono, neanche l'ombra",
// nessun errore in console). Fix: un solo AudioContext condiviso e
// riusato (creato al primo scatto, quindi già dentro un gesto utente), con
// resume() esplicito prima di programmare i suoni ogni volta che risulta
// "suspended". Il .catch(e=>{}) che inghiottiva ogni errore in silenzio è
// stato sostituito con un console.warn, per non ripetere lo stesso
// problema di diagnosticabilità già risolto per il fallback fotocamera.
let sharedAudioCtx = null;
function getSharedAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx) sharedAudioCtx = new AudioCtx();
  return sharedAudioCtx;
}
function scheduleShutterNoise(ctx) {
  const now = ctx.currentTime;
  [
    { delay: 0, freq: 1800, gain: 0.5 },
    { delay: 0.07, freq: 2800, gain: 0.35 },
  ].forEach(({ delay, freq, gain }) => {
    const bufferSize = Math.floor(ctx.sampleRate * 0.02);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = freq;
    const gainNode = ctx.createGain();
    gainNode.gain.value = gain;
    noise.connect(filter).connect(gainNode).connect(ctx.destination);
    noise.start(now + delay);
    noise.stop(now + delay + 0.02);
  });
}
function playShutterSound() {
  try {
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().then(() => scheduleShutterNoise(ctx)).catch((e) => console.warn("Audio scatto: resume() dell'AudioContext fallito", e));
    } else {
      scheduleShutterNoise(ctx);
    }
  } catch (e) {
    console.warn("Audio scatto non riprodotto", e);
  }
}

function closeViewfinder(overlay) {
  if (viewfinderStream) {
    viewfinderStream.getTracks().forEach((track) => track.stop());
    viewfinderStream = null;
  }
  overlay.remove();
}

// onCapture(dataUrl, mediaType) riceve lo scatto nello stesso formato che
// i chiamanti già ricevevano da FileReader.readAsDataURL su un file
// dell'input nativo — così il codice a valle (handleImageDataUrl,
// runPackageCheck) resta identico indipendentemente da quale delle due
// fotocamere è stata effettivamente usata. fallbackInput è l'<input
// capture> nascosto già presente in pagina, riusato tale e quale se il
// mirino custom non è disponibile.
// Avviso discreto (stesso stile/comportamento del toast di dettatura
// vocale non riconosciuta, vedi addVoiceButton) mostrato quando il mirino
// custom non si apre e si ricade sulla fotocamera nativa — a differenza di
// quel toast, che vive dentro il wrapper di un campo specifico, questo non
// è legato a nessun campo: un solo elemento fisso, creato la prima volta
// che serve e riusato. Permette a chi sta testando da telefono di
// confermare che il fallback è scattato davvero senza dover aprire la
// Console del browser.
let cameraFallbackToastTimer = null;
function showCameraFallbackToast() {
  let toast = document.getElementById("camera-fallback-toast");
  if (!toast) {
    toast = el("div", "camera-fallback-toast");
    toast.id = "camera-fallback-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = "Fotocamera del dispositivo in uso";
  toast.hidden = false;
  clearTimeout(cameraFallbackToastTimer);
  cameraFallbackToastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

function openCameraViewfinder(onCapture, fallbackInput) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.warn("Mirino fotocamera custom non disponibile, uso la fotocamera nativa:", "navigator.mediaDevices.getUserMedia non è supportato da questo browser/contesto");
    showCameraFallbackToast();
    fallbackInput.click();
    return;
  }
  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: "environment" }, audio: false })
    .then((stream) => {
      viewfinderStream = stream;
      const overlay = el("div", "viewfinder-overlay");

      const video = document.createElement("video");
      video.className = "viewfinder-video";
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      overlay.appendChild(video);

      const frame = el("div", "viewfinder-frame");
      frame.innerHTML = `
        <span class="vf-corner vf-tl"></span><span class="vf-corner vf-tr"></span>
        <span class="vf-corner vf-bl"></span><span class="vf-corner vf-br"></span>`;
      overlay.appendChild(frame);

      const closeBtn = el("button", "vf-close", "✕");
      closeBtn.setAttribute("aria-label", "Chiudi fotocamera");
      closeBtn.addEventListener("click", () => closeViewfinder(overlay));
      overlay.appendChild(closeBtn);

      const shutterBtn = el("button", "vf-shutter");
      shutterBtn.setAttribute("aria-label", "Scatta foto");
      shutterBtn.addEventListener("click", () => {
        playShutterSound();
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        closeViewfinder(overlay);
        onCapture(dataUrl, "image/jpeg");
      });
      overlay.appendChild(shutterBtn);

      document.body.appendChild(overlay);
    })
    .catch((err) => {
      console.warn("Mirino fotocamera custom non disponibile, uso la fotocamera nativa:", err);
      showCameraFallbackToast();
      fallbackInput.click();
    });
}

function handleDescribe(label) {
  state.pendingInput = { type: "text", label };
  state.screen = "destination";
  render();
}

loadProfile();
loadPending();
// TOU-14: l'onboarding parte in automatico al lancio SOLO per chi non ha
// mai effettuato l'accesso (registrazione) su questo dispositivo — cioè
// né un profilo salvato (state.touristEmail) né il flag "tg_onboarded"
// (marcato da saveProfile(), e mai rimosso da resetEverything()). Senza
// questo secondo flag, un reset azzererebbe touristEmail e questo stesso
// blocco rilancerebbe l'onboarding ad ogni avvio successivo per chi si era
// già registrato in passato — comportamento indesiderato. Resta comunque
// disponibile su richiesta esplicita da "Rivedi come funziona" nella
// Dashboard, per chiunque (vedi restartOnboarding()).
let hasOnboardedBefore = false;
try {
  hasOnboardedBefore = localStorage.getItem("tg_onboarded") === "1";
} catch (e) {}
if (!hasOnboardedBefore && !state.touristEmail) {
  state.screen = "onboarding";
}
if (state.biometricCredentialId && isBiometricSupported()) {
  state.screen = "biometric-lock";
}
function capturePartnerCode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("partner");
    if (fromUrl) {
      state.activePartnerCode = fromUrl.trim().toUpperCase();
      localStorage.setItem("tg_active_partner", state.activePartnerCode);
    } else {
      const saved = localStorage.getItem("tg_active_partner");
      if (saved) state.activePartnerCode = saved;
    }
  } catch (e) {}
}

capturePartnerCode();

// Percorso "Hai già un account partner? Accedi" dal sito marketing
// (dist/site/index.html, sezione #partner): apre l'app con ?mode=partner
// invece di limitarsi allo scroll sulla sezione di registrazione nuovo
// partner. Stesso principio di capturePartnerCode()/capturePromoCode()
// sopra/sotto — un parametro in query letto una volta all'avvio. Non
// tocca in nessun modo la logica di login (PartnerLoginAndHistory, sotto)
// o l'autenticazione via partner-stats.js: imposta solo la modalità con
// cui l'app parte, così chi arriva da quel link trova già in vista il
// login del componente esistente, senza duplicare nessuna UI sul sito.
function captureModeFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "partner") {
      state.mode = "partner";
    }
  } catch (e) {}
}

captureModeFromUrl();

// Codice invito per l'offerta "prima spedizione a prezzo breakeven".
// A differenza del codice partner, non viene mai mostrato di default:
// compare solo se arriva da un link diretto (?invito=CODICE) o se il
// turista lo digita esplicitamente. Il codice è single-use e viene
// verificato/consumato lato server (netlify/functions/promo.js).
function capturePromoCode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("invito");
    if (fromUrl) {
      state.promoCode = fromUrl.trim().toUpperCase();
    }
  } catch (e) {}
}

async function checkPromoCode(code) {
  const normalized = (code || "").trim().toUpperCase();
  if (!normalized) return;
  state.promoCode = normalized;
  state.promoChecked = false;
  state.promoValid = false;
  render();
  try {
    const res = await fetch("/.netlify/functions/promo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check", code: normalized }),
    });
    const data = await res.json();
    state.promoChecked = true;
    state.promoValid = !!data.valid;
  } catch (e) {
    state.promoChecked = true;
    state.promoValid = false;
  }
  render();
}

function redeemPromoCode() {
  if (!state.promoCode || !state.promoValid || state.promoRedeemedThisOrder) return;
  state.promoRedeemedThisOrder = true;
  fetch("/.netlify/functions/promo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "redeem", code: state.promoCode }),
  }).catch(() => {
    // Se la conferma server-side fallisce, la spedizione resta comunque
    // valida per il turista: il codice andrà verificato manualmente lato
    // admin prima di essere riutilizzato per un nuovo invito.
  });
}

capturePromoCode();
if (state.promoCode) checkPromoCode(state.promoCode);
loadHistory();

// Spazio ospite (continuità operativa, vedi MANUALE.md): GUEST_MODE è una
// variabile d'ambiente Netlify letta solo dalle Netlify Functions — questo
// file statico servito da dist/ non ha modo di leggerla direttamente
// (nessun build step in questo repository che possa iniettarla). Un
// endpoint minimo e non sensibile (guest-status.js) la espone come
// booleano; se la chiamata fallisce (offline, funzione irraggiungibile)
// il banner resta semplicemente nascosto — mai un falso positivo che
// mostri "spazio ospite" su un deploy che non lo è davvero.
async function checkGuestMode() {
  try {
    const res = await fetch("/.netlify/functions/guest-status");
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.guestMode) {
      state.guestMode = true;
      render();
    }
  } catch (e) {}
}

// Un punto di ritiro scelto a mano in una sessione precedente ha priorità
// sulla rilevazione automatica GPS/rete al prossimo avvio — altrimenti
// loadLocation() lo sovrascriverebbe sempre, impedendo di continuare ad
// aggiungere acquisti da una città diversa da dove ci si trova ora. Il
// turista può tornare al rilevamento automatico in qualsiasi momento dal
// pulsante "Usa la mia posizione attuale" in PickupField().
let manualPickupAtStartup = null;
try {
  manualPickupAtStartup = localStorage.getItem("tg_manual_pickup");
} catch (e) {}
if (manualPickupAtStartup) {
  state.pickupPoint = manualPickupAtStartup;
  state.pickupSource = null;
}
render();
if (!manualPickupAtStartup) loadLocation();
syncPurchaseUpdatesFromCRM();
discoverPurchasesByEmail();
checkGuestMode();

window.addEventListener("online", () => {
  state.isOffline = false;
  render();
});
window.addEventListener("offline", () => {
  state.isOffline = true;
  render();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
