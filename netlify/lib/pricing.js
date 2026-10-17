// Duplicazione DELIBERATA della logica di prezzo consolidato per gruppo di
// spedizione (consolidatedGroupPrice() in dist/assets/app.js) — client e
// server non condividono moduli in questo repository (vedi header di
// PARTNER_PLAN_TO_PRICING_TIER in app.js e netlify/lib/guest-mode.js).
//
// Usata SOLO da netlify/functions/create-checkout-session.js, per
// ricalcolare da zero, lato server, il totale da addebitare via Stripe a
// partire dagli item grezzi (peso/dimensioni/tier di prezzo/sconto
// partner) — MAI fidandosi di un "total" mandato dal client. Stessi
// valori (fee, tariffe, margine) di app.js: se cambiano lì, vanno
// cambiati anche qui — vedi MANUALE.md, sezione "Pagamento reale con
// Stripe Checkout".

// MODELLO DI PREZZO (17/10/2026) — identico a dist/assets/app.js:
// pavimento = costo corriere + 30%; non abbonato = pavimento +43%; abbonato =
// tariffa scontata in proporzione alla durata (annuale = pavimento).
const SUBSCRIPTION_PLANS = [
  { id: "trimestrale", label: "Trimestrale", months: 3, price: 29 },
  { id: "semestrale", label: "Semestrale", months: 6, price: 49 },
  { id: "annuale", label: "Annuale", months: 12, price: 79 },
];
const SUBSCRIBED_FEE = 0;
// Sconto massimo sulla tariffa PIENA (non abbonato), concesso all'abbonamento
// più lungo; gli altri hanno uno sconto proporzionale alla durata:
//   sconto = SUBSCRIPTION_MAX_DISCOUNT × mesi / 12   (trim. 7,5% · sem. 15% · ann. 30%)
// La tariffa dell'abbonamento annuale è esattamente il PAVIMENTO
// (costo corriere + SHIPPING_MARGIN 30%): nessuna tariffa scende mai sotto.
// La tariffa piena = pavimento / (1 − sconto massimo) = pavimento + 43%.
const SUBSCRIPTION_MAX_DISCOUNT = 0.3;
const DEFAULT_RATE_PLAN = "trimestrale";

function subscriptionPlanById(id) {
  return SUBSCRIPTION_PLANS.find((p) => p.id === id) || null;
}
const _cents = (n) => Math.round(n * 100) / 100;
function planDiscountFraction(planId) {
  const p = subscriptionPlanById(planId) || subscriptionPlanById(DEFAULT_RATE_PLAN);
  return (SUBSCRIPTION_MAX_DISCOUNT * p.months) / 12;
}
// `floor` = tariffa di base (costo corriere + 30%, il pavimento). Restituisce
// quanto si aggiunge al pavimento per chi NON è abbonato.
function nonSubscriberSurcharge(floor) {
  const f = Math.max(0.01, Number(floor) || 0);
  const k = SUBSCRIPTION_MAX_DISCOUNT / (1 - SUBSCRIPTION_MAX_DISCOUNT);
  return { pct: Math.round(k * 100), amount: _cents(f * k) };
}
// Quanto si aggiunge al pavimento per un abbonato con quel piano
// (0 per l'annuale: paga esattamente il pavimento).
function subscriberExtra(floor, planId) {
  const f = Math.max(0.01, Number(floor) || 0);
  const ratio = (1 - planDiscountFraction(planId)) / (1 - SUBSCRIPTION_MAX_DISCOUNT);
  return { pct: Math.round((ratio - 1) * 1000) / 10, amount: _cents(f * (ratio - 1)) };
}
// Piano che determina la tariffa di un gruppo di oggetti.
function ratePlanForItems(items) {
  for (const it of items) {
    if (it.pricingTier === "abbonato" && subscriptionPlanById(it.subscriptionPlanId)) return it.subscriptionPlanId;
  }
  for (const it of items) {
    if (subscriptionPlanById(it.subscriptionPurchase)) return it.subscriptionPurchase;
  }
  return DEFAULT_RATE_PLAN;
}

const DESTINATIONS = [
  { name: "Italia", zone: "domestico" },
  { name: "Unione Europea", zone: "transfrontaliero" },
  { name: "Regno Unito", zone: "transfrontaliero" },
  { name: "Svizzera", zone: "transfrontaliero" },
  { name: "Stati Uniti", zone: "worldwide" },
  { name: "Emirati Arabi Uniti", zone: "worldwide" },
  { name: "Cina", zone: "worldwide" },
  { name: "Giappone", zone: "worldwide" },
  { name: "Altro / non specificata", zone: "worldwide" },
];

const SHIPPING_RATES = {
  domestico: { brackets: [[1, 9], [2, 11], [5, 14], [10, 18], [20, 25], [30, 33]], perKgOver: 1.1 },
  transfrontaliero: { brackets: [[1, 15], [2, 20], [5, 26], [10, 34], [20, 44], [30, 55]], perKgOver: 2.2 },
  worldwide: { brackets: [[1, 50], [2, 58], [5, 75], [10, 95], [20, 130], [30, 165]], perKgOver: 5.5 },
};

const SHIPPING_MARGIN = 0.3;

function volumetricWeight(dims) {
  if (!dims) return 0;
  const l = parseFloat(dims.length_cm) || 0;
  const w = parseFloat(dims.width_cm) || 0;
  const h = parseFloat(dims.height_cm) || 0;
  if (!l || !w || !h) return 0;
  return (l * w * h) / 5000;
}

function bracketPrice(zone, weightKg) {
  for (const [maxKg, price] of zone.brackets) {
    if (weightKg <= maxKg) return price;
  }
  const [lastMaxKg, lastPrice] = zone.brackets[zone.brackets.length - 1];
  return lastPrice + (weightKg - lastMaxKg) * zone.perKgOver;
}

// Stesso identico algoritmo di consolidatedGroupPrice() in app.js, con UNA
// differenza obbligata: lì il paese di destinazione del gruppo viene
// risolto da state.addresses (rubrica indirizzi del turista, dato
// client-only — il server non ha alcuno store equivalente); qui ogni item
// porta già il proprio destinationCountry (stringa), già risolto lato
// client. Non è un dato meno affidabile di peso/dimensioni: determina solo
// la ZONA tariffaria (una tabella pubblica, non un segreto), e in questo
// repository peso/dimensioni sono sempre stati determinati lato client
// (la classificazione AI gira nel browser del turista) — lo stesso livello
// di fiducia già accettato ovunque, non un allentamento introdotto qui.
function consolidatedGroupPriceForItems(items) {
  const destinationName = items[0].destinationCountry;
  const dest = DESTINATIONS.find((d) => d.name === destinationName) || DESTINATIONS[DESTINATIONS.length - 1];
  const zone = SHIPPING_RATES[dest.zone];

  const combinedRealWeight = items.reduce((sum, it) => sum + Math.max(0.3, parseFloat(it.weightKg) || 1), 0);
  const combinedVolumetricWeight = items.reduce((sum, it) => sum + volumetricWeight(it.dims), 0);
  const billableWeight = Math.max(combinedRealWeight, combinedVolumetricWeight);
  const rawCost = bracketPrice(zone, billableWeight);
  const shipping = parseFloat((rawCost * (1 + SHIPPING_MARGIN)).toFixed(2));

  const onBreakeven = items.some((it) => it.pricingTier === "breakeven");
  const isSubscribed = items.some((it) => it.pricingTier === "abbonato");
  const fee = onBreakeven ? 0 : isSubscribed ? subscriberExtra(shipping, ratePlanForItems(items)).amount : nonSubscriberSurcharge(shipping).amount;

  const totalPartnerDiscount = items.reduce((sum, it) => sum + (parseFloat(it.partnerDiscountAmount) || 0), 0);
  const total = Math.max(0, Math.round((shipping + fee - totalPartnerDiscount) * 100) / 100);

  return {
    destinationCountry: destinationName,
    weightKg: parseFloat(billableWeight.toFixed(2)),
    shipping,
    fee,
    total,
  };
}

// Abbonamento una tantum portato da uno degli oggetti: si addebita UNA volta.
function subscriptionForItems(items) {
  for (const it of items) {
    const plan = subscriptionPlanById(it.subscriptionPurchase);
    if (plan) return plan;
  }
  return null;
}

module.exports = {
  consolidatedGroupPriceForItems,
  subscriptionForItems,
  subscriptionPlanById,
  nonSubscriberSurcharge,
  subscriberExtra,
  ratePlanForItems,
  planDiscountFraction,
  SUBSCRIPTION_MAX_DISCOUNT,
  DEFAULT_RATE_PLAN,
  SUBSCRIPTION_PLANS,
  DESTINATIONS,
  SHIPPING_RATES,
  SHIPPING_MARGIN,
  SUBSCRIBED_FEE,
  volumetricWeight,
  bracketPrice,
};
