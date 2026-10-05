// Dati di riferimento sulle tariffe di sovrappeso/bagaglio extra delle
// compagnie aeree — SOLO informativi, mai usati per calcolare un prezzo
// Touch&Go (vedi ../lib/pricing.js, mai importato da qui e viceversa).
// Servono a mostrare al turista, in ConcludeScreen (dist/assets/app.js),
// quanto pagherebbe la compagnia aerea per portare lo stesso peso come
// bagaglio extra — a confronto col prezzo Touch&Go. Vedi MANUALE.md,
// sezione "Confronto costo bagaglio extra compagnia aerea".
//
// AGGIORNAMENTO SETTIMANALE AUTOMATICO: questo file è pensato per essere
// riscritto da un processo esterno che verifica periodicamente le fonti
// ufficiali di ciascuna compagnia — struttura DELIBERATAMENTE semplice
// (un array piatto di oggetti, nessuna classe/logica annidata) per restare
// facile da rigenerare in automatico. Un airline può comparire in PIÙ
// voci (una per ciascuna combinazione feeType/routeClass/travelClass che
// la fonte distingue) — non un oggetto per compagnia.
//
// amountMin/amountMax invece di un singolo "amount": quasi tutte le fonti
// reali pubblicano un RANGE (varia per rotta/tariffa/canale d'acquisto),
// non un valore secco — scegliere un singolo numero nel mezzo
// falsificherebbe il dato sorgente. Per una tariffa flat (es. Ryanair/
// easyJet, €/kg fisso) amountMin === amountMax.
//
// feeType:
//   "per_kg_overweight" — tariffa per kg di sovrappeso: amountMin/Max è il
//     prezzo PER KG, non il totale (vedi estimateAirlineBaggageCost() in
//     dist/assets/app.js per il calcolo).
//   "per_extra_piece" — costo FISSO per un pezzo/bagaglio extra,
//     indipendente dal peso (entro i limiti di peso massimo della
//     compagnia, non modellati qui).
//   "variable_by_fare" — nessun numero affidabile da mostrare (sistema
//     tariffario troppo complesso/dipendente dalla tariffa specifica per
//     ridurlo a un range onesto): amountMin/amountMax sono null, "note"
//     spiega perché e rimanda alla compagnia.
//
// routeClass: "eu" (voli nazionali/UE/UK/Svizzera — vedi
//   routeClassForZone() in dist/assets/app.js, che la deriva dalla zona
//   tariffaria Touch&Go già esistente in DESTINATIONS) | "intercontinental"
//   | null quando la fonte non distingue per rotta (tariffa unica).
//
// travelClass: "economy" | "business" | null quando la fonte non
//   distingue per classe di viaggio (il caso di quasi tutte le voci qui:
//   nessuna delle fonti verificate il 2026-09-30 pubblica un numero
//   diverso per Business, tranne l'effetto indiretto della tariffa
//   "Economy Basic" di Lufthansa Group, già catturato come nota — non un
//   numero — alla voce Lufthansa).
//
// currency: valuta ORIGINALE della fonte ("EUR" o "USD") — MAI un tasso di
// cambio salvato qui: il tasso cambia, l'importo in valuta originale resta
// l'unica fonte di verità. La conversione approssimativa USD->EUR per la
// UI vive SOLO lato client (vedi convertToEurApprox() in app.js), mai in
// questo file.
//
// Trattare questi dati come riferimento NON garantito al 100%: tariffe
// reali variano per tariffa specifica, rotta e canale di acquisto — da
// qui il disclaimer sempre visibile in UI (vedi
// AIRLINE_BAGGAGE_DISCLAIMER_TEMPLATE sotto).
const AIRLINE_BAGGAGE_FEES = [
  {
    airline: "Ryanair",
    feeType: "per_kg_overweight",
    routeClass: null,
    travelClass: null,
    amountMin: 13,
    amountMax: 13,
    currency: "EUR",
    sourceUrl: "https://www.ryanair.com/it/it/lp/bagaglio",
    verifiedAt: "2026-09-30",
    note: null,
  },
  {
    airline: "easyJet",
    feeType: "per_kg_overweight",
    routeClass: null,
    travelClass: null,
    amountMin: 15,
    amountMax: 15,
    currency: "EUR",
    sourceUrl: "https://www.easyjet.com/it/bagaglio",
    verifiedAt: "2026-09-30",
    note: null,
  },
  {
    airline: "KLM",
    feeType: "per_extra_piece",
    routeClass: "eu",
    travelClass: null,
    amountMin: 20,
    amountMax: 70,
    currency: "EUR",
    sourceUrl: "https://www.klm.it/informazioni/bagagli",
    verifiedAt: "2026-09-30",
    note: null,
  },
  {
    airline: "KLM",
    feeType: "per_extra_piece",
    routeClass: "intercontinental",
    travelClass: null,
    amountMin: 30,
    amountMax: 240,
    currency: "EUR",
    sourceUrl: "https://www.klm.it/informazioni/bagagli",
    verifiedAt: "2026-09-30",
    note: null,
  },
  {
    airline: "KLM",
    feeType: "per_kg_overweight",
    routeClass: "eu",
    travelClass: null,
    amountMin: 75,
    amountMax: 100,
    currency: "EUR",
    sourceUrl: "https://www.klm.it/informazioni/bagagli",
    verifiedAt: "2026-09-30",
    note: null,
  },
  {
    airline: "KLM",
    feeType: "per_kg_overweight",
    routeClass: "intercontinental",
    travelClass: null,
    amountMin: 100,
    amountMax: 300,
    currency: "EUR",
    sourceUrl: "https://www.klm.it/informazioni/bagagli",
    verifiedAt: "2026-09-30",
    note: null,
  },
  {
    // "Pezzo extra dall'Italia" — 2° pezzo. Il 3° pezzo è una voce
    // separata sotto: sono due fasce di prezzo distinte della stessa
    // fonte, non un range unico dei due.
    airline: "ITA Airways",
    feeType: "per_extra_piece",
    routeClass: null,
    travelClass: null,
    amountMin: 65,
    amountMax: 85,
    currency: "EUR",
    sourceUrl: "https://www.ita-airways.com/it_it/fly-ita/baggage.html",
    verifiedAt: "2026-09-30",
    note: "Prezzo del 2° pezzo extra dall'Italia (il 3° pezzo costa 150-200€) — varia per canale di acquisto.",
  },
  {
    airline: "Lufthansa Group",
    feeType: "variable_by_fare",
    routeClass: null,
    travelClass: null,
    amountMin: null,
    amountMax: null,
    currency: "EUR",
    sourceUrl: "https://www.lufthansa.com/it/it/uebergepaeck",
    verifiedAt: "2026-10-05",
    note: "Sistema a livelli tariffari complesso: dalla nuova tariffa \"Economy Basic\" (da aprile 2026) il bagaglio a mano non è più incluso. ITA Airways è esplicitamente esclusa da questa modifica. Nessun importo secco affidabile: verifica la tua tariffa specifica sul sito Lufthansa.",
  },
  // Qatar Airways ha due sistemi tariffari distinti e paralleli (non uno
  // sbagliato da sostituire con l'altro — Giuseppe, 5/10: "devi inserirle
  // entrambe"): a pezzo su alcune rotte, a peso sulla maggior parte delle
  // altre, incluse quelle Europa-Doha più rilevanti per i turisti Touch&Go.
  // Stesso pattern già in uso per KLM (più voci per la stessa compagnia,
  // disambiguate da feeType/note quando la fonte non fornisce un routeClass
  // netto) — qui "note" distingue esplicitamente a quali rotte si applica
  // ciascuna, dato che la fonte non lo esprime con un routeClass pulito
  // "eu"/"intercontinental" come KLM.
  {
    airline: "Qatar Airways",
    feeType: "per_extra_piece",
    routeClass: null,
    travelClass: null,
    amountMin: 130,
    amountMax: 255,
    currency: "USD",
    sourceUrl: "https://www.qatarairways.com/it-it/baggage.html",
    verifiedAt: "2026-09-30",
    note: "Bagaglio extra fino a 23kg a prezzo fisso per pezzo — si applica soprattutto sulle rotte Africa/Americhe. Per le rotte Europa-Doha (vedi voce 'per_kg_overweight' qui sotto) si applica invece il sistema a peso, non questo.",
  },
  {
    airline: "Qatar Airways",
    feeType: "per_kg_overweight",
    routeClass: null,
    travelClass: null,
    amountMin: 30,
    amountMax: 40,
    currency: "USD",
    sourceUrl: "https://www.qatarairways.com/it-it/baggage.html",
    verifiedAt: "2026-10-05",
    note: "Sistema a peso, a scatti di 5kg: USD 30/kg se acquistato online, USD 40/kg in aeroporto. Si applica sulla maggior parte della rete, incluse le rotte Europa-Doha — il caso più rilevante per i turisti Touch&Go. Pagina ufficiale Qatar Airways non raggiungibile da questa sessione (nessun importo fisso nel testo statico della pagina, solo calcolatore dinamico) — dato confermato da due ricerche indipendenti coerenti tra loro, da riverificare contro la fonte ufficiale quando possibile.",
  },
  {
    airline: "Turkish Airlines",
    feeType: "per_extra_piece",
    routeClass: null,
    travelClass: null,
    amountMin: 100,
    amountMax: 120,
    currency: "USD",
    sourceUrl: "https://www.turkishairlines.com/en-int/any-questions/excess-baggage/terms-and-conditions/",
    verifiedAt: "2026-10-05",
    note: "Il prezzo varia a seconda che il volo sia diretto o in coincidenza (upgrade bagaglio da 23kg a 32kg: USD 100 voli diretti, USD 120 voli con tratte aggiuntive).",
  },
  // ---- 5 compagnie aggiunte il 5/10/2026, su richiesta esplicita di
  // Giuseppe ("AGGIUNGI") dopo la verifica settimanale di quel giorno ----
  {
    airline: "Wizz Air",
    feeType: "per_kg_overweight",
    routeClass: null,
    travelClass: null,
    amountMin: 13,
    amountMax: 13,
    currency: "EUR",
    sourceUrl: "https://www.cabinzero.com/blogs/air-travel-tips/wizz-air-baggage-allowance",
    verifiedAt: "2026-10-05",
    note: "Sovrappeso pagabile in aeroporto. Pagina ufficiale Wizz Air non raggiungibile da questa sessione (404 su più URL tentati) — dato confermato da una fonte secondaria indipendente, non dal sito della compagnia: da riverificare quando possibile contro la fonte ufficiale.",
  },
  {
    airline: "Vueling",
    feeType: "per_kg_overweight",
    routeClass: null,
    travelClass: null,
    amountMin: 12,
    amountMax: 12,
    currency: "EUR",
    sourceUrl: "https://www.infobae.com/espana/viajes/2025/10/15/este-es-el-precio-del-equipaje-facturado-en-vueling-en-2025-condiciones-pesos-permitidos-y-tipos-de-vuelo/",
    verifiedAt: "2026-10-05",
    note: "€12/kg al check-in, oltre i 25kg fino a un massimo di 32kg. Se il sovrappeso viene gestito al gate la tariffa sale a 110-140€ a pezzo. Pagina ufficiale Vueling non raggiungibile da questa sessione (404) — dato da fonte secondaria indipendente, da riverificare contro la fonte ufficiale quando possibile.",
  },
  {
    airline: "Volotea",
    feeType: "per_kg_overweight",
    routeClass: null,
    travelClass: null,
    amountMin: 12,
    amountMax: 12,
    currency: "EUR",
    sourceUrl: "https://www.volotea.com/it/bagaglio",
    verifiedAt: "2026-10-05",
    note: "Sovrappeso oltre il massimo consentito per valigia, fino a un massimo di 32kg. Bagaglio extra (non sovrappeso) ha invece 3 fasce di prezzo secondo il canale di acquisto (online/check-in/gate, da 9€ a oltre 65€) — qui modellato solo il sovrappeso, per coerenza con la struttura delle altre voci del dataset.",
  },
  {
    airline: "Transavia",
    feeType: "per_kg_overweight",
    routeClass: null,
    travelClass: null,
    amountMin: 15,
    amountMax: 15,
    currency: "EUR",
    sourceUrl: "https://www.transavia.com/aide/fr-fr/bagages/bagages-en-soute/tarifs-bagages-soute",
    verifiedAt: "2026-10-05",
    note: "Tariffa di sovrappeso in aeroporto (fonte ufficiale confermata). Acquistare bagaglio extra online in anticipo costa sensibilmente meno (es. 20kg: 36,99€ online contro 80€ in aeroporto) — qui modellato solo il sovrappeso last-minute, per coerenza con la struttura delle altre voci.",
  },
  {
    airline: "American Airlines",
    feeType: "per_extra_piece",
    routeClass: null,
    travelClass: null,
    amountMin: 60,
    amountMax: 100,
    currency: "USD",
    sourceUrl: "https://www.aa.com/i18n/travel-info/baggage/checked-baggage-policy.jsp",
    verifiedAt: "2026-10-05",
    note: "Prezzo del 2° bagaglio, variabile per rotta (55 USD online sui voli domestici, fino a 100 USD su rotte transatlantiche/transpacifiche). Il 3° bagaglio ha una tariffa fissa separata di 200 USD, non inclusa in questo range. Il sovrappeso (23-32kg) ha una tariffa separata a fasce (100 USD fino a 32kg, 200-450 USD oltre) — non modellata qui, per restare coerenti con la struttura a singola voce del dataset.",
  },
];

// Deliberatamente ESCLUSE ancora (5 ottobre 2026): nessuna fonte ufficiale
// pulita verificata per queste compagnie — meglio un'assenza dichiarata
// che un dato inventato o preso da un aggregatore terzo non ufficiale.
// Da aggiungere in un aggiornamento futuro, quando disponibile una fonte
// ufficiale diretta: British Airways (bagaglio extra senza prezzo fisso
// pubblicato, solo calcolatore dinamico), Air France (importi EUR non
// pubblicati come tabella fissa, solo al momento dell'acquisto), Emirates
// (sconto online dichiarato in modo ambiguo tra due pagine del sito, non
// chiarito a cosa si applichi esattamente).

// Elenco (deduplicato, ordine alfabetico) dei nomi compagnia presenti nel
// dataset — usato per popolare il selettore in UI, mai hardcoded altrove.
function airlineNames() {
  return Array.from(new Set(AIRLINE_BAGGAGE_FEES.map((f) => f.airline))).sort((a, b) => a.localeCompare(b));
}

// La data di verifica più recente tra tutte le voci — usata nel
// disclaimer mostrato in UI ("verificati il [data]"). Tutte le voci
// condividono oggi la stessa verifiedAt (2026-09-30): questa funzione
// calcola comunque il massimo reale invece di leggere una costante,
// perché un aggiornamento settimanale futuro potrà aggiornare le voci una
// alla volta, non necessariamente tutte insieme.
function mostRecentVerifiedAt(fees) {
  const list = fees || AIRLINE_BAGGAGE_FEES;
  if (!list.length) return null;
  return list.reduce((latest, f) => (f.verifiedAt > latest ? f.verifiedAt : latest), list[0].verifiedAt);
}

module.exports = {
  AIRLINE_BAGGAGE_FEES,
  airlineNames,
  mostRecentVerifiedAt,
};
