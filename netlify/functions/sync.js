// Netlify serverless function — endpoint pubblico usato dall'app turista/
// partner (dist/assets/app.js) e dal sito marketing (dist/site/index.html,
// registrazione partner self-service) per le azioni che non richiedono
// l'accesso al CRM interno: sincronizzare lo storico acquisti, confermare
// la lettura del banner "punto di ritiro aggiornato", riscattare il
// credito partner sul canone, generare codici sconto partner e registrare
// un nuovo partner. Stessa identica logica che viveva in
// netlify/functions/crm.js (repository interno, privato) — estratta qui
// perché queste sono le uniche azioni che l'app/sito pubblico usano da
// quella function. Tutto il resto di crm.js (elenco completo, gestione
// partner/documenti/legale/blocklist) vive solo nel repository interno,
// non raggiungibile da questo deploy pubblico.

const { getStore } = require("@netlify/blobs");

function generateDiscountCode(partnerCode) {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SCONTO-${partnerCode}-${rand}`;
}

// Piani partner e canone mensile — stessi nomi/prezzi mostrati in
// dist/site/index.html (sezione #partner), usati da "register-partner" qui
// sotto per la registrazione self-service.
const PARTNER_PLANS = {
  boutique: { label: "Boutique", monthlyFee: 49 },
  enoteche: { label: "Enoteche & Cantine", monthlyFee: 59 },
  sport: { label: "Sport & Attrezzatura", monthlyFee: 69 },
  hotel: { label: "Hotel", monthlyFee: 99 },
  agenzie: { label: "Agenzie di Viaggio", monthlyFee: 149 },
  touroperator: { label: "Tour Operator", monthlyFee: 199 },
  free: { label: "Gratuito (nessuna commissione)", monthlyFee: 0 },
};

function generatePartnerCode(name) {
  const initials =
    (name || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 3) || "PT";
  const rand = Math.floor(100 + Math.random() * 900);
  return `${initials}${rand}`;
}

// Crea e registra una nuova fattura per il canone mensile del partner —
// usata da "redeem-credit-for-invoice" per applicarci subito il credito
// disponibile.
async function issuePartnerInvoice(partners, code, partner) {
  const invoice = {
    id: `PF-P-${code}-${Date.now()}`,
    date: new Date().toISOString(),
    amount: partner.monthlyFee || 0,
    period: new Date().toISOString().slice(0, 7),
  };
  partner.invoices = partner.invoices || [];
  partner.invoices.push(invoice);
  partner.updatedAt = new Date().toISOString();
  await partners.setJSON(code, partner);
  return invoice;
}

// Rate limiting per "get-purchases-by-email" — stesso schema (20
// richieste/60 minuti per IP, store Blobs "rate-limits") delle altre
// function esposte al pubblico (classify.js, kit-vault.js, partner-stats.js,
// partner-discount.js, save-purchase.js, assistant.js). Questa accetta
// un'email libera e fa una scansione completa dello store — senza limite
// permetterebbe di enumerare gli acquisti di indirizzi email arbitrari.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minuti

function getClientIp(event) {
  return event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown-ip";
}

async function checkRateLimit(key) {
  const store = getStore({ name: "rate-limits" });
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
    const body = JSON.parse(event.body || "{}");
    const { action } = body;

    const purchases = getStore({ name: "purchases" });
    const partners = getStore({ name: "partners" });
    const discountCodes = getStore({ name: "partner-discount-codes" });

    // Usata dall'app turista per allineare localmente lo stato degli
    // acquisti già noti (status, pickupPoint, ecc.) con quanto aggiornato
    // nel frattempo dallo staff nel CRM — es. dopo un invio a
    // confezionamento o un cambio punto di ritiro fatto da un altro
    // dispositivo. Richiede esplicitamente gli id: non espone mai l'intera
    // lista acquisti di altri clienti.
    if (action === "get-purchases") {
      const { ids } = body;
      if (!Array.isArray(ids) || !ids.length) return ok({ items: [] });
      const uniqueIds = Array.from(new Set(ids.filter((id) => typeof id === "string" && id))).slice(0, 200);
      const items = (await Promise.all(uniqueIds.map((id) => purchases.get(id, { type: "json" })))).filter(Boolean);
      return ok({ items });
    }

    // A differenza di "get-purchases" sopra (che sincronizza solo gli id
    // già noti al dispositivo), questa action scopre acquisti esistenti
    // nel database ma mai salvati su QUESTO dispositivo — es. dopo cambio
    // telefono, pulizia dati del browser, o un acquisto creato/associato
    // da un altro dispositivo con la stessa email. Scansiona l'intero
    // store per email, quindi protetta da rate limit (vedi sopra).
    if (action === "get-purchases-by-email") {
      const withinLimit = await checkRateLimit(`get-purchases-by-email:${getClientIp(event)}`);
      if (!withinLimit) return bad("Troppe richieste, riprova tra qualche minuto.", 429);
      const email = (body.email || "").trim().toLowerCase();
      if (!email) return ok({ items: [] });
      const { blobs } = await purchases.list();
      const items = (await Promise.all(blobs.map((b) => purchases.get(b.key, { type: "json" })))).filter(
        (it) => it && typeof it.touristEmail === "string" && it.touristEmail.trim().toLowerCase() === email
      );
      return ok({ items });
    }

    // Il turista ha visto il banner "punto di ritiro aggiornato" in app —
    // azzera il flag così non resta visibile per sempre.
    if (action === "ack-pickup-point") {
      const { id } = body;
      if (!id) return bad("Missing id");
      const item = await purchases.get(id, { type: "json" });
      if (!item) return bad("Acquisto non trovato", 404);
      item.pickupPointChanged = false;
      await purchases.setJSON(id, item);
      return ok({ item });
    }

    // Applica il creditBalance disponibile (fino a coprirlo per intero)
    // alla prossima fattura del canone, generata qui su richiesta del
    // partner stesso (riusa issuePartnerInvoice). L'eventuale credito
    // residuo resta sul saldo per la fattura successiva.
    if (action === "redeem-credit-for-invoice") {
      const { code } = body;
      if (!code) return bad("Missing partner code");
      const partner = await partners.get(code, { type: "json" });
      if (!partner) return bad("Partner non trovato", 404);
      const invoice = await issuePartnerInvoice(partners, code, partner);
      const available = Math.round((partner.creditBalance || 0) * 100) / 100;
      const toApply = Math.max(0, Math.min(available, invoice.amount));
      if (toApply > 0) {
        invoice.creditApplied = toApply;
        invoice.amount = Math.round((invoice.amount - toApply) * 100) / 100;
        partner.creditBalance = Math.round((available - toApply) * 100) / 100;
        partner.updatedAt = new Date().toISOString();
        await partners.setJSON(code, partner);
      }
      return ok({ invoice, partner });
    }

    // Genera un codice sconto monouso che il partner può comunicare a un
    // cliente — non tocca ancora il creditBalance: il costo (10% della fee
    // effettivamente scontata) si scala solo quando il codice viene usato
    // davvero al checkout (vedi netlify/functions/partner-discount.js).
    if (action === "generate-partner-discount-code") {
      const { code } = body;
      if (!code) return bad("Missing partner code");
      const partner = await partners.get(code, { type: "json" });
      if (!partner) return bad("Partner non trovato", 404);
      let discountCode = generateDiscountCode(code);
      let attempts = 0;
      while (await discountCodes.get(discountCode, { type: "json" })) {
        attempts += 1;
        discountCode = attempts < 10 ? generateDiscountCode(code) : `${discountCode}${Date.now()}`;
      }
      const record = {
        code: discountCode,
        partnerCode: code,
        createdAt: new Date().toISOString(),
        usedAt: null,
        usedByEmail: null,
      };
      await discountCodes.setJSON(discountCode, record);
      return ok({ discountCode, record });
    }

    // Registrazione self-service dal sito (sezione #partner): genera un
    // codice partner univoco, salva il piano scelto e crea subito la prima
    // fattura del canone (riusa issuePartnerInvoice).
    if (action === "register-partner") {
      const { name, email, plan } = body;
      if (!name || !name.trim()) return bad("Missing partner name");
      const planKey = PARTNER_PLANS[plan] ? plan : "free";
      const planInfo = PARTNER_PLANS[planKey];

      let code = generatePartnerCode(name);
      let attempts = 0;
      while (await partners.get(code, { type: "json" })) {
        attempts += 1;
        code = attempts < 10 ? generatePartnerCode(name) : `${code}${Date.now()}`;
      }

      const partner = {
        code,
        name: name.trim(),
        email: (email || "").trim(),
        notes: "",
        paid: false,
        plan: planKey,
        monthlyFee: planInfo.monthlyFee,
        invoices: [],
        creditBalance: 0,
        // TOU-19: data di inizio del piano corrente, base per la scadenza
        // a 12 mesi del piano gratuito (vedi computeAccessStatus in
        // partner-stats.js). Aggiornata anche da "upgrade-partner-plan".
        planStartedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await partners.setJSON(code, partner);
      const invoice = await issuePartnerInvoice(partners, code, partner);
      return ok({ code, planLabel: planInfo.label, partner, invoice });
    }

    // TOU-19: passaggio da un piano all'altro (in pratica, dal gratuito a
    // uno a pagamento — non ha senso self-service il percorso inverso,
    // quindi qui si accettano solo piani PARTNER_PLANS diversi da "free").
    // Come alla registrazione, il pagamento reale resta fuori da questo
    // prototipo: paid torna a false, lo stesso staff del CRM che conferma
    // i pagamenti oggi dovrà confermare anche questo, prima che l'accesso
    // si sblocchi davvero (vedi computeAccessStatus in partner-stats.js).
    if (action === "upgrade-partner-plan") {
      const { code, plan } = body;
      if (!code) return bad("Missing partner code");
      if (!PARTNER_PLANS[plan] || plan === "free") return bad("Piano non valido");
      const partner = await partners.get(code, { type: "json" });
      if (!partner) return bad("Partner non trovato", 404);
      const planInfo = PARTNER_PLANS[plan];
      partner.plan = plan;
      partner.monthlyFee = planInfo.monthlyFee;
      partner.paid = false;
      partner.planStartedAt = new Date().toISOString();
      partner.updatedAt = new Date().toISOString();
      await partners.setJSON(code, partner);
      const invoice = await issuePartnerInvoice(partners, code, partner);
      return ok({ code, planLabel: planInfo.label, partner, invoice });
    }

    return bad("Unknown action");
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function ok(data) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}
function bad(message, code) {
  return { statusCode: code || 400, body: JSON.stringify({ error: message }) };
}
