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
    note: "Bagaglio extra fino a 23kg — il prezzo varia in base alla rotta (soprattutto Africa/Americhe, dove Qatar applica un prezzo fisso a pezzo). ATTENZIONE: per la maggior parte delle rotte, incluse quelle da/per l'Europa, Qatar applica invece un sistema \"a peso\" (circa USD 30/kg online, USD 40/kg in aeroporto, a scatti di 5kg) — da verificare se per il caso d'uso Touch&Go (turisti in Europa) non sia questo il feeType corretto da modellare, non quello a pezzo qui riportato.",
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
];

// Deliberatamente ESCLUSE (settembre 2026): nessuna fonte ufficiale pulita
// verificata per queste compagnie al momento della stesura — meglio
// un'assenza dichiarata che un dato inventato o preso da un aggregatore
// terzo non ufficiale. Da aggiungere in un aggiornamento futuro, quando
// disponibile una fonte ufficiale diretta.
// Wizz Air, Vueling, Volotea, Transavia.

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
