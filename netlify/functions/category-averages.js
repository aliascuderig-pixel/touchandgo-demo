// Netlify serverless function — restituisce, per ciascuna delle 10
// categorie (vedi ../lib/category-stats), il peso/dimensioni medi calcolati
// sugli acquisti reali esistenti nello store "purchases". Vedi MANUALE.md,
// sezione "Percorso offline — classificazione provvisoria": questa è
// l'UNICA fonte usata per calcolare il prezzo provvisorio quando la
// classificazione AI reale non è raggiungibile (offline prolungato) — mai
// interrogata al momento del bisogno, solo mentre l'app è online (vedi
// refreshCategoryAverages() in dist/assets/app.js), e salvata in
// localStorage per un uso puramente locale/offline successivo.
//
// GET, non POST: nessun payload da inviare, la risposta è identica per
// tutti i chiamanti nello stesso istante (nessun dato specifico
// dell'utente) — a differenza di save-purchase.js/save-shipment-group.js,
// che scrivono, qui non c'è alcun motivo per richiedere un body.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");
const { CATEGORIES, CATEGORY_DEFAULTS, categoryAverage } = require("../lib/category-stats");

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

// Media di length_cm/width_cm/height_cm per la categoria (stessa soglia di
// campione minimo di categoryAverage(), applicata indipendentemente per
// ciascuna delle tre dimensioni — un acquisto con peso valorizzato ma dims
// mancante conta comunque per il peso, e viceversa).
function averageDims(categoryItems) {
  return {
    length_cm: categoryAverage(categoryItems, (it) => it.dims && it.dims.length_cm),
    width_cm: categoryAverage(categoryItems, (it) => it.dims && it.dims.width_cm),
    height_cm: categoryAverage(categoryItems, (it) => it.dims && it.dims.height_cm),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const withinLimit = await checkRateLimit(`category-averages:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const blobsAuth = {
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    };
    const purchases = getStore({ name: guestScopedStoreName("purchases"), ...blobsAuth });
    const { blobs } = await purchases.list();
    const allItems = (await Promise.all(blobs.map((b) => purchases.get(b.key, { type: "json" })))).filter(Boolean);

    const categories = {};
    for (const category of CATEGORIES) {
      const categoryItems = allItems.filter((it) => it.category === category);
      const weightAvg = categoryAverage(categoryItems, (it) => it.weightKg);
      const dimsAvg = averageDims(categoryItems);
      const fallback = CATEGORY_DEFAULTS[category];
      // Peso e ciascuna dimensione sono decisi indipendentemente: se il
      // campione basta per il peso ma non (ancora) per, es., l'altezza
      // (dati storici parziali), quella singola dimensione usa comunque il
      // proprio default — non tutta la categoria.
      categories[category] = {
        weightKg: weightAvg !== null ? Math.round(weightAvg * 100) / 100 : fallback.weightKg,
        dims: {
          length_cm: dimsAvg.length_cm !== null ? Math.round(dimsAvg.length_cm * 10) / 10 : fallback.dims.length_cm,
          width_cm: dimsAvg.width_cm !== null ? Math.round(dimsAvg.width_cm * 10) / 10 : fallback.dims.width_cm,
          height_cm: dimsAvg.height_cm !== null ? Math.round(dimsAvg.height_cm * 10) / 10 : fallback.dims.height_cm,
        },
        sampleSize: categoryItems.length,
        usedFallback: weightAvg === null,
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categories, computedAt: new Date().toISOString() }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
