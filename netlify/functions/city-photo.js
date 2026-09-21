// Netlify serverless function — foto reale rappresentativa della città di
// un punto di ritiro, per CoverScreen() in dist/assets/app.js (vedi
// MANUALE.md, sezione "Foto reale del punto di ritiro"). Prima di questa
// modifica cityPhoto() in app.js chiamava Wikipedia DIRETTAMENTE dal
// client ad ogni loadLocation() — investigato leggendo il codice reale
// prima di scrivere questo file. Qui la stessa chiamata si sposta lato
// server, con caching persistente su Netlify Blobs, così l'API pubblica
// non viene mai interrogata più di una volta per la stessa città (stesso
// principio di checkRateLimit() già in uso in tutto questo repository).
//
// Fonte immagine: endpoint REST "page/summary" di Wikipedia
// (en.wikipedia.org) — la stessa identica chiamata che c'era già lato
// client, che nella grande maggioranza dei casi espone come immagine
// principale una foto ospitata su Wikimedia Commons. L'attribuzione/
// licenza di QUELLA foto specifica non viene assunta: viene verificata
// davvero interrogando l'API di Wikimedia Commons (action=query,
// prop=imageinfo, iiprop=extmetadata) sul file risolto dall'URL
// dell'immagine, e un credito viene mostrato SOLO se la licenza reale
// trovata lo richiede (mai per pubblico dominio/CC0).
//
//   POST { city } -> { photoUrl: string|null, credit: {text,url}|null }
//
// Fallback onesto in ogni scenario (città sconosciuta, nessuna immagine,
// timeout, errore di rete verso Wikipedia/Commons): sempre 200 con
// photoUrl:null, mai un 500 per un problema esterno — il chiamante
// (CoverScreen) ricade sul placeholder a gradiente esistente, mai
// un'immagine rotta. Un fallimento nel solo recupero dell'attribuzione
// (Commons irraggiungibile) non deve mai far perdere la foto stessa:
// vedi fetchAttribution(), che non propaga mai un errore verso l'alto.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti
const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 giorni — la foto/licenza di una città non cambia quasi mai, ma non è cache "per sempre"

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}

function blobsAuth() {
  return { siteID: process.env.NETLIFY_BLOBS_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN };
}

async function checkRateLimit(key) {
  const store = getStore({ name: guestScopedStoreName("rate-limits"), ...blobsAuth() });
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

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Estrae il titolo "File:" di Commons dall'URL immagine restituito da
// page/summary — funziona sia per un URL di thumbnail
// (.../commons/thumb/a/ab/Nome_file.jpg/500px-Nome_file.jpg, dove il nome
// file reale è il penultimo segmento, non l'ultimo) sia per un URL
// diretto (.../commons/a/ab/Nome_file.jpg, ultimo segmento).
function extractCommonsFileTitle(imageUrl) {
  try {
    const pathname = new URL(imageUrl).pathname;
    const parts = pathname.split("/").filter(Boolean);
    const thumbIdx = parts.indexOf("thumb");
    const filename = thumbIdx !== -1 ? parts[thumbIdx + 3] : parts[parts.length - 1];
    return filename ? decodeURIComponent(filename) : null;
  } catch (e) {
    return null;
  }
}

function stripHtml(html) {
  return (html || "").replace(/<[^>]*>/g, "").trim();
}

// SOLO pubblico dominio/CC0 sono esplicitamente esentati dal credito —
// qualunque altra licenza reale restituita da Commons (CC BY, CC BY-SA,
// GFDL, ecc.) lo richiede. Deliberatamente il contrario di una whitelist:
// una licenza sconosciuta/nuova finisce nel ramo "richiede credito", mai
// in quello "nessun credito dovuto".
function licenseRequiresCredit(licenseShortName) {
  if (!licenseShortName) return false;
  const normalized = licenseShortName.toLowerCase();
  return !(normalized.includes("public domain") || normalized.includes("cc0") || normalized === "pd");
}

// Best-effort: qualunque fallimento qui (Commons irraggiungibile, file non
// risolto, metadati assenti) restituisce null — non deve MAI far perdere
// la foto già trovata da fetchCityPhoto().
async function fetchAttribution(imageUrl) {
  const fileTitle = extractCommonsFileTitle(imageUrl);
  if (!fileTitle) return null;
  try {
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(
      "File:" + fileTitle
    )}&prop=imageinfo&iiprop=extmetadata&format=json&origin=*`;
    const res = await fetchWithTimeout(apiUrl);
    if (!res.ok) return null;
    const data = await res.json();
    const pages = data.query && data.query.pages;
    const page = pages && Object.values(pages)[0];
    const meta = page && page.imageinfo && page.imageinfo[0] && page.imageinfo[0].extmetadata;
    if (!meta) return null;
    const licenseShortName = meta.LicenseShortName && meta.LicenseShortName.value;
    if (!licenseRequiresCredit(licenseShortName)) return null;
    const artist = stripHtml(meta.Artist && meta.Artist.value) || null;
    const text = artist ? `${artist} — ${licenseShortName}` : licenseShortName;
    return { text, url: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileTitle)}` };
  } catch (e) {
    return null;
  }
}

// Può lanciare (timeout/rete verso Wikipedia): il chiamante decide cosa
// fare di un fallimento qui (vedi handler — non viene messo in cache,
// per poter ritentare in futuro). Una città semplicemente senza foto
// (risposta 200 ma senza campo immagine) NON lancia: è un esito valido
// e stabile, va in cache come tale.
async function fetchCityPhoto(city) {
  const res = await fetchWithTimeout(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(city)}`);
  if (!res.ok) return { photoUrl: null, credit: null };
  const data = await res.json();
  const photoUrl = (data.originalimage && data.originalimage.source) || (data.thumbnail && data.thumbnail.source) || null;
  if (!photoUrl) return { photoUrl: null, credit: null };
  const credit = await fetchAttribution(photoUrl);
  return { photoUrl, credit };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: { message: "Method not allowed" } }) };
  }
  try {
    const { city } = JSON.parse(event.body || "{}");
    const normalizedCity = (city || "").trim();
    if (!normalizedCity) {
      return { statusCode: 400, body: JSON.stringify({ error: { message: "Città mancante." } }) };
    }

    const withinLimit = await checkRateLimit(`city-photo:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: { message: "Troppe richieste, riprova tra qualche minuto." } }) };
    }

    const cacheKey = normalizedCity.toLowerCase();
    const cacheStore = getStore({ name: guestScopedStoreName("city-photo-cache"), ...blobsAuth() });
    const cached = await cacheStore.get(cacheKey, { type: "json" });
    if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
      return ok({ photoUrl: cached.photoUrl, credit: cached.credit });
    }

    let result;
    try {
      result = await fetchCityPhoto(normalizedCity);
    } catch (e) {
      // Fallimento di rete/timeout verso Wikipedia: fallback onesto, MAI
      // messo in cache (potrebbe essere transitorio — si ritenta alla
      // prossima richiesta per questa città).
      return ok({ photoUrl: null, credit: null });
    }

    await cacheStore.setJSON(cacheKey, { photoUrl: result.photoUrl, credit: result.credit, cachedAt: new Date().toISOString() });
    return ok(result);
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: { message: err.message } }) };
  }
};

function ok(data) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

// Esportati solo per i test (stesso pattern già usato in assistant.js/
// estimate-duty.js di questo repository) — il runtime Netlify invoca solo
// exports.handler, il resto è inerte in produzione.
exports.extractCommonsFileTitle = extractCommonsFileTitle;
exports.licenseRequiresCredit = licenseRequiresCredit;
exports.fetchAttribution = fetchAttribution;
exports.fetchCityPhoto = fetchCityPhoto;
