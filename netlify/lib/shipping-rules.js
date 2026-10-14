// Base di conoscenza sulle regole di spedizione per Paese di destinazione,
// usata dalle AI interrogabili (assistente, classificatore) al posto di una
// frase generica. Fatti ESTRATTI e sintetizzati (non copiati) da fonti
// ufficiali, ognuno con fonte e data di verifica. Ricerca del 14/10/2026,
// vedi il documento "FDA Prior Notice: ricerche per le spedizioni Touch&Go".
//
// Le regole cambiano: ogni voce va riverificata (il controllo settimanale
// segnala le fonti irraggiungibili) e `verifiedAt` aggiornato. L'AI deve
// citarle come orientamento, mai come consulenza legale, e non inventare
// regole di Paesi che non sono qui. La presentazione ufficiale (es. su FDA
// PNSI) resta allo staff: questa base non sostituisce nessuna pratica.
const VERIFIED_AT = "2026-10-14";

const RULES = [
  {
    id: "usa-prior-notice",
    countries: ["USA", "Stati Uniti", "United States"],
    summary:
      "Per gli alimenti spediti negli USA (anche per posta) serve la Prior Notice FDA, una per ogni prodotto diverso, con il numero di conferma sul pacco. Anticipo minimo: 4 ore per aereo o treno, 2 per strada, 8 per mare. Dal 1/10/2026 la posta richiede il tracking. Regali privati non commerciali: tollerati; bagaglio personale: esente. Per alcolici serve anche TTB/COLA, per carne e salumi USDA/APHIS (spesso vietati), per i formaggi controlli specifici.",
    sources: ["https://www.fda.gov/regulatory-information/search-fda-guidance-documents/guidance-industry-what-you-need-know-about-prior-notice-imported-food-shipments"],
  },
  {
    id: "canada-alimenti",
    countries: ["Canada"],
    summary:
      "Uso personale esente entro i limiti CFIA (la maggior parte dei solidi 20 kg, liquidi 20 L). Da Paesi diversi dagli USA carne fresca, essiccata e stagionata (prosciutto, salsicce) non è ammessa e la carne non può viaggiare per posta o corriere; i latticini si limitano a gelato, yogurt e formaggio pastorizzato. Gli importatori commerciali hanno bisogno della licenza SFC.",
    sources: ["https://inspection.canada.ca/travel/eng/1389630031549/1389630282362", "https://cbsa-asfc.gc.ca/publications/cn-ad/cn24-03-eng.html"],
  },
  {
    id: "giappone-alimenti",
    countries: ["Giappone", "Japan"],
    summary:
      "L'import commerciale di alimenti richiede una notifica alla stazione di quarantena del ministero della salute prima dello sdoganamento (Food Sanitation Act, art. 27); carne e latticini anche certificato sanitario del Paese esportatore. L'uso personale è esente.",
    sources: ["https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/shokuhin/yunyu_kanshi/kanshi/index_00004.html"],
  },
  {
    id: "cina-alimenti",
    countries: ["Cina", "China"],
    summary:
      "Dal 1/6/2026 il Decreto 280 prevede la registrazione dei produttori alimentari esteri; l'e-commerce transfrontaliero al dettaglio è oggi trattato come uso personale, ma potrebbe cambiare.",
    sources: ["https://www.china-briefing.com/news/gac-overseas-food-manufacturer-registration-china-new-rules-2026/"],
  },
  {
    id: "regno-unito-alimenti",
    countries: ["Regno Unito", "UK", "United Kingdom"],
    summary:
      "Alimenti ad alto rischio e prodotti di origine animale richiedono la pre-notifica IPAFFS, anche dall'UE (esclusa l'Irlanda). Dettagli sull'importazione privata di carne e latticini non verificati.",
    sources: ["https://www.gov.uk/government/publications/notifying-authorities-of-high-risk-food-and-feed-imports/notifying-authorities-of-high-risk-food-and-feed-imports"],
  },
  {
    id: "australia-posta",
    countries: ["Australia"],
    summary:
      "Nessuna notifica preventiva, ma la dichiarazione postale deve essere dettagliata (niente termini vaghi come «regalo»). Tutta la posta è controllata; i prodotti non conformi vengono distrutti o rimandati indietro, con un trattamento a pagamento.",
    sources: ["https://www.agriculture.gov.au/biosecurity-trade/travelling/bringing-mailing-goods/mail"],
  },
  {
    id: "corea-sud-alimenti",
    countries: ["Corea del Sud", "South Korea", "Korea"],
    summary:
      "Esiste una linea guida del MFDS sugli ingredienti vietati negli alimenti acquistati online dall'estero. Obbligo di notifica e limiti personali non verificati.",
    sources: ["https://food.chemlinked.com/news/food-news/south-korea-to-designate-prohibited-ingredients-of-online-purchased-overseas-food"],
  },
  {
    id: "non-verificati",
    countries: ["Emirati Arabi", "UAE", "India", "Svizzera", "Switzerland", "Brasile", "Brazil"],
    summary:
      "Regole per l'uso personale non verificate per questo Paese: non inventarle, consiglia di verificare con il supporto Touch&Go o con le autorità doganali.",
    sources: [],
  },
];

// Regole che valgono per le spedizioni verso l'Italia dall'esterno dell'UE.
const GENERAL = {
  summary:
    "Verso l'Italia da Paesi extra-UE, carne, latte e derivati sono vietati nelle importazioni private, anche per posta (Reg. UE 2019/2122); eccezioni: latte in polvere per lattanti e alimenti medici fino a 2 kg, altri prodotti animali come il miele fino a 2 kg, pesce fino a 20 kg.",
  sources: ["https://food.ec.europa.eu/animals/animal-products-movements/personal-imports_en"],
};

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// Regole pertinenti a una destinazione (nome libero, come nel selettore
// dell'app). Nessun Paese riconosciuto -> lista vuota.
function rulesForDestination(destination) {
  const d = norm(destination);
  if (!d) return [];
  return RULES.filter((r) => r.countries.some((c) => norm(c) === d || d.includes(norm(c))));
}

function formatRule(r) {
  return `- ${r.countries[0]}: ${r.summary}` + (r.sources.length ? ` (fonti: ${r.sources.join(" ; ")})` : "");
}

// Testo da dare all'AI. Con una destinazione: solo le sue regole (se ce
// ne sono), altrimenti l'elenco completo.
function buildRulesContext(destination) {
  const specific = destination ? rulesForDestination(destination) : [];
  const rules = specific.length ? specific : RULES;
  return (
    `REGOLE DI SPEDIZIONE PER PAESE (verificate il ${VERIFIED_AT} su fonti ufficiali; orientamento, non consulenza legale). ` +
    "Usa SOLO queste regole, non inventarne altre per altri Paesi: se il Paese non è qui, di' che non è verificato e consiglia di controllare col supporto Touch&Go.\n" +
    rules.map(formatRule).join("\n") +
    `\n- Verso l'Italia: ${GENERAL.summary}`
  );
}

module.exports = { VERIFIED_AT, RULES, GENERAL, rulesForDestination, buildRulesContext };
