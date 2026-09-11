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

const FULL_FEE = 39;
const SUBSCRIBED_FEE = 19;

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

const SHIPPING_MARGIN = 0.25;

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
  const fee = onBreakeven ? 0 : isSubscribed ? SUBSCRIBED_FEE : FULL_FEE;

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

module.exports = {
  consolidatedGroupPriceForItems,
  DESTINATIONS,
  SHIPPING_RATES,
  SHIPPING_MARGIN,
  FULL_FEE,
  SUBSCRIBED_FEE,
  volumetricWeight,
  bracketPrice,
};
