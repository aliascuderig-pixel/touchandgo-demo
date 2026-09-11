// Logica statistica per categoria, condivisa da save-purchase.js (regole
// anti-frode 3/6, "valore/peso anomalo per la categoria") e da
// category-averages.js (cache offline dei valori medi, vedi MANUALE.md,
// sezione "Percorso offline — classificazione provvisoria"). Estratta qui
// invece di duplicata: prima di questa modifica isCategoryOutlier() viveva
// solo in save-purchase.js — la nuova funzione categoryAverage() condivide
// la stessa identica logica di filtro/soglia campione, quindi un'unica
// implementazione qui evita due copie che potrebbero divergere nel tempo.

// Le 10 categorie restituite dall'AI di classificazione (CLASSIFY_SCHEMA in
// dist/assets/app.js) — duplicate qui deliberatamente, stesso principio già
// in uso ovunque in questo repository per valori condivisi tra client e
// funzioni serverless (nessun modulo condiviso tra i due lati): se
// CLASSIFY_SCHEMA cambia, questo elenco va aggiornato di conseguenza.
const CATEGORIES = [
  "Ceramica",
  "Abbigliamento",
  "Alimentari",
  "Vino & Spirits",
  "Accessori Moda",
  "Arte & Antiquariato",
  "Gioielleria",
  "Artigianato",
  "Attrezzatura sportiva",
  "Altro",
];

// Valori di default RAGIONEVOLI (non derivati da dati reali) usati per una
// categoria quando il campione di acquisti reali è sotto
// CATEGORY_ANOMALY_MIN_SAMPLE (vedi sotto) — servono SOLO a dare un prezzo
// provvisorio di partenza plausibile nel percorso offline (vedi
// buildProvisionalResult() in dist/assets/app.js) quando non c'è ancora
// abbastanza storico reale per una media significativa. Stime a spanne di
// un oggetto "tipico" per categoria, in linea con cosa un turista
// realisticamente compra: un vaso/oggetto in ceramica, un capo piegato, un
// prodotto alimentare confezionato, una bottiglia, una borsa/scarpe, un
// pezzo d'arte/mobile piccolo, un gioiello in scatola, un oggetto
// artigianale generico, attrezzatura sportiva (più ingombrante), o un
// oggetto generico ("Altro").
const CATEGORY_DEFAULTS = {
  Ceramica: { weightKg: 1.5, dims: { length_cm: 25, width_cm: 20, height_cm: 15 } },
  Abbigliamento: { weightKg: 0.6, dims: { length_cm: 35, width_cm: 25, height_cm: 5 } },
  Alimentari: { weightKg: 1.0, dims: { length_cm: 20, width_cm: 15, height_cm: 10 } },
  "Vino & Spirits": { weightKg: 1.5, dims: { length_cm: 10, width_cm: 10, height_cm: 32 } },
  "Accessori Moda": { weightKg: 0.8, dims: { length_cm: 30, width_cm: 25, height_cm: 12 } },
  "Arte & Antiquariato": { weightKg: 3.0, dims: { length_cm: 40, width_cm: 30, height_cm: 10 } },
  Gioielleria: { weightKg: 0.2, dims: { length_cm: 10, width_cm: 8, height_cm: 5 } },
  Artigianato: { weightKg: 1.2, dims: { length_cm: 25, width_cm: 20, height_cm: 15 } },
  "Attrezzatura sportiva": { weightKg: 2.5, dims: { length_cm: 60, width_cm: 30, height_cm: 20 } },
  Altro: { weightKg: 1.0, dims: { length_cm: 25, width_cm: 20, height_cm: 15 } },
};

// Soglie condivise dalle regole statistiche anti-frode (save-purchase.js,
// "valore anomalo"/"peso anomalo") e dalla cache dei valori medi per
// categoria (category-averages.js): 3x la media evita falsi positivi sulla
// normale variazione tra oggetti simili; campione minimo di 5 evita di
// considerare significativa una media calcolata su troppo pochi acquisti
// reali.
const CATEGORY_ANOMALY_MULTIPLIER = 3;
const CATEGORY_ANOMALY_MIN_SAMPLE = 5;

function numericValues(items, getValue) {
  return items.map(getValue).filter((v) => typeof v === "number" && isFinite(v));
}

// Media di un valore (letto da ciascun item tramite getValue) sugli item
// forniti, o null se il campione è sotto CATEGORY_ANOMALY_MIN_SAMPLE — sotto
// quella soglia una media non è un riferimento statisticamente
// significativo, meglio lasciare che il chiamante decida il proprio
// fallback (isCategoryOutlier sotto: nessun flag; categoryAverages in
// category-averages.js: CATEGORY_DEFAULTS sopra).
function categoryAverage(items, getValue) {
  const values = numericValues(items, getValue);
  if (values.length < CATEGORY_ANOMALY_MIN_SAMPLE) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// currentValue è anomalo se supera CATEGORY_ANOMALY_MULTIPLIER volte la
// media di `field` calcolata sugli item forniti (tipicamente: tutti gli
// ALTRI acquisti della stessa categoria, mai includendo l'acquisto
// corrente) — nessun flag se il campione è insufficiente.
function isCategoryOutlier(categoryItems, field, currentValue) {
  if (typeof currentValue !== "number" || !isFinite(currentValue)) return false;
  const avg = categoryAverage(categoryItems, (it) => it[field]);
  if (avg === null) return false;
  return currentValue > avg * CATEGORY_ANOMALY_MULTIPLIER;
}

module.exports = {
  CATEGORIES,
  CATEGORY_DEFAULTS,
  CATEGORY_ANOMALY_MULTIPLIER,
  CATEGORY_ANOMALY_MIN_SAMPLE,
  categoryAverage,
  isCategoryOutlier,
};
