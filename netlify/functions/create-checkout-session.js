// Netlify serverless function — crea una Stripe Checkout Session (pagina di
// pagamento ospitata da Stripe) per il totale REALE del gruppo di
// spedizioni consolidato (ConcludeScreen), tramite chiamate REST dirette
// all'API di Stripe — NESSUNA libreria npm "stripe" (coerente con "zero
// dipendenze npm nuove", già rispettato in tutto il repository) e nessuno
// script client-side Stripe.js: il client fa solo un redirect verso l'URL
// restituito qui. Vedi MANUALE.md, sezione "Pagamento reale con Stripe
// Checkout".
//
// Il totale addebitato NON è mai letto da un campo mandato dal client:
// viene ricalcolato qui, da zero, a partire dagli item grezzi (peso,
// dimensioni, tier di prezzo, sconto partner) con la STESSA formula di
// consolidatedGroupPrice() in app.js — duplicata deliberatamente in
// netlify/lib/pricing.js (client e server non condividono moduli in
// questo repository). Un eventuale campo "total"/"amount" nel corpo della
// richiesta viene semplicemente ignorato: non esiste alcun percorso del
// codice che lo legga.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");
const { consolidatedGroupPriceForItems } = require("../lib/pricing");

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

// Stessa fascia di peso di isValidPurchase() (save-purchase.js, <50kg) —
// nessun oggetto del gruppo dovrebbe mai superarla, il server non deve
// fidarsi di un peso fuori range anche solo per calcolare un totale.
const VALID_PRICING_TIERS = ["pieno", "abbonato", "breakeven"];

function isValidItem(it) {
  if (!it || typeof it !== "object") return false;
  if (typeof it.addressLabel !== "string" || !it.addressLabel.trim()) return false;
  if (typeof it.destinationCountry !== "string" || !it.destinationCountry.trim()) return false;
  const weight = typeof it.weightKg === "number" ? it.weightKg : parseFloat(it.weightKg);
  if (!isFinite(weight) || weight <= 0 || weight >= 50) return false;
  if (!VALID_PRICING_TIERS.includes(it.pricingTier)) return false;
  return true;
}

// L'origine (schema+host) del sito che ha chiamato questa function — serve
// a costruire success_url/cancel_url senza mai hardcodare un dominio
// specifico (che sia produzione, spazio ospite o una deploy preview): letta
// dall'header Origin (inviato dal browser su una POST same-origin) con
// fallback al Referer, esattamente il dominio da cui il turista sta
// davvero usando l'app in questo momento.
function getOrigin(event) {
  const headers = event.headers || {};
  if (headers.origin) return headers.origin;
  const referer = headers.referer || headers.referrer;
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch (e) {
      return null;
    }
  }
  return null;
}

// Stripe si aspetta form-urlencoded, non JSON, per l'API REST — costruito
// qui a mano (nessuna libreria "stripe") con la notazione a parentesi
// quadre che l'API richiede per array/oggetti annidati (line_items[i][...]).
function buildCheckoutSessionForm({ groups, successUrl, cancelUrl }) {
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  groups.forEach((g, i) => {
    params.set(`line_items[${i}][quantity]`, "1");
    params.set(`line_items[${i}][price_data][currency]`, "eur");
    params.set(`line_items[${i}][price_data][unit_amount]`, String(g.amountCents));
    params.set(`line_items[${i}][price_data][product_data][name]`, g.name);
  });
  return params;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const { items } = JSON.parse(event.body || "{}");
    if (!Array.isArray(items) || items.length === 0 || !items.every(isValidItem)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Elenco oggetti da pagare non valido" }) };
    }

    const withinLimit = await checkRateLimit(`create-checkout-session:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const origin = getOrigin(event);
    if (!origin) {
      return { statusCode: 400, body: JSON.stringify({ error: "Origine della richiesta non determinabile" }) };
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Chiave Stripe non configurata sul server (STRIPE_SECRET_KEY mancante)." }),
      };
    }

    // Raggruppa per destinazione (addressLabel) — stessa unità di
    // consolidamento di ConcludeScreen/consolidatedGroupPrice(): un
    // "gruppo" = una spedizione consolidata verso la stessa destinazione,
    // un totale (quindi una riga nel checkout) per gruppo — esattamente
    // il riepilogo già mostrato al turista prima di questa chiamata.
    const itemsByDest = {};
    items.forEach((it) => {
      (itemsByDest[it.addressLabel] = itemsByDest[it.addressLabel] || []).push(it);
    });

    let grandTotalCents = 0;
    const groups = Object.entries(itemsByDest).map(([dest, groupItems]) => {
      const pricing = consolidatedGroupPriceForItems(groupItems);
      const amountCents = Math.round(pricing.total * 100);
      grandTotalCents += amountCents;
      return {
        dest,
        amountCents,
        name: `Spedizione consolidata verso ${dest} (${groupItems.length} oggett${groupItems.length === 1 ? "o" : "i"}, ${pricing.weightKg} kg)`,
      };
    });

    if (grandTotalCents <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Il totale calcolato non è valido" }) };
    }

    const form = buildCheckoutSessionForm({
      groups,
      successUrl: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/`,
    });

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: (data.error && data.error.message) || "Errore nella creazione della sessione di pagamento" }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: data.url, id: data.id, amountTotalCents: grandTotalCents }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Esportati solo per i test (stesso pattern già usato in assistant.js/
// daily-healthcheck.js di questo repository) — il runtime Netlify invoca
// solo exports.handler, il resto è inerte in produzione.
exports.isValidItem = isValidItem;
exports.getOrigin = getOrigin;
exports.buildCheckoutSessionForm = buildCheckoutSessionForm;
