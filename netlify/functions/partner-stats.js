// Netlify serverless function — verifica un codice partner e restituisce
// vendite e commissioni REALI, aggregate lato server dallo store
// "purchases" (popolato da save-purchase.js su tutti i dispositivi) —
// non lo storico locale del singolo telefono.
//
// Il codice stesso funge da credenziale, come i codici invito in promo.js:
// nessuna password separata. Un codice inesistente o qualunque altro
// errore rispondono entrambi con { valid: false }, per non rivelare quali
// codici partner esistono.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti
const COMMISSION_RATE = 0.1;

// TOU-19: scadenza piano gratuito a 12 mesi dalla registrazione — dopo,
// il partner deve passare a un piano a pagamento per continuare ad
// accedere alla propria area (non solo per vendere). Per i piani a
// pagamento non esiste nel prodotto una fatturazione ricorrente reale
// (il canone è confermato manualmente dallo staff nel CRM, campo
// `paid`): trattiamo quindi come "scaduto" un piano a pagamento non
// confermato pagato oltre un periodo di grazia ragionevole per lasciare
// il tempo allo staff di confermare — non è nella specifica originale,
// è una scelta per evitare di bloccare un abbonamento appena attivato
// prima ancora che lo staff possa confermarlo.
const FREE_PLAN_DAYS = 365;
const PAID_PLAN_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function computeAccessStatus(partner, now) {
  const startedAt = partner.planStartedAt ? new Date(partner.planStartedAt).getTime() : now;
  const daysSinceStart = (now - startedAt) / DAY_MS;
  const isFree = !partner.plan || partner.plan === "free";
  if (isFree) {
    if (daysSinceStart > FREE_PLAN_DAYS) {
      return { blocked: true, reason: "free-expired" };
    }
    return { blocked: false, daysRemaining: Math.max(0, Math.ceil(FREE_PLAN_DAYS - daysSinceStart)) };
  }
  if (partner.paid !== true && daysSinceStart > PAID_PLAN_GRACE_DAYS) {
    return { blocked: true, reason: "paid-unpaid" };
  }
  return { blocked: false };
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const withinLimit = await checkRateLimit(`partner-stats:${getClientIp(event)}`);
    if (!withinLimit) {
      return { statusCode: 429, body: JSON.stringify({ error: "Troppe richieste, riprova tra qualche minuto." }) };
    }

    const { code } = JSON.parse(event.body || "{}");
    const normalized = (code || "").trim().toUpperCase();
    if (!normalized) {
      return { statusCode: 200, body: JSON.stringify({ valid: false }) };
    }

    const partners = getStore({
      name: guestScopedStoreName("partners"),
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const record = await partners.get(normalized, { type: "json" });
    if (!record) {
      return { statusCode: 200, body: JSON.stringify({ valid: false }) };
    }

    // Backfill: partner registrati prima di TOU-19 non hanno planStartedAt.
    // Anziché considerarli scaduti da subito (non sappiamo la vera data di
    // registrazione), diamo a ognuno una finestra piena a partire da ORA,
    // la prima volta che le sue statistiche vengono lette.
    if (!record.planStartedAt) {
      record.planStartedAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();
      await partners.setJSON(normalized, record);
    }
    const access = computeAccessStatus(record, Date.now());

    const purchases = getStore({
      name: guestScopedStoreName("purchases"),
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const { blobs } = await purchases.list();
    const items = (await Promise.all(blobs.map((b) => purchases.get(b.key, { type: "json" })))).filter(Boolean);
    const myItems = items.filter((it) => it.partnerCode === normalized);
    const salesCount = myItems.length;
    const rawSalesValue = myItems.reduce((sum, it) => sum + (it.price || 0), 0);
    const totalSalesValue = Math.round(rawSalesValue * 100) / 100;
    const totalCommission = Math.round(rawSalesValue * COMMISSION_RATE * 100) / 100;

    // Andamento nel tempo (TOU-17): a differenza di totalCommission sopra
    // (stima al 10% su TUTTE le vendite, indipendentemente dallo stato),
    // qui uso creditIssuedAmount — la commissione REALMENTE accreditata da
    // save-purchase.js al passaggio a "ritirato", coerente con quanto
    // effettivamente disponibile come credito. Un ordine "in sospeso" da
    // ieri conta quindi in salesCount/totalSalesValue ma non ancora nel
    // suo mese per la commissione, finché non viene ritirato.
    const monthKey = (dateStr) => {
      const d = new Date(dateStr);
      return isNaN(d) ? null : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    const monthLabel = (key) => {
      const [y, m] = key.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("it-IT", { month: "long", year: "numeric", timeZone: "UTC" });
    };
    const byMonth = {};
    myItems.forEach((it) => {
      const key = monthKey(it.date);
      if (!key) return;
      if (!byMonth[key]) byMonth[key] = { orders: 0, serviceValue: 0, commission: 0 };
      byMonth[key].orders += 1;
      byMonth[key].serviceValue += it.price || 0;
      byMonth[key].commission += it.creditIssuedAmount || 0;
    });
    const monthlyBreakdown = Object.keys(byMonth)
      .sort()
      .reverse()
      .slice(0, 12)
      .map((key) => ({
        month: key,
        label: monthLabel(key),
        orders: byMonth[key].orders,
        serviceValue: Math.round(byMonth[key].serviceValue * 100) / 100,
        commission: Math.round(byMonth[key].commission * 100) / 100,
      }));

    const recentOrders = myItems
      .slice()
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 20)
      .map((it) => ({
        id: it.id,
        date: it.date,
        objectName: it.objectName || null,
        price: Math.round((it.price || 0) * 100) / 100,
        commission: Math.round((it.creditIssuedAmount || 0) * 100) / 100,
        status: it.status || null,
      }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        valid: true,
        partnerName: record.name || "",
        plan: record.plan || "free",
        paid: record.paid === true,
        planStartedAt: record.planStartedAt,
        access,
        salesCount,
        totalSalesValue,
        totalCommission,
        creditBalance: Math.round((record.creditBalance || 0) * 100) / 100,
        monthlyBreakdown,
        recentOrders,
      }),
    };
  } catch (err) {
    // Stesso formato di un codice inesistente: non distinguere un errore
    // interno da un codice sbagliato lato client.
    return { statusCode: 200, body: JSON.stringify({ valid: false }) };
  }
};
