// Sezione «Usato» dell'E-shop (17 ottobre 2026) — logica comune.
//
// COPIA IDENTICA (verbatim) in touchandgo-eshop, touchandgo-demo e
// touchandgo-gestionale: nessun modulo condiviso tra repository, ma questo
// file deve restare UGUALE in tutti e tre. Chi mette in vendita (app
// turista, gestionale abbonati) e chi vende (E-shop) devono interpretare
// allo stesso modo l'acquisto, il prezzo e la commissione.
//
// Un acquisto Touch&Go già consegnato diventa un annuncio nello store
// condiviso "eshop-used" con UN clic. L'id dell'annuncio è CASUALE
// ("U-" + 10 esadecimali): non contiene mai l'id dell'acquisto, che è
// metà della credenziale di accesso all'E-shop e non deve diventare
// pubblico. Un acquisto ha al massimo un annuncio: la corrispondenza
// acquisto -> annuncio sta nello store "eshop-used-index" (mai pubblico).
const crypto = require("crypto");
const USED_STORE = "eshop-used";
const INDEX_STORE = "eshop-used-index";
const LISTING_ID_RE = /^U-[A-F0-9]{10}$/;
const CONFIG_STORE = "eshop-config";
const CONFIG_KEY = "used";

// Commissione Touch&Go sul prezzo dell'oggetto: 20% (decisione di Giuseppe),
// modificabile dal CRM (store "eshop-config"). Ogni annuncio ne conserva una
// copia (commissionRate, la tariffa NORMALE) presa al momento della messa in
// vendita; la commissione che vale per un ordine è quella dell'annuncio, a
// meno che al momento dell'ordine la promozione sia attiva (allora 0), mai un
// valore mandato dal client.
const DEFAULT_COMMISSION_RATE = 0.2;
const MAX_COMMISSION_RATE = 0.5;

const CONDITIONS = ["Nuovo con cartellino", "Come nuovo", "Buono", "Discreto"];
const MAX_PRICE_EUR = 5000;

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function newListingId() {
  return "U-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function normalizeCommissionRate(value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!isFinite(n) || n < 0 || n > MAX_COMMISSION_RATE) return DEFAULT_COMMISSION_RATE;
  return Math.round(n * 10000) / 10000;
}

// PROMOZIONE (17/10/2026, decisione di Giuseppe): per ora la commissione è
// GRATUITA per tutti, come promozione e come spinta positiva verso
// l'abbonamento. La tariffa normale (20%) resta scritta in configurazione e
// sugli annunci; finché la promozione è attiva la commissione applicata è 0.
// Si spegne dal CRM (promoActive:false) o da sola alla data promoUntil.
// Senza alcuna configurazione salvata la promozione è ATTIVA.
//
// configStore = getStore("eshop-config") (guest-scoped dal chiamante).
async function getCommissionConfig(configStore, now) {
  const cfg = (await configStore.get(CONFIG_KEY, { type: "json" })) || {};
  const t = typeof now === "number" ? now : Date.now();
  const until = typeof cfg.promoUntil === "string" ? Date.parse(cfg.promoUntil) : NaN;
  const promoActive = cfg.promoActive !== false && !(isFinite(until) && until <= t);
  const rate = normalizeCommissionRate(cfg.commissionRate);
  return { rate, promoActive, promoUntil: isFinite(until) ? cfg.promoUntil : null, effectiveRate: promoActive ? 0 : rate };
}
// Tariffa NORMALE (quella che si congela sull'annuncio).
async function getCommissionRate(configStore) {
  return (await getCommissionConfig(configStore)).rate;
}

// Calcolo in centesimi: nessun errore di arrotondamento sui soldi.
function computeSale(priceEur, rate) {
  const priceCents = Math.round(priceEur * 100);
  const commissionCents = Math.round(priceCents * normalizeCommissionRate(rate));
  return { priceCents, commissionCents, sellerNetCents: priceCents - commissionCents };
}

function parsePrice(value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!isFinite(n) || n <= 0 || n > MAX_PRICE_EUR) return null;
  return Math.round(n * 100) / 100;
}

// Un acquisto si può mettere in vendita solo se: è un oggetto (non un
// bagaglio), il cliente ne ha confermato la consegna (ce l'ha in mano) e
// non è un'asta ancora senza destinazione.
function checkSellable(purchase) {
  if (!purchase) return { ok: false, reason: "Acquisto non trovato." };
  if (purchase.shipmentKind === "bagaglio") return { ok: false, reason: "I bagagli non si possono mettere in vendita." };
  if (purchase.status === "in attesa destinazione") return { ok: false, reason: "La spedizione non è ancora completata." };
  if (!purchase.deliveryConfirmedAt) {
    return { ok: false, reason: "Potrai metterlo in vendita dopo aver confermato di averlo ricevuto." };
  }
  if (!purchase.objectName) return { ok: false, reason: "Acquisto senza descrizione." };
  return { ok: true };
}

function describePurchase(p) {
  const parts = [String(p.objectName).trim()];
  const bits = [];
  if (p.category) bits.push("Categoria: " + p.category);
  if (p.material) bits.push("Materiale: " + p.material);
  const d = p.dims || p.packageDims;
  if (d && d.length_cm && d.width_cm && d.height_cm) {
    bits.push("Dimensioni: " + d.length_cm + " × " + d.width_cm + " × " + d.height_cm + " cm");
  }
  if (typeof p.weightKg === "number" && p.weightKg > 0) bits.push("Peso: " + p.weightKg + " kg");
  if (bits.length) parts.push(bits.join(" · "));
  return parts.join("\n");
}

// Nome mostrato al pubblico: solo nome di battesimo + iniziale del cognome.
function publicSellerName(fullName) {
  const words = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "Cliente Touch&Go";
  const first = words[0].slice(0, 30);
  return words.length > 1 ? first + " " + words[words.length - 1][0].toUpperCase() + "." : first;
}

// Costruisce l'annuncio dall'acquisto. Il prezzo di partenza è il valore
// dichiarato dell'oggetto (itemValue): il cliente non deve fare nulla, può
// poi cambiarlo dall'E-shop. Senza valore dichiarato l'annuncio resta
// «bozza» (non pubblico) finché non si indica un prezzo.
function buildListing(purchase, opts) {
  const o = opts || {};
  const price = parsePrice(purchase.itemValue);
  return {
    id: o.id || newListingId(),
    purchaseId: purchase.id,
    status: price ? "in vendita" : "bozza",
    listedAt: new Date(typeof o.now === "number" ? o.now : Date.now()).toISOString(),
    title: String(purchase.objectName).trim().slice(0, 200),
    description: describePurchase(purchase).slice(0, 2000),
    category: purchase.category || null,
    material: purchase.material || null,
    condition: null,
    photo: purchase.photo || null,
    weightKg: typeof purchase.weightKg === "number" ? purchase.weightKg : null,
    dims: purchase.dims || purchase.packageDims || null,
    originCountry: purchase.country || null,
    price: price,
    originalValue: typeof purchase.itemValue === "number" ? purchase.itemValue : null,
    commissionRate: normalizeCommissionRate(o.commissionRate),
    sellerName: publicSellerName(purchase.touristName),
    // PRIVATI: non escono mai da publicListing().
    sellerEmail: normalizeEmail(purchase.touristEmail),
    sellerCode: typeof o.sellerCode === "string" ? o.sellerCode : null,
  };
}

// Vista pubblica: niente email, codice abbonato, id dell'acquisto.
function publicListing(l) {
  return {
    id: l.id,
    title: l.title,
    description: l.description,
    category: l.category,
    material: l.material,
    condition: l.condition,
    photo: l.photo,
    price: l.price,
    sellerName: l.sellerName,
    originCountry: l.originCountry,
    listedAt: l.listedAt,
    commissionRate: l.commissionRate,
  };
}

// Crea l'annuncio per un acquisto (o riattiva quello già esistente).
// stores = { listings, index, config } (store Blobs già scoped dal chiamante).
// Restituisce { listing, created } oppure { error }.
async function listPurchase(stores, purchase, opts) {
  const check = checkSellable(purchase);
  if (!check.ok) return { error: check.reason };
  const rate = await getCommissionRate(stores.config);
  const known = await stores.index.get(purchase.id, { type: "json" });
  if (known && known.listingId) {
    const existing = await stores.listings.get(known.listingId, { type: "json" });
    if (existing) {
      if (existing.status === "venduto") return { error: "Questo articolo è già stato venduto." };
      if (existing.status === "ritirato" && existing.price) {
        existing.status = "in vendita";
        existing.commissionRate = rate; // rimesso in vendita: vale la commissione di oggi
        await stores.listings.setJSON(existing.id, existing);
        return { listing: existing, created: false };
      }
      return { listing: existing, created: false };
    }
  }
  let id = newListingId();
  while (await stores.listings.get(id)) id = newListingId();
  const listing = buildListing(purchase, Object.assign({}, opts, { id, commissionRate: rate }));
  await stores.listings.setJSON(id, listing);
  await stores.index.setJSON(purchase.id, { listingId: id });
  return { listing, created: true };
}

module.exports = {
  USED_STORE,
  INDEX_STORE,
  LISTING_ID_RE,
  listPurchase,
  CONFIG_STORE,
  CONFIG_KEY,
  DEFAULT_COMMISSION_RATE,
  MAX_COMMISSION_RATE,
  CONDITIONS,
  MAX_PRICE_EUR,
  normalizeEmail,
  newListingId,
  normalizeCommissionRate,
  getCommissionRate,
  getCommissionConfig,
  computeSale,
  parsePrice,
  checkSellable,
  describePurchase,
  publicSellerName,
  buildListing,
  publicListing,
};
